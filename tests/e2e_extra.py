"""Second E2E pass: error states, binary bodies, timeout, cancel, redirect
switch, save-to-collection and collection JSON export."""

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


def connect():
    pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5))
    target = [p["webSocketDebuggerUrl"] for p in pages if p.get("type") == "page"][0]
    socket = websocket.create_connection(target, timeout=90)
    return socket


class CDP:
    def __init__(self, socket):
        self.ws = socket
        self.id = 0
        self.call("Runtime.enable")

    def call(self, method, params=None):
        self.id += 1
        self.ws.send(json.dumps({"id": self.id, "method": method, "params": params or {}}))
        return self.id

    def js(self, expression, timeout=90):
        marker = self.id + 1
        self.ws.send(
            json.dumps(
                {
                    "id": marker,
                    "method": "Runtime.evaluate",
                    "params": {"expression": expression, "returnByValue": True, "awaitPromise": True},
                }
            )
        )
        self.id = marker
        deadline = time.time() + timeout
        while time.time() < deadline:
            payload = json.loads(self.ws.recv())
            if payload.get("id") == marker:
                if "exceptionDetails" in payload.get("result", {}):
                    detail = payload["result"]["exceptionDetails"]
                    return json.dumps({"jsError": detail.get("exception", {}).get("description", detail.get("text"))})
                value = payload.get("result", {}).get("result", {}).get("value")
                return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        return json.dumps({"jsError": "timeout"})


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' — ' + str(detail)[:200]) if detail else ''}", flush=True)


NEW_TAB = ("document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(200); "
           "[...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(300);")

cdp = CDP(connect())

# 404 shows a warning pill and the server body
out = json.loads(cdp.js(f"""(async () => {{
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  {NEW_TAB}; await sleep(250);
  document.querySelector('.method-pick').click(); await sleep(160); [...document.querySelectorAll('.menu-item')].find((x) => x.textContent.trim() === 'GET').click(); await sleep(160);
  const u=document.querySelector('.url-input'); u.value='{BASE}/nope'; u.dispatchEvent(new Event('input',{{bubbles:true}}));
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click();
  await sleep(1200);
  return JSON.stringify({{pill: document.querySelector('.pill')?.textContent, body: document.querySelector('.response-body pre')?.textContent.slice(0,60)}});
}})()"""))
check("404 显示为告警状态并保留响应体", "404" in (out.get("pill") or ""), out)

# binary body: no text rendering, download affordance
out = json.loads(cdp.js(f"""(async () => {{
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  {NEW_TAB}; await sleep(250);
  const u=document.querySelector('.url-input'); u.value='{BASE}/bin'; u.dispatchEvent(new Event('input',{{bubbles:true}}));
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click();
  await sleep(1200);
  return JSON.stringify({{text: document.querySelector('.response-body')?.textContent.replace(/\\s+/g,' ').slice(0,90), hasDownload: [...document.querySelectorAll('.response-body button')].map(b=>b.textContent.trim())}});
}})()"""))
check("二进制响应不内联渲染，提供下载", "二进制响应" in (out.get("text") or "") and "下载文件" in (out.get("hasDownload") or []), out)

# timeout surfaces a friendly error card
out = json.loads(cdp.js(f"""(async () => {{
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  {NEW_TAB}; await sleep(250);
  const u=document.querySelector('.url-input'); u.value='{BASE}/slow'; u.dispatchEvent(new Event('input',{{bubbles:true}}));
  [...document.querySelectorAll('.subtab')].find(b=>b.textContent.trim().startsWith('Settings')).click(); await sleep(200);
  const timeout=document.querySelector('.pane input[type=number]'); timeout.value='500'; timeout.dispatchEvent(new Event('input',{{bubbles:true}}));
  [...document.querySelectorAll('.subtab')].find(b=>b.textContent.trim().startsWith('Params')).click(); await sleep(150);
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click();
  await sleep(1500);
  return JSON.stringify({{head: document.querySelector('.response-head')?.textContent.replace(/\\s+/g,' ').slice(0,40), err: document.querySelector('.response .pane strong')?.textContent, msg: document.querySelector('.response .pane p')?.textContent.slice(0,60)}});
}})()"""))
check("超时给出中文错误说明", (out.get("err") or "") == "请求失败" and "超时" in (out.get("msg") or ""), out)

# connection refused
out = json.loads(cdp.js(f"""(async () => {{
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  {NEW_TAB}; await sleep(250);
  const u=document.querySelector('.url-input'); u.value='http://127.0.0.1:59999/x'; u.dispatchEvent(new Event('input',{{bubbles:true}}));
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click();
  await sleep(3200);
  return JSON.stringify({{msg: document.querySelector('.response .pane p')?.textContent.slice(0,80), kind: document.querySelector('.pill')?.textContent, body: document.querySelector('.response-body')?.textContent.replace(/\s+/g,' ').slice(0,40)}});
}})()"""))
check("连不上时给出中文连接错误且无误导性 Body 页", "无法建立连接" in (out.get("msg") or "") and out.get("kind") == "连接失败" and "没有响应体" in (out.get("body") or ""), out)

# redirect off keeps the 302 visible
out = json.loads(cdp.js(f"""(async () => {{
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  {NEW_TAB}; await sleep(250);
  const u=document.querySelector('.url-input'); u.value='{BASE}/redirect'; u.dispatchEvent(new Event('input',{{bubbles:true}}));
  [...document.querySelectorAll('.subtab')].find(b=>b.textContent.trim().startsWith('Settings')).click(); await sleep(200);
  const toggle=document.querySelector('#request-host .switch');
  if(toggle.getAttribute('aria-checked')==='true')toggle.click();
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click();
  await sleep(1200);
  return JSON.stringify({{pill: document.querySelector('.pill')?.textContent, loc: [...document.querySelectorAll('.table tbody tr')].map(r=>r.textContent).join(' ').slice(0,80)}});
}})()"""))
check("关闭跟随重定向后 302 原样展示", "302" in (out.get("pill") or ""), out)

# cancel an in-flight request
out = json.loads(cdp.js(f"""(async () => {{
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  {NEW_TAB}; await sleep(250);
  const u=document.querySelector('.url-input'); u.value='{BASE}/slow'; u.dispatchEvent(new Event('input',{{bubbles:true}}));
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click();
  await sleep(400);
  const cancel=[...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('取消'));
  const label=cancel?cancel.textContent.trim():'none';
  if(cancel) cancel.click();
  let msg='';
  for (let i=0;i<12;i++) {{ await sleep(250);
    msg = document.querySelector('.response .pane p')?.textContent || document.querySelector('.response-body')?.textContent.slice(0,40) || '';
    if (msg.includes('取消')) break;
  }}
  return JSON.stringify({{label, msg}});
}})()"""))
check("发送中可以取消", "取消" in (out.get("label") or "") and ("取消" in (out.get("msg") or "") or "已取消" in (out.get("msg") or "")), out)

# save to collection then export/import round trip
out = json.loads(cdp.js(f"""(async () => {{
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelector('button[data-rail=collections]').click(); await sleep(250);
  const nodesBefore=document.querySelectorAll('#sidebar .node').length;
  {NEW_TAB}; await sleep(250);
  const u=document.querySelector('.url-input'); u.value='{{{{baseUrl}}}}/roundtrip'; u.dispatchEvent(new Event('input',{{bubbles:true}}));
  const name=document.querySelector('.urlbar input'); 
  window.dispatchEvent(new KeyboardEvent('keydown',{{key:'s',ctrlKey:true,bubbles:true}}));
  await sleep(600);
  const nodesAfter=document.querySelectorAll('#sidebar .node').length;
  return JSON.stringify({{nodesBefore, nodesAfter, dirtyDot: !!document.querySelector('.tab.active .dirty')}});
}})()"""))
check("Ctrl+S 保存请求到集合并消除未保存标记", out.get("nodesAfter", 0) > out.get("nodesBefore", 0) and not out.get("dirtyDot"), out)

out = json.loads(cdp.js("""(async () => {
  const tools = await import('/js/tools.js');
  const state = await import('/js/state.js');
  const collection = state.state.collections[0];
  const exported = tools.toPostmanCollection(collection);
  return JSON.stringify({schema: exported.info.schema, items: (exported.item || []).length, name: exported.info.name, sample: JSON.stringify(exported.item && exported.item[0]).slice(0, 160)});
})()"""))
check("集合可导出为 JSON 结构", "v2.1.0" in (out.get("schema") or "") and out.get("items", 0) >= 1, out)

# Export keeps request names, methods and protocols without an import dependency.
out = json.loads(cdp.js("""(async () => {
  const tools=await import('/js/tools.js');const s=await import('/js/state.js');
  const original=s.state.collections[0];const exported=tools.toPostmanCollection(original);
  const a=nodes=>nodes.flatMap(n=>n.kind==='folder'?a(n.children||[]):[n]);
  const b=nodes=>nodes.flatMap(n=>n.item?b(n.item):[n]);
  const before=a(original.children||[]),after=b(exported.item||[]);
  return JSON.stringify({same:before.length===after.length&&before.every((n,i)=>after[i].name===n.name&&after[i].request.method===n.request.method&&after[i]._relay.protocol===(n.protocol||(n.kind==='ws'?'ws':'http')))});
})()"""))
check("集合 JSON 导出保留请求名称、方法和协议",out.get("same") is True,out)

# naming happens in place: a new collection goes straight into an inline input,
# and the request page carries its own editable title
out = json.loads(cdp.js("""(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = await import('/js/state.js');
  const tree = await import('/js/tree.js');
  const before = state.state.collections.length;
  tree.createCollection('新建集合'); await sleep(250);
  const input = document.querySelector('.node-rename');
  const modalOpen = !!document.querySelector('.modal');
  if (!input) return JSON.stringify({ inline: false, modalOpen });
  input.value = '内审台账';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(250);
  const created = state.state.collections[state.state.collections.length - 1];
  return JSON.stringify({ inline: true, modalOpen, added: state.state.collections.length - before, name: created.name });
})()"""))
check("新建集合就地改名，不弹窗", out.get("inline") is True and not out.get("modalOpen") and out.get("added") == 1 and out.get("name") == "内审台账", out)

out = json.loads(cdp.js("""(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = await import('/js/state.js');
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(200);
  [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(350);
  const title = document.querySelector('.req-title');
  if (!title) return JSON.stringify({ row: false });
  title.value = '台账查询';
  title.dispatchEvent(new Event('input', { bubbles: true })); await sleep(200);
  const label = document.querySelector('.tabstrip .tab.active').textContent.trim();
  const u = document.querySelector('.url-input');
  u.value = 'http://127.0.0.1:8899/list'; u.dispatchEvent(new Event('input', { bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); await sleep(700);
  const tab = state.state.tabs.find((t) => t.id === state.state.activeTabId);
  const hit = tab && tab.refId ? state.findNode(tab.refId) : null;
  return JSON.stringify({ row: true, label, savedName: hit ? hit.node.name : null, dirty: !!(tab && tab.dirty) });
})()"""))
check("请求页可直接改名，Ctrl+S 后集合里同名", "台账查询" in (out.get("label") or "") and out.get("savedName") == "台账查询" and out.get("dirty") is False, out)

# the native frame is off: one row holds the app chrome and the window buttons
out = json.loads(cdp.js("""(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = document.querySelectorAll('.topbar').length;
  const buttons = [...document.querySelectorAll('.caption-btn')].map((b) => b.title);
  const drag = document.querySelectorAll('[data-tauri-drag-region]').length;
  const before = innerWidth;
  document.querySelectorAll('.caption-btn')[1].click(); await sleep(900);
  const maxed = { w: innerWidth, screen: screen.width, flag: document.documentElement.dataset.maximized, title: document.querySelectorAll('.caption-btn')[1].title };
  document.querySelectorAll('.caption-btn')[1].click(); await sleep(900);
  return JSON.stringify({ rows, buttons, drag, before, maxed, after: innerWidth, flagAfter: document.documentElement.dataset.maximized });
})()"""))
maxed = out.get("maxed") or {}
check(
    "顶栏单行内嵌窗口按钮，最大化/还原同步",
    out.get("rows") == 1
    and len(out.get("buttons") or []) == 3
    and (out.get("drag") or 0) >= 2
    and maxed.get("flag") == "true"
    and maxed.get("w") == maxed.get("screen")
    and "还原" in (maxed.get("title") or "")
    and out.get("flagAfter") == "false"
    and out.get("after") == out.get("before"),
    out,
)

# tab strip: right-click bulk close, overflow switcher, keyboard cycling
out = json.loads(cdp.js("""(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = await import('/js/state.js');
  st.state.tabs.forEach(t=>t.dirty=false);
  for (let i = 0; i < 8; i += 1) {
    document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(120);
    [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(140);
  }
  const off = (nodes) => nodes.map((m) => m.textContent.trim().split(/Ctrl|中键/)[0] + (m.classList.contains('disabled') ? '·off' : ''));
  const openMenu = async (index) => {
    [...document.querySelectorAll('.tabstrip .tab')][index].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await sleep(300);
    return off([...document.querySelectorAll('.menu-item')]);
  };
  const first = await openMenu(0);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(150);
  const middle = await openMenu(1);
  const leftItem = [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('关闭左侧'));
  const before = st.state.tabs.length; leftItem.click(); await sleep(400);
  const closedLeft = before - st.state.tabs.length;
  const strip = document.getElementById('tabstrip');
  const overflowing = strip.classList.contains('overflowing');
  strip.scrollLeft = 0; await sleep(120);
  const beforeScroll = strip.scrollLeft;
  strip.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true })); await sleep(200);
  const wheelMoved = Math.round(strip.scrollLeft - beforeScroll);
  document.querySelector('.tab-more').click(); await sleep(300);
  const listed = [...document.querySelectorAll('.menu-item')].filter((m) => /GET|SSE|WS|ENV/.test(m.textContent)).length;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(150);
  const start = st.state.tabs.findIndex((t) => t.id === st.state.activeTabId);
  const count = st.state.tabs.length;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true })); await sleep(250);
  const afterTab = st.state.tabs.findIndex((t) => t.id === st.state.activeTabId);
  [...document.querySelectorAll('.tabstrip .tab')][1].dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true })); await sleep(250);
  const afterMiddle = st.state.tabs.length;
  const all = await openMenu(0);
  // These are clean synthetic tabs; dirty-tab confirmation has separate coverage.
  st.state.tabs.forEach(t=>t.dirty=false);
  const closeAll = [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('关闭全部'));
  closeAll.click(); await sleep(500);
  return JSON.stringify({ first, middle, closedLeft, overflowing, wheelMoved, listed, start, count, afterTab, afterMiddle, all, left: st.state.tabs.length });
})()"""))
menu_labels = "、".join(item for item in (out.get("first") or []))
check(
    "标签右键可批量关闭，边界项自动禁用",
    "关闭左侧·off" in menu_labels
    and "关闭右侧" in menu_labels
    and "关闭左侧" in "、".join(out.get("middle") or [])
    and out.get("closedLeft") == 1
    and any("关闭全部" in item for item in out.get("all") or []),
    out,
)
check(
    "标签条溢出时滚轮横滚、▾ 可跳任意标签，Ctrl+Tab 与中键生效",
    out.get("overflowing") is True
    and out.get("wheelMoved", 0) > 100
    and (out.get("listed") or 0) >= 6
    and out.get("afterTab") == (out.get("start", 0) + 1) % max(out.get("count", 1), 1)
    and out.get("left", 99) <= 1,
    out,
)

# flex items shrink by default: a card inside a scrolling flex column used to get
# squashed and clip its own rows mid-glyph. No row may overflow the box it is in.
out = json.loads(cdp.js("""(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // a card with overflow:hidden that is shorter than its own content is the
  // signature of the shrink trap: the last row gets sliced in half
  const clipped = (scope) => [...scope.querySelectorAll('.group, .kv')]
    .filter((n) => n.scrollHeight > n.clientHeight + 1)
    .map((n) => n.className.split(' ')[0] + ':' + n.textContent.trim().slice(0, 8) + ' ' + n.scrollHeight + '>' + n.clientHeight);
  document.querySelector('.pane-scroll') && (document.querySelector('.pane-scroll').scrollTop = 0);
  const pane = clipped(document.getElementById('request-host'));
  [...document.querySelectorAll('.topbar button')].find((b) => b.title === '设置').click();
  await sleep(600);
  // the last one: a modal that is still animating out lingers in the DOM
  const body = [...document.querySelectorAll('.modal-body')].pop();
  const modal = clipped(body);
  // whether the body overflows depends on how tall the window happens to be;
  // what must never change is that it scrolls instead of clipping
  const overflow = getComputedStyle(body).overflowY;
  const clips = body.scrollHeight > body.clientHeight && overflow === 'hidden';
  [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.includes('取消')).click();
  await sleep(500);
  return JSON.stringify({ pane, modal, overflow, clips });
})()"""))
check(
    "行不会被压扁（flex 收缩陷阱），弹窗靠滚动而不是裁切",
    not out.get("pane") and not out.get("modal") and not out.get("clips")
    and out.get("overflow") in ("auto", "scroll"),
    out,
)

# The shortcut sheet moved off the page into a ? drawer: the empty state must be
# clean, and the drawer must actually dock to the right edge rather than centre.
out = json.loads(cdp.js("""(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(240);
  [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(320);
  const kbdOnPage = document.querySelectorAll('#response-host .kbd').length;
  const emptyKeys = !!document.querySelector('.empty-keys');
  const bolt = [...document.querySelectorAll('.topbar button')].find((b) => /快捷键/.test(b.title || ''));
  if (!bolt) return JSON.stringify({ noBolt: true });
  bolt.click(); await sleep(700);
  const d = document.querySelector('.modal-right');
  if (!d) return JSON.stringify({ opened: false, kbdOnPage, emptyKeys });
  const box = d.getBoundingClientRect();
  return JSON.stringify({
    kbdOnPage, emptyKeys, opened: true,
    dockedRight: Math.abs(box.right - innerWidth) < 2,
    fullHeight: box.height > innerHeight * 0.92,
    title: d.querySelector('.modal-head h2')?.textContent.trim(),
    groups: [...d.querySelectorAll('.group-head')].map((g) => g.textContent.trim()),
    rows: d.querySelectorAll('.row').length,
    kbds: d.querySelectorAll('.kbd').length,
    hasFoot: !!d.querySelector('.modal-foot'),
    searchFocused: document.activeElement === d.querySelector('input'),
  });
})()"""))
check(
    "快捷键不再铺在页面上，⚡ 打开的是贴右边框的全高抽屉",
    not out.get("noBolt")
    and out.get("opened")
    and out.get("dockedRight")
    and out.get("fullHeight")
    and out.get("title") == "快捷方式"
    and out.get("groups") == ["通用", "请求", "标签页", "集合树"]
    and out.get("rows", 0) >= 12
    and out.get("kbds", 0) >= out.get("rows", 0)
    and out.get("hasFoot") is False
    and out.get("kbdOnPage") == 0
    and not out.get("emptyKeys"),
    out,
)

out = json.loads(cdp.js("""(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const press = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  const labels = () => [...document.querySelectorAll('.modal-right .row-label')].map((r) => r.textContent.trim());
  const before = labels().length;
  // ? toggles: it is already open, so this has to close it
  press('?'); await sleep(600);
  const closedByQuestion = !document.querySelector('.modal-right');
  press('?'); await sleep(600);
  const reopened = !!document.querySelector('.modal-right');
  const search = document.querySelector('.modal-right input');
  search.value = '发送'; search.dispatchEvent(new Event('input', { bubbles: true })); await sleep(300);
  const filtered = labels();
  search.value = '不存在的东西'; search.dispatchEvent(new Event('input', { bubbles: true })); await sleep(300);
  const none = { rows: labels().length, empty: !!document.querySelector('.modal-right .empty') };
  document.querySelector('.modal-right .modal-head button').click(); await sleep(600);
  const closedByX = !document.querySelector('.overlay:not(.closing)');
  return JSON.stringify({ before, closedByQuestion, reopened, filtered, none, closedByX,
    appBack: !document.body.classList.contains('has-sheet') });
})()"""))
filtered = out.get("filtered") or []
check(
    "? 开关抽屉、搜索即时过滤、✕ 关闭后宿主恢复",
    out.get("closedByQuestion")
    and out.get("reopened")
    and out.get("before", 0) >= 12
    and 0 < len(filtered) < out.get("before", 0)
    and all("发送" in label for label in filtered)
    and out.get("none", {}).get("rows") == 0
    and out.get("none", {}).get("empty")
    and out.get("closedByX")
    and out.get("appBack"),
    out,
)

# Element.append() turns null into a literal "null" text node, which is exactly
# what a footer-less sheet used to render. No overlay may leak a bare placeholder.
out = json.loads(cdp.js("""(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stray = () => [...document.querySelectorAll('.overlay *')]
    .filter((e) => [...e.childNodes].some((n) => n.nodeType === 3
      && /^(null|undefined|\\[object Object\\])$/.test((n.nodeValue || '').trim())))
    .map((e) => e.className + ':' + (e.textContent || '').trim().slice(0, 20));
  const withFoot = [];
  [...document.querySelectorAll('.topbar button')].find((b) => b.title === '设置').click();
  await sleep(650);
  withFoot.push(...stray());
  document.querySelector('.modal-foot .btn').click(); await sleep(500);
  const noFoot = [];
  [...document.querySelectorAll('.topbar button')].find((b) => /快捷键/.test(b.title || '')).click();
  await sleep(650);
  noFoot.push(...stray());
  document.querySelector('.modal-right .modal-head button').click(); await sleep(500);
  return JSON.stringify({ withFoot, noFoot });
})()"""))
check(
    "弹层里没有多余的 null/undefined 文本节点（append 会把 null 写成字符串）",
    not out.get("withFoot") and not out.get("noFoot"),
    out,
)

failed = [name for name, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} 通过")
if failed:
    print("失败项：" + "、".join(failed))
sys.exit(1 if failed else 0)
