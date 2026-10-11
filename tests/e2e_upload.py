"""Upload pass: form-data with a real file part, the in-row picker affordances,
the binary body, and the file_meta IPC the size labels depend on.

    python tests/e2e_upload.py [cdp-port]
"""

import json
import os
import sys
import tempfile
import time
import urllib.request

import websocket

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9223
BASE = "http://127.0.0.1:8899"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
results = []

PAYLOAD_NAME = "relay-upload-test.bin"
PAYLOAD = os.path.join(tempfile.gettempdir(), PAYLOAD_NAME)
with open(PAYLOAD, "wb") as handle:
    handle.write(b"relay-upload-marker-" + b"x" * 2028)  # exactly 2048 B -> "2.0 KB"
SIZE_LABEL = "2.0 KB"
MISSING = "D:\\relay\\definitely-not-here.bin"

pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5))
target = [p["webSocketDebuggerUrl"] for p in pages if p.get("type") == "page"][0]
sock = websocket.create_connection(target, timeout=90)
counter = [0]


def js(expression, timeout=90):
    counter[0] += 1
    marker = counter[0]
    sock.send(json.dumps({"id": marker, "method": "Runtime.evaluate",
                          "params": {"expression": expression, "returnByValue": True, "awaitPromise": True}}))
    deadline = time.time() + timeout
    while time.time() < deadline:
        payload = json.loads(sock.recv())
        if payload.get("id") == marker:
            result = payload.get("result", {})
            if "exceptionDetails" in result:
                detail = result["exceptionDetails"]
                return json.dumps({"jsError": detail.get("exception", {}).get("description", detail.get("text"))})
            value = result.get("result", {}).get("value")
            return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return json.dumps({"jsError": "timeout"})


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' — ' + str(detail)[:260]) if detail else ''}", flush=True)


def guard(out):
    """a suite that reports '' instead of its own crash is useless"""
    if isinstance(out, dict) and out.get("jsError"):
        print(f"    !! js 崩了：{out['jsError']}", flush=True)
    return out


def run(template, **tokens):
    script = template.replace("%%PATH%%", PAYLOAD.replace("\\", "\\\\")
                              ).replace("%%MISSING%%", MISSING.replace("\\", "\\\\")
                                         ).replace("%%BASE%%", BASE)
    for key, value in tokens.items():
        script = script.replace("%%" + key + "%%", value)
    return guard(json.loads(js("(async () => { " + script + " })()")))


NEW_TAB = """
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const type=(i,v)=>{i.value=v;i.dispatchEvent(new Event('input',{bubbles:true}));};
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(240);
  [...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('HTTP')).click(); await sleep(320);
  const url=document.querySelector('.url-input'); type(url,'%%BASE%%/echo'); await sleep(140);
  document.querySelector('.method-pick').click(); await sleep(170);
  [...document.querySelectorAll('.menu-item')].find(x=>x.textContent.trim()==='POST').click(); await sleep(170);
  [...document.querySelectorAll('.subtab')].find(b=>b.textContent.trim().startsWith('Body')).click(); await sleep(240);
"""


# A selectField is a button plus an app-drawn list, so choosing means two clicks.
# Rows are matched by data-value, never by visible wording.
PICK = """
  const pick=async(sel,val,root)=>{const f=(root||document).querySelector(sel);if(!f)return 'missing:'+sel;
    f.click(); await sleep(220);
    const row=[...document.querySelectorAll('.menu .menu-item')].find((r)=>r.getAttribute('data-value')===val);
    if(!row)return 'nooption:'+val;
    row.click(); await sleep(360); return f.dataset.value;};
"""


def pick_mode(mode):
    return PICK + """
  const labels={form:'表单',urlencoded:'URL 编码',file:'二进制',raw:'JSON',none:'无'};
  const button=[...document.querySelectorAll('#request-host .body-formats button')].find(b=>b.textContent.trim()===labels['%%MODE%%']);
  if (!button) return JSON.stringify({ modePickFailed: 'missing format button' });
  button.click(); await sleep(360);
""".replace("%%MODE%%", mode)


# 1. form-data: one text field and one file field, on the wire together
out = run(
    NEW_TAB
    + pick_mode("form")
    + """
  const kv=document.querySelector('#request-host .kv');
  type(kv.querySelector('.kv-row.ghost').querySelectorAll('input')[0],'note'); await sleep(220);
  let rows=kv.querySelectorAll('.kv-row:not(.ghost):not(.kv-head)');
  type(rows[rows.length-1].querySelectorAll('input')[2],'上海'); await sleep(220);
  type(kv.querySelector('.kv-row.ghost').querySelectorAll('input')[0],'payload'); await sleep(220);
  rows=kv.querySelectorAll('.kv-row:not(.ghost):not(.kv-head)');
  globalThis.__row=rows[rows.length-1];
  await pick('.kv-kind', 'file', globalThis.__row);
  const valueInput=globalThis.__row.querySelectorAll('input')[2];
  type(valueInput,'%%PATH%%'); valueInput.dispatchEvent(new Event('blur')); await sleep(1100);
  const dataRows=[...kv.querySelectorAll('.kv-row:not(.ghost):not(.kv-head)')];
  const rowInfo=dataRows.map(r=>({ key: r.querySelectorAll('input')[1].value,
    shown: getComputedStyle(r.querySelector('.kv-pick')).display !== 'none' }));
  const btn=globalThis.__row.querySelector('.kv-pick'); const box=btn.getBoundingClientRect();
  const meta=globalThis.__row.querySelector('.kv-file-meta');
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click();
  await sleep(1800);
  const head=[...document.querySelectorAll('.response-head .meta')].map(m=>m.textContent);
  const sent=JSON.parse(document.querySelector('.response-body pre').textContent);
  const modeAlive=[...document.querySelectorAll('#request-host .body-formats button')].some(r=>r.textContent.trim()==='URL 编码');
  return JSON.stringify({modeAlive, rows: rowInfo, label: meta.textContent, title: meta.title,
    bad: meta.classList.contains('bad'), hit: box.width>20 && box.height>=18,
    received: sent.received, ctype: (sent.headers||{})['Content-Type'] || (sent.headers||{})['content-type'], head});
"""
)
received = out.get("received") or ""
rows = out.get("rows") or []
check(
    "form-data 里一行改成「文件」后，只有该行出现选择按钮，并显示文件大小",
    out.get("hit")
    and [r["key"] for r in rows] == ["note", "payload"]
    and [r["shown"] for r in rows] == [False, True]
    and out.get("label") == SIZE_LABEL
    and (out.get("title") or "").startswith(PAYLOAD)
    and not out.get("bad"),
    {k: out.get(k) for k in ("rows", "label", "title", "bad", "hit")},
)
check(
    "切到 form-data 后「Body 类型」选择器还在（KV 不能吃掉同一 host 里的兄弟节点）",
    out.get("modeAlive"),
    out.get("modeAlive"),
)
check(
    "文件真的按 multipart 上传：服务端看到 filename 与文件内容",
    'name="note"' in received
    and "上海" in received
    and 'name="payload"' in received
    and f'filename="{PAYLOAD_NAME}"' in received
    and "relay-upload-marker-" in received
    and str(out.get("ctype") or "").startswith("multipart/form-data"),
    {"ctype": out.get("ctype"), "received": received[:220]},
)

# 2. a path that points at nothing is called out in the row, and the send fails loudly
out = run("""
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const row=[...document.querySelectorAll('#request-host .kv-row .kv-pick')]
    .filter(b=>getComputedStyle(b).display!=='none').map(b=>b.closest('.kv-row'))[0];
  if(!row) return JSON.stringify({error:'文件行不见了'});
  const valueInput=row.querySelectorAll('input')[2];
  valueInput.value='%%MISSING%%'; valueInput.dispatchEvent(new Event('input',{bubbles:true}));
  valueInput.dispatchEvent(new Event('blur')); await sleep(1100);
  const meta=row.querySelector('.kv-file-meta');
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click();
  await sleep(1500);
  const pill=document.querySelector('.response-head .pill');
  return JSON.stringify({label: meta.textContent, bad: meta.classList.contains('bad'),
    pill: pill ? pill.textContent : null,
    detail: [...document.querySelectorAll('.response p')].map(p=>p.textContent).join(' | ').slice(0,160)});
""")
check(
    "路径指向不存在的文件时行内标红提示，发送失败并说明原因",
    out.get("label") == "找不到文件" and out.get("bad") and "读取文件" in (out.get("detail") or ""),
    out,
)

# 3. binary body: the whole file goes out as-is
out = run(
    NEW_TAB
    + pick_mode("file")
    + """
  const field=document.querySelector('.file-pick');
  const input=field.querySelector('input'); const btn=field.querySelector('button');
  type(input,'%%PATH%%'); await sleep(1100);
  return JSON.stringify({buttonText: btn.textContent.trim(), label: field.querySelector('.kv-file-meta').textContent,
    hasPicker: !!btn});
"""
)
check(
    "binary 模式的文件输入框旁边有「选择文件」，并能读出文件大小",
    out.get("hasPicker") and out.get("buttonText") == "选择文件" and out.get("label") == SIZE_LABEL,
    out,
)

out = run("""
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click();
  await sleep(1700);
  const sent=JSON.parse(document.querySelector('.response-body pre').textContent);
  return JSON.stringify({received: sent.received,
    ctype: (sent.headers||{})['Content-Type'] || (sent.headers||{})['content-type']});
""")
body = out.get("received") or ""
check(
    "binary 请求体是文件本身，Content-Type 默认 octet-stream",
    body.startswith("relay-upload-marker-")
    and len(body) == 2048
    and (out.get("ctype") or "") == "application/octet-stream",
    {"ctype": out.get("ctype"), "len": len(body)},
)

# 4. the size labels come from a real command; the picker itself opens an OS modal
#    no CDP driver can dismiss, so what is verified here is the wiring and the ACL.
ipc = guard(json.loads(js("""(async () => {
  const core = window.__TAURI__ && window.__TAURI__.core;
  if (!core) return JSON.stringify({ available: false });
  const meta = await core.invoke('file_meta', { path: '%%PATH%%' });
  let bogus = null;
  try { await core.invoke('file_meta', { path: 'D:\\\\nope.bin' }); } catch (error) { bogus = String(error); }
  let dir = null;
  try { dir = String((await core.invoke('file_meta', { path: 'C:\\\\Windows' })).size); }
  catch (error) { dir = String(error); }
  const ui = await import('/js/ui.js');
  return JSON.stringify({ available: true, meta, bogus: bogus.slice(0, 90), dir: dir.slice(0, 40),
    pickIsFn: typeof ui.pickFile === 'function' && typeof ui.fileMeta === 'function' });
})()""".replace("%%PATH%%", PAYLOAD.replace("\\", "\\\\")))))
if ipc.get("available"):
    meta = ipc.get("meta") or {}
    check(
        "file_meta 命令返回文件名与字节数，读不到的路径以错误返回",
        meta.get("name") == PAYLOAD_NAME and meta.get("size") == 2048 and "打不开" in (ipc.get("bogus") or ""),
        {"meta": meta, "bogus": ipc.get("bogus")},
    )
    check(
        "目录不会被当成文件上传，前端也确实接上了选择器入口",
        "不是文件" in (ipc.get("dir") or "") and ipc.get("pickIsFn"),
        {"dir": ipc.get("dir"), "pickIsFn": ipc.get("pickIsFn")},
    )
else:
    check("file_meta 命令可用", False, ipc)

with open(os.path.join(ROOT, "src-tauri", "capabilities", "default.json"), encoding="utf-8") as handle:
    caps = json.load(handle)
check(
    "dialog:allow-open 写在 capabilities 里",
    any("dialog:allow-open" in str(item) for item in caps.get("permissions", [])),
    [p for p in caps.get("permissions", []) if "dialog" in str(p)],
)

if os.path.isfile(PAYLOAD):
    os.remove(PAYLOAD)

failed = [name for name, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} 通过")
if failed:
    print("失败项：" + "、".join(failed))
sys.exit(1 if failed else 0)
