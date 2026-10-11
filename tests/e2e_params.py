"""Checks for the params/headers ergonomics: URL <-> table sync, no duplicated
query on the wire, multi-line paste, and the bulk editor."""

import json
import sys
import time
import urllib.request

import websocket

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9223
BASE = "http://127.0.0.1:8899"
results = []

pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5))
sock = websocket.create_connection([p for p in pages if p["type"] == "page"][0]["webSocketDebuggerUrl"], timeout=90)
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
            return value if isinstance(value, str) else json.dumps(value)
    return json.dumps({"jsError": "timeout"})


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' — ' + str(detail)[:230]) if detail else ''}", flush=True)


BOOT = """
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
  const newTab = async () => {
    document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(200);
    [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(300);
  };
  const subtab = (name) => [...document.querySelectorAll('.subtab')].find((b) => b.textContent.trim().startsWith(name));
  const rowsOf = (host) => [...host.querySelectorAll('.kv-row:not(.ghost):not(.kv-head)')]
    .map((r) => { const i = r.querySelectorAll('input'); return { key: i[1].value, value: i[2].value }; });
"""

# ---- 1. a URL that already carries a query fills the Params table ----
out = json.loads(js(f"""(async () => {{ try {{
{BOOT}
  await sleep(300);
  await newTab();
  const url = document.querySelector('.url-input');
  type(url, '{BASE}/orders?status=paid&page=2&kw=%E4%B8%AD%E6%96%87');
  url.dispatchEvent(new Event('blur', {{ bubbles: true }}));
  await sleep(300);
  subtab('Params').click(); await sleep(300);
  const rows = rowsOf(document.querySelector('#request-host .kv'));
  return JSON.stringify({{ rows, url: url.value }});
}} catch (error) {{ return JSON.stringify({{ error: String(error && error.message) }}); }} }})()"""))
rows = out.get("rows") or []
check("URL 里自带的 ?a=1&b=2 会自动解析进 Params 表格",
      [(r["key"], r["value"]) for r in rows] == [("status", "paid"), ("page", "2"), ("kw", "中文")], out)

# ---- 2. editing the table rewrites the URL, and the wire gets each param once ----
out = json.loads(js(f"""(async () => {{ try {{
{BOOT}
  await sleep(300);
  await newTab();
  const url = document.querySelector('.url-input');
  type(url, '{BASE}/echo?status=paid');
  url.dispatchEvent(new Event('blur', {{ bubbles: true }})); await sleep(250);
  subtab('Params').click(); await sleep(250);
  const host = document.querySelector('#request-host .kv');
  const rows = host.querySelectorAll('.kv-row:not(.ghost):not(.kv-head)');
  const inputs = rows[rows.length - 1].querySelectorAll('input');
  type(inputs[2], 'refunded');
  inputs[2].dispatchEvent(new Event('blur', {{ bubbles: true }}));
  const ghost = host.querySelector('.kv-row.ghost').querySelectorAll('input');
  type(ghost[0], 'extra'); await sleep(150);
  const fresh = host.querySelectorAll('.kv-row:not(.ghost):not(.kv-head)');
  const freshInputs = fresh[fresh.length - 1].querySelectorAll('input');
  type(freshInputs[2], '42');
  freshInputs[2].dispatchEvent(new Event('blur', {{ bubbles: true }}));
  await sleep(250);
  const shown = document.querySelector('.url-input').value;
  [...document.querySelectorAll('.urlbar button')].find((b) => b.textContent.includes('发送')).click();
  await sleep(1500);
  const echoed = JSON.parse(document.querySelector('.response-body pre').textContent);
  const counts = (echoed.query.match(/status=/g) || []).length;
  return JSON.stringify({{ shown, sentQuery: echoed.query, statusTimes: counts }});
}} catch (error) {{ return JSON.stringify({{ error: String(error && error.message) }}); }} }})()"""))
check("改表格会重写 URL，且发送时参数不重复",
      "status=refunded" in (out.get("shown") or "") and "extra=42" in (out.get("shown") or "")
      and "status=refunded" in (out.get("sentQuery") or "") and out.get("statusTimes") == 1, out)

# ---- 3. pasting a DevTools header dump creates several rows at once ----
out = json.loads(js(f"""(async () => {{ try {{
{BOOT}
  await sleep(300);
  await newTab();
  subtab('Headers').click(); await sleep(250);
  const host = document.querySelector('#request-host .kv');
  const before = host.querySelectorAll('.kv-row:not(.ghost):not(.kv-head)').length;
  const ghost = host.querySelector('.kv-row.ghost').querySelectorAll('input')[0];
  const dump = 'Content-Type: application/json\\r\\nAuthorization: Bearer sk-123\\r\\nX-Trace: 88\\r\\n# comment line';
  const dt = new DataTransfer();
  dt.setData('text', dump);
  ghost.dispatchEvent(new ClipboardEvent('paste', {{ clipboardData: dt, bubbles: true, cancelable: true }}));
  await sleep(400);
  const rows = rowsOf(document.querySelector('#request-host .kv'));
  return JSON.stringify({{ before, rows }});
}} catch (error) {{ return JSON.stringify({{ error: String(error && error.message) }}); }} }})()"""))
rows = out.get("rows") or []
check("一次粘贴多行 header 文本会拆成多行",
      [(r["key"], r["value"]) for r in rows[out.get("before", 0):]] == [("Content-Type", "application/json"), ("Authorization", "Bearer sk-123"), ("X-Trace", "88")], out)

# ---- 4. the bulk editor replaces the whole table from plain text ----
out = json.loads(js(f"""(async () => {{ try {{
{BOOT}
  await sleep(300);
  await newTab();
  subtab('Params').click(); await sleep(250);
  [...document.querySelectorAll('.kv-bar button')].find((b) => b.textContent.includes('批量编辑')).click();
  await sleep(300);
  const area = document.querySelector('.modal textarea');
  area.value = 'a=1\\nb=2\\nkeyword=订单列表';
  [...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent.includes('应用')).click();
  await sleep(400);
  const rows = rowsOf(document.querySelector('#request-host .kv'));
  return JSON.stringify({{ rows, url: document.querySelector('.url-input').value }});
}} catch (error) {{ return JSON.stringify({{ error: String(error && error.message) }}); }} }})()"""))
rows = out.get("rows") or []
check("批量编辑：粘一段文本即可整表替换",
      [(r["key"], r["value"]) for r in rows] == [("a", "1"), ("b", "2"), ("keyword", "订单列表")], out)

# ---- 5. typing one character at a time must sync live, and leave no residue ----
# the other checks set whole values at once, which is exactly how the ghost-row
# regressions (URL only updating on blur, stale text left in the add-row) hid
out = json.loads(js(f"""(async () => {{ try {{
{BOOT}
  await sleep(300);
  await newTab();
  const url = document.querySelector('.url-input');
  type(url, '{BASE}/orders'); await sleep(200);
  subtab('Params').click(); await sleep(250);
  document.querySelector('.kv-row.ghost').querySelectorAll('input')[0].focus();
  const trail = [];
  for (const ch of 'page') {{
    const el = document.activeElement;
    el.value = el.value + ch;
    el.dispatchEvent(new InputEvent('input', {{ bubbles: true }}));
    await sleep(70);
    trail.push(document.querySelector('.url-input').value);
  }}
  const rows = [...document.querySelectorAll('.kv .kv-row:not(.kv-head):not(.ghost)')]
    .map((r) => {{ const i = r.querySelectorAll('input'); return {{ key: i[1].value, value: i[2].value }}; }});
  return JSON.stringify({{ trail, rows, ghost: document.querySelector('.kv-row.ghost').querySelectorAll('input')[0].value }});
}} catch (error) {{ return JSON.stringify({{ error: String(error && error.message) }}); }} }})()"""))
rows = out.get("rows") or []
trail = out.get("trail") or []
check("一个字符一个字符地打，URL 实时跟随且不留残字",
      len(rows) == 1 and rows[0]["key"] == "page"
      and trail[0].endswith("?p=") and trail[-1].endswith("?page=")
      and all(t.endswith("=") for t in trail) and out.get("ghost") == "", out)

# the add-row line must accept a value first, not only a key
out = json.loads(js(f"""(async () => {{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {{
    // a brand new tab: its params table starts empty, so the counts cannot drift
    // with whatever the earlier checks left open
    document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(250);
    [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(400);
    const table = document.querySelector('.kv');
    const before = table.querySelectorAll('.kv-row:not(.kv-head):not(.ghost)').length;
    const valueCell = table.querySelector('.kv-row.ghost').querySelectorAll('input')[1];
    valueCell.focus();
    valueCell.value = 'early';
    valueCell.dispatchEvent(new InputEvent('input', {{ bubbles: true }}));
    await sleep(400);
    const made = [...table.querySelectorAll('.kv-row:not(.kv-head):not(.ghost)')].slice(before)
      .map((r) => {{ const i = r.querySelectorAll('input'); return {{ key: i[1].value, value: i[2].value }}; }});
    const newRow = table.querySelectorAll('.kv-row:not(.kv-head):not(.ghost)')[before];
    return JSON.stringify({{
      made,
      caretOnValue: !!newRow && document.activeElement === newRow.querySelectorAll('input')[2],
      ghostLeft: [...table.querySelectorAll('.kv-row.ghost input')].map((i) => i.value).join('|'),
    }});
  }} catch (error) {{ return JSON.stringify({{ error: String(error && error.message) }}); }}
}})()"""))
made = out.get("made") or []
check(
    "先在值格打字也会成行，光标留在值格以继续输入或补全",
    len(made) == 1 and made[0]["value"] == "early" and made[0]["key"] == ""
    and out.get("caretOnValue") is True and out.get("ghostLeft") == "||",
    out,
)

failed = [name for name, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} 通过")
if failed:
    print("失败项：" + "、".join(failed))
sys.exit(1 if failed else 0)
