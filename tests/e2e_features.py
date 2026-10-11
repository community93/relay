"""Third E2E pass: GBK/multi-encoding decoding, the JSON tree with per-node copy,
and the export affordances."""

import json
import os
import sys
import time
import urllib.request

import websocket

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ui_js import PICK  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9223
BASE = "http://127.0.0.1:8899"
results = []

pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5))
target = [p["webSocketDebuggerUrl"] for p in pages if p.get("type") == "page"][0]
sock = websocket.create_connection(target, timeout=90)
counter = [0]


def js(expression, timeout=90):
    counter[0] += 1
    marker = counter[0]
    sock.send(json.dumps({"id": marker, "method": "Runtime.evaluate", "params": {"expression": expression, "returnByValue": True, "awaitPromise": True}}))
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


def mouse(x, y):
    for kind in ("mousePressed", "mouseReleased"):
        counter[0] += 1
        sock.send(json.dumps({"id": counter[0], "method": "Input.dispatchMouseEvent",
                              "params": {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1, "buttons": 1 if kind == "mousePressed" else 0}}))
        time.sleep(0.05)


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' — ' + str(detail)[:200]) if detail else ''}", flush=True)


def fetch(url, extra=""):
    return js(f"""(async () => {{
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(200); [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(300);
      document.querySelector('.method-pick').click(); await sleep(160); [...document.querySelectorAll('.menu-item')].find((x) => x.textContent.trim() === 'GET').click(); await sleep(160);
      const u=document.querySelector('.url-input'); u.value='{url}'; u.dispatchEvent(new Event('input',{{bubbles:true}}));
      [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click();
      await sleep(1400);
      {extra}
      return JSON.stringify({{
        text: document.querySelector('.response-body pre')?.textContent.slice(0,200) || document.querySelector('.response-body')?.textContent.slice(0,200),
        head: document.querySelector('.response-head')?.textContent.replace(/\\s+/g,' ').slice(0,140),
        toasts: [...document.querySelectorAll('.toast')].map(t=>t.textContent.slice(0,50))
      }});
    }})()""")


# 1. declared GBK
out = json.loads(fetch(f"{BASE}/gbk"))
check(
    "声明 charset=gbk 的响应自动解码为中文",
    "上海" in (out.get("text") or "") and "GBK" in (out.get("head") or "").upper(),
    out,
)

# 2. GBK with no charset declared -> sniffed, and manual override offered
out = json.loads(js(f"""(async () => {{
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(200); [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(300);
  const u=document.querySelector('.url-input'); u.value='{BASE}/gbk-nolabel'; u.dispatchEvent(new Event('input',{{bubbles:true}}));
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click(); await sleep(1400);
  const head=document.querySelector('.response-head')?.textContent.replace(/\s+/g,' ').slice(0,120);
  const text=document.querySelector('.response-body pre')?.textContent.slice(0,60);
  {PICK}
  const sel=document.querySelector('.response-head .select-field');
  if(!sel) return JSON.stringify({{head, text, hadSelect:false}});
  const toUtf8 = await pick('.response-head .select-field', 'utf-8'); await sleep(900);
  const utf8view=document.querySelector('.response-body pre')?.textContent.slice(0,60);
  const toGbk = await pick('.response-head .select-field', 'gb18030'); await sleep(900);
  const back=document.querySelector('.response-body pre')?.textContent.slice(0,60);
  return JSON.stringify({{head, text, hadSelect:true, toUtf8, toGbk, utf8view, back}});
}})()"""))
check(
    "未声明编码的 GBK 响应被嗅探为 GB18030，且可手动改码再解码",
    "北京" in (out.get("text") or "")
    and "GB18030" in (out.get("head") or "").upper()
    and out.get("hadSelect")
    and "北京" not in (out.get("utf8view") or "")
    and "北京" in (out.get("back") or ""),
    {"sniffed": (out.get("text") or "")[:30], "asUtf8": (out.get("utf8view") or "")[:30], "back": (out.get("back") or "")[:30]},
)

# 3. JSON tree: copy a nested value and its path
out = json.loads(
    fetch(
        f"{BASE}/list",
        """const treeBtn=[...document.querySelectorAll('.response-body .seg button')].find(b=>b.textContent.trim()==='树');
           treeBtn.click(); await sleep(400);
           const rows=[...document.querySelectorAll('.response-body .twist')].length;
           const copyPath=[...document.querySelectorAll('.response-body button')].find(b=>b.textContent.trim()==='复制路径');
           copyPath?.click(); await sleep(300);
           const copyVal=[...document.querySelectorAll('.response-body button')].filter(b=>b.textContent.trim()==='复制值')[2];
           copyVal?.click(); await sleep(300);
           const expandAll=[...document.querySelectorAll('.response-body button')].find(b=>b.textContent.trim()==='全部展开');
           expandAll?.click(); await sleep(300);
           const rowsAfter=[...document.querySelectorAll('.response-body .twist')].length;
           globalThis.__tree={rows, rowsAfter, toasts:[...document.querySelectorAll('.toast')].map(t=>t.textContent.slice(0,40))};""",
    )
)
tree = json.loads(js("JSON.stringify(globalThis.__tree||{})"))
# the tree copy above used a synthetic click; repeat with a trusted mouse event so
# the clipboard API gets real user activation
box = json.loads(js("""(async () => {
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const btn=[...document.querySelectorAll('.response-body button')].find(b=>b.textContent.trim()==='复制路径');
  if(!btn) return JSON.stringify({});
  const r=btn.getBoundingClientRect();
  return JSON.stringify({x:r.x+r.width/2, y:r.y+r.height/2});
})()"""))
if box.get("x"):
    js("document.querySelectorAll('.toast').forEach(t=>t.remove())")
    mouse(box["x"], box["y"])
    time.sleep(0.8)
    tree["trustedToast"] = json.loads(js("JSON.stringify([...document.querySelectorAll('.toast')].map(t=>t.textContent).join('|'))") or '""')
check(
    "响应可切成 JSON 树，逐层复制值与 JSONPath",
    tree.get("rows", 0) >= 3
    and tree.get("rowsAfter", 0) > tree.get("rows", 0)
    and any("已复制" in t for t in [tree.get("trustedToast", "")] + tree.get("toasts", []))
    and "$" in (tree.get("trustedToast") or ""),
    tree,
)

# 4. export affordances + CSV conversion of a nested array
out = json.loads(js(f"""(async () => {{
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const view = await import('/js/jsonview.js');
  const sample = JSON.stringify({{"data":{{"items":[{{"id":1,"机构":"上海分行","金额":1200.5}},{{"id":2,"机构":"成都分行","金额":880}}]}}}});
  const csv = view.toCsv(sample);
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(200); [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(300);
  const u=document.querySelector('.url-input'); u.value='{BASE}/list'; u.dispatchEvent(new Event('input',{{bubbles:true}}));
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click(); await sleep(1400);
  [...document.querySelectorAll('.response-head button')].find(b=>b.textContent.includes('导出')).click(); await sleep(300);
  const items=[...document.querySelectorAll('.menu-item')].map(m=>({{label:m.textContent.trim(), dim:m.style.color==='var(--text-faint)'}}));
  document.dispatchEvent(new KeyboardEvent('keydown',{{key:'Escape',bubbles:true}}));
  return JSON.stringify({{csv: (csv||'').slice(0,160), items}});
}})()"""))
csv = out.get("csv") or ""
check(
    "导出菜单可用，对象数组可转 CSV",
    len(out.get("items") or []) >= 4
    and any("json" in (i.get("label") or "") for i in out["items"])
    and any("csv" in (i.get("label") or "") for i in out["items"])
    and "机构" in csv
    and "上海分行" in csv
    and csv.count("\n") >= 2,
    {"items": [i["label"] for i in out.get("items", [])], "csv": csv[:90]},
)

# 5. does "导出" actually land a file on disk?
# The Save-As sheet is answered with a temp path: the OS dialog would block the
# webview, and the old check wrote into the user's real Downloads folder.
import os
import tempfile
out_dir = tempfile.mkdtemp(prefix="relay-export-")
csv_path = os.path.join(out_dir, "relay-export.csv")
# Install the stub and click in ONE evaluate: the previous version installed it in
# one call and clicked in the next, and across two Runtime.evaluate round-trips the
# page had already been re-rendered by the send, so the answer never got used.
# Split in two, because the Save-As sheet cannot be answered from a test: every
# attempt to stub `core.invoke` left a real modal open, which blocks the webview
# and then times out the rest of the suite. So this asserts the two halves that
# ARE observable — the menu offers .csv for an object array, and the bridge writes
# the bytes it is handed — while e2e_controls asserts the routing (every export
# calls saveAs, no blob download left) at source level.
out = json.loads(js("""(async () => {
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const u=document.querySelector('.url-input');
  u.value='%s/list'; u.dispatchEvent(new Event('input',{bubbles:true})); await sleep(150);
  [...document.querySelectorAll('.urlbar button')].find(b=>/发送/.test(b.textContent)).click();
  await sleep(1800);
  const btn=[...document.querySelectorAll('.response-head button')].find(b=>b.textContent.includes('导出'));
  if(!btn) return JSON.stringify({noExportButton:true});
  btn.click(); await sleep(320);
  const rows=[...document.querySelectorAll('.menu-item')];
  const item=rows.find(m=>m.textContent.includes('.csv'));
  const shape={ hasCsv: !!item, csvEnabled: !!item && !item.classList.contains('disabled'),
    labels: rows.map(m=>m.textContent.trim()) };
  const menu=document.querySelector('.menu');
  if (menu) menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  await sleep(200);
  const core = window.__TAURI__ && window.__TAURI__.core;
  let wrote = null, back = null;
  if (core) {
    try {
      back = await core.invoke('save_text', { path: %s, contents: 'org,city\\n上海分行,上海\\n' });
      wrote = true;
    } catch (error) { wrote = String(error.message || error).slice(0, 90); }
  }
  return JSON.stringify({ ...shape, wrote, back });
})()""" % (BASE, json.dumps(csv_path.replace("\\", "\\\\")))))
check("对象数组响应的导出菜单提供 .csv 且该项可用",
        out.get("hasCsv") and out.get("csvEnabled"), out)
check("桥的另一半真的落盘：save_text 按给定路径写出给定内容",
        out.get("wrote") is True and os.path.exists(csv_path), out)
if os.path.exists(csv_path):
    with open(csv_path, encoding="utf-8") as handle:
        content = handle.read()
    check("落盘文件内容正确", "机构" in content or "上海分行" in content, content[:60].replace(chr(10), " | "))
    os.remove(csv_path)


# 5b. selecting an environment opens its settings on the right, and edits take effect
out = json.loads(js(f"""(async () => {{
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelector('button[data-rail=environments]').click(); await sleep(250);
  document.querySelectorAll('#sidebar .node')[0].click(); await sleep(400);
  const tabBadge=document.querySelector('.tabstrip .tab.active')?.textContent.trim().slice(0,6);
  const cards=[...document.querySelectorAll('#request-host .row-label')].map(c=>c.textContent.replace(/\s+/g,' ').trim());
  const respHidden=document.getElementById('response-host').classList.contains('hidden');
  const type=(i,v)=>{{i.value=v;i.dispatchEvent(new Event('input',{{bubbles:true}}));}};
  const base=[...document.querySelectorAll('#request-host .input.mono')][0]; type(base,'{BASE}');
  const kv=document.querySelectorAll('#request-host .kv')[0];
  type(kv.querySelector('.kv-row.ghost').querySelectorAll('input')[0],'city'); await sleep(150);
  const rows=kv.querySelectorAll('.kv-row:not(.ghost):not(.kv-head)');
  type(rows[rows.length-1].querySelectorAll('input')[2],'shanghai'); await sleep(250);
  const chips=[...document.querySelectorAll('#request-host .chip')].map(c=>c.textContent);
  const active=()=>document.querySelector('#request-host .switch');
  if(active().classList.contains('on')) {{ active().click(); await sleep(450); }}
  active().click(); await sleep(500);
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(250);
  [...document.querySelectorAll('.menu-item')].find((m)=>m.textContent.includes('HTTP')).click(); await sleep(350);
  const u=document.querySelector('.url-input');
  type(u,'{{{{baseUrl}}}}/hello?city={{{{city}}}}'); await sleep(150);
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click(); await sleep(1400);
  const pre=document.querySelector('.response-body pre');
  const sent=pre? JSON.parse(pre.textContent).query : null;
  return JSON.stringify({{tabBadge, cards, respHidden, chips, sent}});
}})()"""))
check(
    "选中环境后右侧展开该环境的设置，改完即生效",
    (out.get("tabBadge") or "").startswith("ENV")
    and all(need in (out.get("cards") or []) for need in ["启用此环境", "变量", "前缀策略", "Body 类型"])
    and out.get("respHidden")
    and "{{city}}" in (out.get("chips") or [])
    and "city=shanghai" in (out.get("sent") or "")
    and "/hello" in (out.get("sent") or ""),
    out,
)

# 6. the protocol chooser is the first control and covers all three types
out = json.loads(js("""(async () => {
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(200); [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(300);
  const bar=[...document.querySelector('.urlbar').children].map(c=>c.className);
  const buttons=[...document.querySelectorAll('.urlbar .seg button')].map(b=>b.textContent.trim());
  const ws=[...document.querySelectorAll('.urlbar .seg button')].find(b=>b.textContent.trim()==='WS');
  ws.click(); await sleep(350);
  const wsPane=!!document.querySelector('.ws-out');
  const back=[...document.querySelectorAll('.urlbar .seg button')].find(b=>b.textContent.trim()==='HTTP');
  back.click(); await sleep(300);
  return JSON.stringify({ first: bar[0], buttons, wsPane, backToHttp: !!document.querySelector('.method-pick') });
})()"""))
check(
    "协议选择器在最前面，HTTP/SSE/WS 三态可来回切",
    out.get("first") == "url-field"
    and out.get("buttons") == ["HTTP", "SSE", "WS"]
    and out.get("wsPane")
    and out.get("backToHttp"),
    out,
)

# 7. POST + body streaming (fetch-event-stream style), and NDJSON / raw-text sniffing
def stream_case(url, method="GET", body=None, expect=(), label=""):
    extra = ""
    if method == "POST":
        extra = """
        document.querySelector('.method-pick').click(); await sleep(160); [...document.querySelectorAll('.menu-item')].find((x) => x.textContent.trim() === 'POST').click(); await sleep(150);
        [...document.querySelectorAll('.subtab')].find(b=>b.textContent.trim().startsWith('Body')).click(); await sleep(150);
        [...document.querySelectorAll('#request-host .body-formats button')].find(r=>r.textContent.trim()==='JSON').click(); await sleep(300);
        const {EditorView}=await import('./js/vendor/editor-core.js'); const editor=EditorView.findFromDOM(document.querySelector('.body-code .cm-content')); editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:'%s'}}); await sleep(100);
        [...document.querySelectorAll('.subtab')].find(b=>b.textContent.trim().startsWith('Params')).click(); await sleep(120);
        """ % body
    return js(f"""(async () => {{
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(200); [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(300);
      [...document.querySelectorAll('.urlbar .seg button')].find(b=>b.textContent.trim()==='SSE').click(); await sleep(200);
      const u=document.querySelector('.url-input'); u.value='{url}'; u.dispatchEvent(new Event('input',{{bubbles:true}}));
      {extra}
      [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.trim()==='连接').click();
      await sleep(2600);
      const events=[...document.querySelectorAll('.events .event')].map(e=>e.textContent.replace(/\s+/g,' ').slice(0,70));
      const fmt=[...document.querySelectorAll('.urlbar .select-field')].map(s=>s.textContent.trim());
      return JSON.stringify({{events, count: events.length, fmt}});
    }})()""")

out = json.loads(stream_case(f"{BASE}/sse-post", method="POST", body='{"q":1}', label="post-sse"))
blob = json.dumps(out, ensure_ascii=False)
check("POST + Body 的事件流（fetch-event-stream 风格）可连接并逐条接收", out.get("count", 0) >= 4 and "echo" in blob and "delta" in blob and "seq" in blob, {"count": out.get("count"), "first": (out.get("events") or [""])[1][:60]})

out = json.loads(stream_case(f"{BASE}/ndjson"))
blob = json.dumps(out, ensure_ascii=False)
check("NDJSON 流自动识别为逐行 JSON", out.get("count", 0) >= 4 and "第1行" in blob and "json" in blob, out)

out = json.loads(stream_case(f"{BASE}/tokens"))
blob = json.dumps(out, ensure_ascii=False)
check("纯文本增量流自动识别为分块", out.get("count", 0) >= 3 and "模型" in blob and "增量" in blob, out)

# 7. the raw wire view shows exactly what arrived, framing and all
out = json.loads(js(f"""(async () => {{
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(250);
  [...document.querySelectorAll('.menu-item')].find((m)=>m.textContent.includes('SSE')).click(); await sleep(300);
  const u=document.querySelector('.url-input'); u.value='{{{{BASE}}}}/sse'; u.dispatchEvent(new Event('input',{{bubbles:true}}));
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('连接')).click(); await sleep(2600);
  const st=await import('/js/state.js'); const tab=st.state.tabs.find(t=>t.id===st.state.activeTabId);
  const rawCount=tab.stream.raw.length, eventCount=tab.stream.events.filter(e=>e.kind==='message').length;
  [...document.querySelectorAll('.subtab')].find(b=>b.textContent.indexOf('原始流')===0).click(); await sleep(400);
  const nodes=[...document.querySelectorAll('.raw-chunk')];
  const marked=nodes.length ? nodes[0].querySelector('.raw-text').textContent : '';
  const box=document.querySelector('.raw-bar input'); box.checked=false; box.dispatchEvent(new Event('change',{{bubbles:true}})); await sleep(400);
  const plain=document.querySelector('.raw-chunk .raw-text').textContent;
  [...document.querySelectorAll('.subtab')].find(b=>b.textContent.indexOf('事件')===0).click(); await sleep(300);
  return JSON.stringify({{ rawCount, eventCount, rendered:nodes.length, meta:nodes[0]?nodes[0].querySelector('.raw-meta').textContent:null,
    marked, plain, eventRows:document.querySelectorAll('.event').length }});
}})()""".replace('{{BASE}}', BASE)))
check(
    "原始流视图按到达顺序展示未解析字节，可开关行尾标记",
    out.get("rendered", 0) >= 3 and out.get("rendered") == out.get("rawCount")
    and "B" in (out.get("meta") or "") and "#" in (out.get("meta") or "")
    and "␊" in (out.get("marked") or "") and "␊" not in (out.get("plain") or "")
    and (out.get("eventRows") or 0) >= (out.get("eventCount") or 0),
    {k: (str(v)[:70] if isinstance(v, str) else v) for k, v in out.items()},
)

# Ctrl+V on the page itself should turn a copied command straight into an import,
# while a paste aimed at a real field still just pastes text.
CURL_SAMPLE = "curl -X POST 'http://127.0.0.1:8899/echo' -H 'X-Tenant: demo' --data 'a=1'"


def paste(text, selector):
    return js("""(async () => {
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      const b=document.querySelector('.modal .modal-head button'); if(b){b.click(); await sleep(600);}
      const dt=new DataTransfer(); dt.setData('text/plain', %s);
      const evt=new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector('.tabstrip .tab-new').click(); await sleep(240);
      [...document.querySelectorAll('.menu-item')].find((m)=>m.textContent.includes('HTTP')).click(); await sleep(320);
      const target=document.querySelector('%s'); if(!target) return JSON.stringify({noTarget:true});
      target.focus(); target.dispatchEvent(evt); await sleep(900);
      const box=document.querySelector('.modal');
      return JSON.stringify({ handled: evt.defaultPrevented,
        dialog: box ? (box.querySelector('.modal-head h2')||{}).textContent : null,
        rows: box ? box.querySelectorAll('.pick').length : 0,
        area: box ? (box.querySelector('textarea')||{}).value : null });
    })()""" % (json.dumps(text, ensure_ascii=False), selector))


out = json.loads(paste(CURL_SAMPLE, ".sidebar-title"))
check(
    "页面空白处 Ctrl+V 一条 cURL，直接弹出导入窗并已解析好",
    out.get("handled")
    and out.get("dialog") == "导入 cURL"
    and out.get("rows") == 1
    and "X-Tenant" in (out.get("area") or ""),
    out,
)

# …and the confirmed import has to appear in front of you. The bug: standing on
# the 环境 pane, 导入 said "已导入 1 个请求" and the sidebar kept showing
# environments — the request existed but was nowhere you could see.
out = json.loads(js("""(async () => {
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const s=await import('/js/state.js');
  const box=document.querySelector('.modal');
  if(!box) return JSON.stringify({noDialog:true});
  const target=s.state.collections.find((c)=>c.id===box.querySelector('.select-field.import-target').dataset.value)||s.state.collections[0];
  const before=target.children.length;
  s.state.pane='environments'; s.emit('pane'); await sleep(320);
  const paneBefore=document.querySelector('.sidebar-title').textContent;
  box.querySelector('.modal-foot .btn.primary').click(); await sleep(900);
  const node=target.children[target.children.length-1];
  const row=document.querySelector('#sidebar .node[data-node="'+(node?node.id:'?')+'"]');
  let lands=false, flash=false, onScreen=false;
  if(row){
    const b=row.getBoundingClientRect();
    const hit=document.elementFromPoint(b.left+b.width/2, b.top+b.height/2);
    lands=!!hit&&row.contains(hit);
    flash=row.classList.contains('just-added');
    const sb=document.querySelector('.sidebar-body')||document.querySelector('#sidebar');
    const sbr=sb.getBoundingClientRect();
    onScreen=b.top>=sbr.top-2&&b.bottom<=sbr.bottom+2;
  }
  return JSON.stringify({ paneBefore, added: target.children.length-before,
    paneNow: s.state.pane, hasRow: !!row, lands, flash, onScreen,
    openAncestor: !!document.querySelector('#sidebar .node-collection.open'),
    activeRef: (s.state.tabs.find((t)=>t.id===s.state.activeTabId)||{}).refId,
    nodeId: node?node.id:null,
    urlShown: (document.querySelector('#request-host .url-input')||{}).value,
    stillOpen: !!document.querySelector('.modal') });
})()"""))
check(
    "确认导入后直接落到新请求页，侧栏新行可见并闪一下",
    out.get("paneBefore") == "环境" and out.get("added") == 1 and not out.get("noDialog")
    and out.get("paneNow") == "collections" and out.get("hasRow") and out.get("lands")
    and out.get("flash") and out.get("onScreen") and out.get("openAncestor")
    and out.get("activeRef") and out.get("activeRef") == out.get("nodeId")
    and "8899/echo" in (out.get("urlShown") or "")
    and not out.get("stillOpen"),
    out,
)

out = json.loads(paste("随手复制的一段说明文字，不是命令", ".sidebar-title"))
check(
    "剪贴板里不是可导入的东西时不打扰，不弹任何窗",
    not out.get("handled") and not out.get("dialog"),
    out,
)

# JSON no longer owns a clipboard import path.
out = json.loads(paste(json.dumps({"info":{"_postman_id":"removed"},"item":[]}), ".sidebar-title"))
check("集合 JSON 粘贴不触发导入", not out.get("handled") and not out.get("dialog"), out)

# do the query string and curl's `-G` payload actually reach the Params table?
out = json.loads(js("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const st=await import('/js/state.js');
  const t=await import('/js/tools.js');
  const col=st.state.collections[0];
  const before=col.children.length;
  t.importCurlDialog(null, "curl -G -d 'q=42' -d 'lang=zh' 'https://127.0.0.1:8899/search?tab=paid'");
  await s(1400);
  const box=document.querySelector('.modal');
  box.querySelector('.modal-foot .btn.primary').click(); await s(1400);
  const node=col.children[col.children.length-1];
  const rows=(node.request.params||[]).map((p)=>p.key+'='+p.value);
  st.openRequest(node, { replaceExisting: false }); await s(700);
  [...document.querySelectorAll('#request-host .subtab')].find((b)=>b.textContent.trim().startsWith('Params')).click(); await s(600);
  const cells=[...document.querySelectorAll('#request-host .kv-rows .kv-row:not(.kv-head):not(.ghost)')];
  const shown=cells.map((r)=>{ const c=r.querySelectorAll('.kv-cell'); return c[1].querySelector('input').value+'='+c[2].querySelector('input').value; });
  // a keystroke in the URL field re-derives the table from the URL; before the
  // query was folded back into the URL at import time, this single event deleted
  // every imported row — the exact loss reported as "query 没导入过来"
  const u=document.querySelector('.url-input');
  u.dispatchEvent(new Event('input',{bubbles:true})); await s(400);
  const afterTouch=[...document.querySelectorAll('#request-host .kv-rows .kv-row:not(.kv-head):not(.ghost)')]
    .map((r)=>{ const c=r.querySelectorAll('.kv-cell'); return c[1].querySelector('input').value+'='+c[2].querySelector('input').value; });
  const added=col.children.length-before;
  // leave the seed collection as we found it
  col.children.splice(col.children.indexOf(node),1);
  st.touch('collections'); st.emit('tree');
  return JSON.stringify({ added, method: node.request.method, url: node.request.url, rows, shown, afterTouch });
})()"""))
check(
    "curl 导入会把 URL 上的 query 与 -G 的 --data 都拆进 Params 表",
    out.get("added") == 1 and out.get("method") == "GET"
    # the URL keeps the query visible (that is what the user pasted and expects to
    # see again); the table is the mirror, not the only copy
    and str(out.get("url", "")).startswith("https://127.0.0.1:8899/search?")
    and "tab=paid" in str(out.get("url", ""))
    and sorted(out.get("rows", [])) == ["lang=zh", "q=42", "tab=paid"]
    and sorted(out.get("shown", [])) == ["lang=zh", "q=42", "tab=paid"]
    and sorted(out.get("afterTouch", [])) == ["lang=zh", "q=42", "tab=paid"],
    out,
)

out = json.loads(js("""(async () => {
  const s=await import('/js/state.js');
  const parsed=await (await import('/js/api.js')).parseCurl("curl -X POST 'https://127.0.0.1:8899/v1/orders?tab=paid' --data 'a=1'");
  const d=parsed[0].draft;
  return JSON.stringify({ method: d.method, url: d.url, params: d.params.map((p)=>p.key+'='+p.value), bodyMode: d.body && d.body.mode, raw: d.body && d.body.raw && d.body.raw.content });
})()"""))
check(
    "同时有 query 和请求体时两者分开保留：URL 只留基址，body 不被并进参数",
    out.get("method") == "POST" and out.get("url") == "https://127.0.0.1:8899/v1/orders"
    and out.get("params") == ["tab=paid"] and out.get("bodyMode") == "urlencoded",
    out,
)

out = json.loads(js("""(async () => {
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const b=document.querySelector('.modal .modal-head button'); if(b){b.click(); await sleep(600);}
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(240);
  [...document.querySelectorAll('.menu-item')].find((m)=>m.textContent.includes('HTTP')).click(); await sleep(320);
  [...document.querySelectorAll('.subtab')].find((b)=>b.textContent.trim().startsWith('Params')).click(); await sleep(300);
  const cell=document.querySelector('#request-host .kv-row.ghost input');
  const dt=new DataTransfer(); dt.setData('text/plain', 'http://127.0.0.1:8899/hello');
  const evt=new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  cell.focus(); cell.dispatchEvent(evt); await sleep(700);
  // a synthetic paste cannot insert text (that is the browser's own default
  // action), so what is provable here is that the handler left it alone
  return JSON.stringify({ dialog: !!document.querySelector('.modal'), prevented: evt.defaultPrevented });
})()"""))
check(
    "在输入框里 Ctrl+V 仍然是贴文本，不会被抢去导入",
    not out.get("dialog") and not out.get("prevented"),
    out,
)

# A segmented control used to guard on its construction-time value, so the
# segment that started selected could never be clicked again. Cycle all the way
# round with real mouse events and prove every step actually changes the view.
print(js("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await s(260);
  [...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('HTTP')).click(); await s(320);
  const u=document.querySelector('.url-input');
  u.value='%s/list'; u.dispatchEvent(new Event('input',{bubbles:true})); await s(200);
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click();
  await s(2000);
  return document.querySelector('.code-bar .seg') ? 'seg ready' : 'no seg';
})()""" % BASE))


def seg_click(label):
    box = json.loads(js("""(async () => {
      const b=[...document.querySelectorAll('.code-bar .seg button')].find(x=>x.textContent.trim()==='%s');
      if(!b) return JSON.stringify({missing:true});
      const r=b.getBoundingClientRect();
      return JSON.stringify({x:r.x+r.width/2, y:r.y+r.height/2, on:b.classList.contains('on')});
    })()""" % label))
    mouse(box["x"], box["y"])
    time.sleep(0.6)
    return json.loads(js("""(() => {
      const seg=document.querySelector('.code-bar .seg');
      const body=document.querySelector('.response-body');
      return JSON.stringify({ on:[...seg.querySelectorAll('button')].findIndex(b=>b.classList.contains('on')),
        thumb:Math.round(seg.querySelector('.seg-thumb').getBoundingClientRect().x),
        view:(body.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60) });
    })()"""))


seg_click("Pretty")
cycle = []
for step, label in [(1, "树"), (2, "Raw"), (3, "Pretty"), (4, "树"), (5, "Pretty")]:
    cycle.append((label, seg_click(label)))
idx = {"树": 1, "Raw": 2, "Pretty": 0}
ok_cycle = all(state.get("on") == idx[label] for label, state in cycle)
ok_thumb = all(state.get("thumb", 0) > 0 for _, state in cycle)
ok_view = (
    cycle[0][1].get("view", "").find("全部展开") >= 0
    and '{"data"' in cycle[1][1].get("view", "")
    and '"data"' in cycle[2][1].get("view", "")
    and cycle[3][1].get("view", "").find("全部展开") >= 0
    and '"data"' in cycle[4][1].get("view", "")
)
check(
    "响应视图分段控件转一圈都能真的切换（含回到最初选中的那一段）",
    ok_cycle and ok_thumb and ok_view,
    [(label, s.get("on"), s.get("view")[:22]) for label, s in cycle],
)

failed = [name for name, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} 通过")
if failed:
    print("失败项：" + "、".join(failed))
sys.exit(1 if failed else 0)
