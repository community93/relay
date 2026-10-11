"""The surfaces no suite had ever touched.

Chosen by walking the UI and asking "has a test ever clicked this?" — drag
handles, scroll memory, the WS and SSE control rows, the palette's commands, the
three ways a sheet can close, destructive confirms and their reject branch, tree
menus, and the keyboard contract including whether the shortcut drawer still
matches what `onKey` actually binds.

    python tests/e2e_surfaces.py [cdp-port]
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import BASE, Harness  # noqa: E402

h = Harness(label="surfaces")


def fresh_http_tab(url=None):
    h.js("""(() => {
      document.querySelectorAll('.overlay').forEach((o) => o.remove());
      document.body.classList.remove('has-sheet'); delete document.body.dataset.sheets;
      document.querySelectorAll('.menu').forEach((m) => m.remove());
    })()""")
    h.js("document.querySelectorAll('.tabstrip .tab-new')[0].click()")
    time.sleep(0.35)
    h.js("[...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('HTTP')).click()")
    time.sleep(0.5)
    if url:
        h.js("""(() => { const u=document.querySelector('.url-input');
          u.value=%s; u.dispatchEvent(new Event('input',{bubbles:true})); })()""" % json.dumps(url))
        time.sleep(0.2)


def send_current(url=None, wait=1600):
    if url:
        h.js("""(() => { const u=document.querySelector('.url-input');
          u.value=%s; u.dispatchEvent(new Event('input',{bubbles:true})); })()""" % json.dumps(url))
        time.sleep(0.2)
    h.js("[...document.querySelectorAll('.urlbar button')].find(b=>/发送|发送/.test(b.textContent)).click()")
    time.sleep(wait / 1000.0)


# ================= drag handles =================
fresh_http_tab(BASE + "/list")
send_current()

before = h.js("document.getElementById('request-host').style.flex")
d = h.box("#divider")
h.drag(d["x"], d["y"], d["x"], d["y"] - 220)
after = h.js("document.getElementById('request-host').style.flex")
clean = h.js("""JSON.stringify({ dragging: document.getElementById('divider').classList.contains('dragging'),
  select: document.body.style.userSelect || null })""")
h.check("上下分隔条可以拖动，松手后 dragging 与文本禁选都清掉",
        after != before and json.loads(clean)["dragging"] is False and json.loads(clean)["select"] is None,
        {"before": before, "after": after, "afterRelease": json.loads(clean)})

d = h.box("#divider")
h.drag(d["x"], d["y"], d["x"], d["y"] + 4000)
clamped = float(h.js("parseFloat(document.getElementById('request-host').style.flex)"))
h.check("分隔条拖出窗口会被夹在 18–82% 之间，不会把某一侧压没",
        17.5 <= clamped <= 82.5, {"ratio": clamped})

h.js("""document.getElementById('divider').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))""")
time.sleep(0.3)
h.check("双击分隔条回到 47/53",
        h.js("document.getElementById('request-host').style.flex").startswith("47"),
        h.js("document.getElementById('request-host').style.flex"))

side_before = h.js("getComputedStyle(document.documentElement).getPropertyValue('--sidebar')")
r = h.box("#col-resizer")
h.drag(r["x"], r["y"], r["x"] + 120, r["y"])
side_after = h.js("getComputedStyle(document.documentElement).getPropertyValue('--sidebar')")
persisted = h.js("(async()=>{const s=await import('/js/state.js');return String(s.state.settings.sidebarWidth)})()")
h.check("侧栏把手可以拖动并写入设置",
        side_before != side_after and persisted not in ("None", "undefined"),
        {"before": side_before.strip(), "after": side_after.strip(), "saved": persisted})

r = h.box("#col-resizer")
h.drag(r["x"], r["y"], r["x"] - 900, r["y"])
clamped_w = h.js("getComputedStyle(document.documentElement).getPropertyValue('--sidebar')")
h.check("侧栏拖过头会被夹在 200–520px",
        195 <= float(clamped_w.strip().replace("px", "")) <= 525, clamped_w.strip())

h.js("""document.getElementById('col-resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))""")
time.sleep(0.3)
h.check("双击侧栏把手回到默认 272px",
        "272" in h.js("getComputedStyle(document.documentElement).getPropertyValue('--sidebar')"),
        h.js("getComputedStyle(document.documentElement).getPropertyValue('--sidebar')"))

# ================= scroll position is remembered per tab =================
fresh_http_tab(BASE + "/list")
send_current()
scrolled = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const b=[...document.querySelectorAll('.code-bar .seg button')].find(x=>x.textContent.trim()==='树'); b.click(); await s(400);
  const e=[...document.querySelectorAll('.response-body button')].find(x=>x.textContent.trim()==='全部展开'); e.click(); await s(400);
  const scroller=[...document.querySelectorAll('#response-host .response-content, #response-host .pane-scroll, #response-host .doc-scroll, .response-body')]
    .find(n => n.scrollHeight > n.clientHeight + 4);
  if (!scroller) return JSON.stringify({ scrollable: false });
  scroller.scrollTop = 200; await s(300);
  return JSON.stringify({ scrollable: true, top: Math.round(scroller.scrollTop) });
})()""")
if scrolled.get("scrollable"):
    # remember WHICH tab we scrolled — by this point several tabs have responses,
    # and looking one up by "has a response" finds the wrong one
    origin = h.js("(async()=>{const s=await import('/js/state.js');return s.state.activeTabId})()")
    index = h.js("""(async () => {
      const s = await import('/js/state.js');
      return String(s.state.tabs.findIndex((t) => t.id === %s));
    })()""" % json.dumps(origin))
    h.js("document.querySelectorAll('.tabstrip .tab-new')[0].click()")
    time.sleep(0.45)
    h.js("[...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('HTTP')).click()")
    time.sleep(0.55)
    h.js("document.querySelectorAll('.tabstrip .tab')[%s].click()" % index)
    time.sleep(0.9)
    restored = h.eval_json("""(async () => {
      const st = await import('/js/state.js');
      const tab = st.state.tabs.find(t => t.id === %s);
      const scroller=[...document.querySelectorAll('#response-host .response-content, #response-host .pane-scroll, #response-host .doc-scroll, .response-body')]
        .find(n => n.scrollHeight > n.clientHeight + 4);
      return JSON.stringify({ recorded: Math.round(tab ? tab._responseTop || 0 : -1),
        domTop: scroller ? Math.round(scroller.scrollTop) : -1,
        activeIsOrigin: st.state.activeTabId === %s });
    })()""" % (json.dumps(origin), json.dumps(origin)))
    h.check("切走再切回标签页，响应区滚动位置还在原处",
            restored.get("activeIsOrigin") and restored.get("recorded", 0) > 0
            and restored.get("domTop") == restored.get("recorded"),
            {"scrolledTo": scrolled.get("top"), **restored})
else:
    h.check("切走再切回标签页，响应区滚动位置还在原处", False, scrolled)

# ================= response: Cookies / binary / search / collapse =================
fresh_http_tab(BASE + "/login")
send_current()
h.click_subtab("#response-host", "Cookies")
cookies = h.eval_json("""(() => {
  const rows = [...document.querySelectorAll('#response-host .kv-row, #response-host .cookie-row, #response-host .row')];
  return JSON.stringify({ lit: [...document.querySelectorAll('#response-host .subtab')]
    .find(b => b.textContent.trim().startsWith('Cookies')).classList.contains('on'),
    text: (document.querySelector('#response-host .pane') || {}).textContent ? document.querySelector('#response-host .pane').textContent.replace(/\\s+/g,' ').trim().slice(0,60) : null });
})()""")
h.check("响应 Cookies 子标签可以打开并列出 Set-Cookie 进来的那条",
        cookies.get("lit") and "session" in (cookies.get("text") or ""),
        cookies)

fresh_http_tab(BASE + "/bin")
send_current()
binary = h.eval_json("""(() => {
  const btns = [...document.querySelectorAll('#response-host button')].map(b => b.textContent.trim());
  return JSON.stringify({ btns });
})()""")
h.check("二进制响应给出下载与 Base64 预览两个出口",
        any("下载" in b for b in binary.get("btns", [])) and any("Base64" in b for b in binary.get("btns", [])),
        binary)
b64 = h.click_where("#response-host button", "Base64", exact=False)
h.check("点 Base64 预览就地换掉正文，不弹新窗口也不报错",
        not b64.get("clickDidNotLand") and not h.console_errors(),
        {"text": h.js("(document.querySelector('.response-body')||{}).textContent ? document.querySelector('.response-body').textContent.trim().slice(0,40) : 'none'")})

fresh_http_tab(BASE + "/list")
send_current()
search = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const box=document.querySelector('.code-bar input'); if(!box) return JSON.stringify({noBox:true});
  box.value='上海'; box.dispatchEvent(new Event('input',{bubbles:true})); await s(500);
  // Assert on the resolved colour, not a literal: this test used to grep for the
  // exact rgba the highlight was painted with, so moving that value onto the
  // --mark token made a working feature read as broken.
  const host=document.querySelector('.response-body');
  const nums=(c)=>c.replace('rgba','').replace('rgb','').replace('(','').replace(')','').split(',');
  const alpha=(c)=>{const n=nums(c);return n.length<4?1:parseFloat(n[3]);};
  const behind=host?getComputedStyle(host).backgroundColor:'';
  const marks=[...document.querySelectorAll('.response-body .mark')].filter(n=>{
    const c=getComputedStyle(n).backgroundColor;
    return alpha(c)>0 && c!==behind;
  });
  return JSON.stringify({ marks: marks.length, sample: marks.length ? marks[0].textContent : null });
})()""")
h.check("在响应里搜索会高亮命中处", search.get("marks", 0) >= 1 and "上海" in (search.get("sample") or ""), search)

collapse = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const t=[...document.querySelectorAll('.code-bar .seg button')].find(x=>x.textContent.trim()==='树'); t.click(); await s(400);
  const openCount=()=>[...document.querySelectorAll('.response-body .twist')]
    .filter(x => x.textContent.trim()==='▾').length;
  const closedCount=()=>[...document.querySelectorAll('.response-body .twist')]
    .filter(x => x.textContent.trim()==='▸').length;
  const beforeOpen=openCount();
  const ex=[...document.querySelectorAll('.response-body button')].find(x=>x.textContent.trim()==='全部展开'); ex.click(); await s(350);
  const wide=openCount();
  const co=[...document.querySelectorAll('.response-body button')].find(x=>x.textContent.trim()==='全部收起'); co.click(); await s(350);
  return JSON.stringify({ beforeOpen, wide, narrowOpen: openCount(), narrowClosed: closedCount() });
})()""")
h.check("JSON 树全部展开 / 全部收起都生效（按 ▾/▸ 计数，不是按行数）",
        collapse.get("wide", 0) > collapse.get("narrowOpen", 99) and collapse.get("narrowOpen") == 0
        and collapse.get("narrowClosed", 0) >= 1,
        collapse)

invalid = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const u=document.querySelector('.url-input');
  u.value='%s/hello'; u.dispatchEvent(new Event('input',{bubbles:true})); await s(120);
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click(); await s(1500);
  const t=[...document.querySelectorAll('.code-bar .seg button')].find(x=>x.textContent.trim()==='树');
  if(!t) return JSON.stringify({ noTreeOption: true, segs:[...document.querySelectorAll('.code-bar .seg button')].map(b=>b.textContent.trim()) });
  t.click(); await s(400);
  return JSON.stringify({ text: document.querySelector('.response-body').textContent.replace(/\\s+/g,' ').trim().slice(0,60) });
})()""" % BASE)
h.check("非 JSON 响应不给出「树」这一档，而不是点开后报错",
        invalid.get("noTreeOption") or "无法展开" not in (invalid.get("text") or ""), invalid)

# ================= SSE controls =================
h.js("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await s(250);
  [...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('SSE')).click(); await s(400);
  const u=document.querySelector('.url-input'); u.value='%s/sse'; u.dispatchEvent(new Event('input',{bubbles:true})); await s(150);
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('连接')).click(); await s(1200);
})()""" % BASE)
# The SSE view (事件/原始流/Headers) is rendered into #response-host, so scoping
# these to #request-host would silently drive the *request* Headers editor instead.
sse = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const scope='#response-host';
  const events=document.querySelectorAll('.event').length;
  const clear=[...document.querySelectorAll(scope+' button, #request-host button')].find(b=>b.textContent.trim()==='清空显示');
  if (clear) { clear.click(); await s(400); }
  const afterClear=document.querySelectorAll('.event').length;
  const hdr=[...document.querySelectorAll(scope+' .subtab')].find(b=>b.textContent.trim().startsWith('Headers'));
  if (hdr) { hdr.click(); await s(450); }
  const table=document.querySelector(scope+' .response-body table.table');
  const rows=table?[...table.querySelectorAll('tbody tr')].map(r=>r.textContent.replace(/\\s+/g,' ').trim()):[];
  const back=[...document.querySelectorAll(scope+' .subtab')].find(b=>b.textContent.trim().startsWith('事件'));
  if (back) { back.click(); await s(300); }
  return JSON.stringify({ events, afterClear, rows });
})()""")
h.check("SSE：清空会清掉事件流",
        sse.get("events", 0) >= 3 and sse.get("afterClear") == 0, sse)
h.check("SSE 的 Headers 子标签列出真正的握手响应头",
        any("event-stream" in r.lower() or "content-type" in r.lower() for r in sse.get("rows", [])),
        {"rows": sse.get("rows")})

# /sse closes on its own after a second or two, so the live 断开 state has to be
# caught on a stream that is still holding its first byte
h.js("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await s(250);
  [...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('SSE')).click(); await s(400);
  const u=document.querySelector('.url-input'); u.value='%s/slow'; u.dispatchEvent(new Event('input',{bubbles:true})); await s(150);
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('连接')).click(); await s(700);
})()""" % BASE)
disc = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const live=[...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.trim()==='断开');
  if(!live) return JSON.stringify({ notLive: [...document.querySelectorAll('.urlbar button')].map(b=>b.textContent.trim()) });
  live.click(); await s(700);
  return JSON.stringify({ back: [...document.querySelectorAll('.urlbar button')].map(b=>b.textContent.trim()) });
})()""")
h.check("流式进行中可以断开，断开后按钮回到「连接」",
        any("连接" in t for t in disc.get("back", [])) and not disc.get("notLive"), disc)

fmt = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  // the frame format describes the stream, so it lives in the stream's own head
  // row, not in the composer — the composer's geometry must not depend on protocol
  const cands=[...document.querySelectorAll('.response-head .select-field, .urlbar .select-field')];
  const sel=cands.find(x=>['auto','sse','ndjson','text'].includes(x.dataset.value)) || cands[0];
  if(!sel) return JSON.stringify({missing:true, seen:cands.length});
  sel.click(); await s(240);
  const rows=[...document.querySelectorAll('.menu .menu-item')];
  const opts=rows.map(o=>o.textContent.trim());
  const row=rows.find(o=>/NDJSON/i.test(o.textContent));
  if(row) row.click();
  await s(320);
  return JSON.stringify({ opts, now: sel.dataset.value, closed: !document.querySelector('.menu') });
})()""")
h.check("SSE 流帧格式四选一可选且切换生效",
        not fmt.get("missing") and len(fmt.get("opts", [])) == 4
        and fmt.get("now") == "ndjson" and fmt.get("closed"), fmt)

# ================= WS pane =================
h.js("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await s(250);
  [...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('WebSocket')).click(); await s(500);
})()""")
ws_subtabs = json.loads(h.js("""JSON.stringify([...document.querySelectorAll('#request-host .subtab')].map(b=>b.textContent.trim()))"""))
h.check("WS 有消息流 / 握手 Headers / Query 参数 / Auth / 设置 五个子标签",
        len(ws_subtabs) == 5 and any("消息" in t for t in ws_subtabs) and 'Auth' in ws_subtabs and any("设置" in t for t in ws_subtabs),
        ws_subtabs)

for label in ws_subtabs:
    landed = h.click_subtab("#request-host", label.split(" ")[0])
    if landed.get("clickDidNotLand"):
        break
    time.sleep(0.35)
h.check("WS 五个子标签逐个点开都不报错", not h.console_errors(), h.console_errors()[:2])

# back to the message stream — the send button only lives there, and the loop
# above left the pane on 设置
h.click_subtab("#request-host", "消息")
send_state = h.eval_json("""(() => {
  const b=[...document.querySelectorAll('#request-host button')].find(x=>x.textContent.trim()==='发送');
  return JSON.stringify({ exists: !!b, disabled: b ? b.disabled : null,
    present: [...document.querySelectorAll('#request-host button')].map(x=>x.textContent.trim()) });
})()""")
h.check("未连接时 WS 的「发送」是禁用状态", send_state.get("exists") and send_state.get("disabled") is True, send_state)

h.js("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const set=[...document.querySelectorAll('#request-host .subtab')].find(b=>b.textContent.trim().startsWith('设置')); set.click(); await s(350);
  const hb=[...document.querySelectorAll('#request-host button')].find(b=>/心跳/.test(b.textContent));
  if (hb) { const num=[...document.querySelectorAll('#request-host input')].find(i=>i.type==='number'); if(num){num.value='0'; num.dispatchEvent(new Event('input',{bubbles:true}));} hb.click(); }
  await s(400);
  return 1;
})()""")
heartbeat = h.eval_json("""(async () => {
  const {activeTab}=await import('/js/state.js');
  const button=[...document.querySelectorAll('#request-host button')].find(b=>/心跳/.test(b.textContent));
  return JSON.stringify({disabled:!!button?.disabled,timer:!!activeTab().ws.pingTimer});
})()""")
h.check("未连接时心跳入口禁用且不启动定时器", heartbeat.get('disabled') and not heartbeat.get('timer'), heartbeat)

h.js("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const msgs=[...document.querySelectorAll('#request-host .subtab')].find(b=>b.textContent.trim().startsWith('消息')); msgs.click(); await s(300);
  const u=document.querySelector('.url-input'); u.value='ws://127.0.0.1:8900'; u.dispatchEvent(new Event('input',{bubbles:true})); await s(120);
  const c=[...document.querySelectorAll('.urlbar button')].find(b=>/连接/.test(b.textContent)); if(c) c.click(); await s(1600);
})()""")
ws_saved = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const save=[...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.trim()==='保存');
  if(!save) return JSON.stringify({noSave:true});
  save.click(); await s(700);
  const now=[...document.querySelectorAll('.urlbar button')].find(b=>/保存|已保存/.test(b.textContent));
  return JSON.stringify({ label: now ? now.textContent.trim() : null,
    toasts: [...document.querySelectorAll('.toast')].map(t=>t.textContent.trim()) });
})()""")
h.check("WS 保存成功后按钮翻成「已保存」（此前 refSaved 从未被写入）",
        ws_saved.get("label") == "已保存" or "请先创建一个集合" in json.dumps(ws_saved, ensure_ascii=False),
        ws_saved)

# ================= sheets: the three ways out =================
# `js()` hands back whatever the expression evaluated to, and a JS boolean arrives
# as the string 'true' — compare against that, or every check silently fails.
def flag(js_expr):
    return h.js("JSON.stringify(%s)" % js_expr) == "true"


fresh_http_tab()
h.js("[...document.querySelectorAll('.topbar button')].find(b=>b.title==='设置').click()")
time.sleep(0.6)
h.js("""(() => {
  const o = document.querySelector('.overlay');
  const r = o.getBoundingClientRect();
  o.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 3, clientY: r.height / 2 }));
})()""")
time.sleep(0.7)
h.check("点遮罩空白处可以关掉工作表",
        flag("!document.querySelector('.overlay:not(.closing)')"),
        {"stillOpen": h.js("document.querySelectorAll('.overlay:not(.closing)').length")})

h.js("[...document.querySelectorAll('.topbar button')].find(b=>b.title==='设置').click()")
time.sleep(0.6)
h.key("Escape")
time.sleep(0.7)
h.check("Escape 可以关掉工作表，且 has-sheet 计数归零",
        flag("!document.querySelector('.overlay:not(.closing)')") and not flag("document.body.classList.contains('has-sheet')"),
        {"closed": flag("!document.querySelector('.overlay:not(.closing)')"),
         "hasSheet": flag("document.body.classList.contains('has-sheet')")})

# ================= tree: rename cancel, folder, filter =================
h.js("document.querySelector('button[data-rail=collections]').click()")
time.sleep(0.4)
rename = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const node=document.querySelector('#sidebar .node-collection');
  node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})); await s(400);
  const item=[...document.querySelectorAll('.menu-item')].find(m=>m.textContent.trim()==='重命名');
  if(!item) return JSON.stringify({noRename:true});
  const nameBefore=(node.textContent||'').trim();
  item.click(); await s(400);
  const input=document.querySelector('#sidebar .node-rename');
  if(!input) return JSON.stringify({noInput:true});
  input.value='改成别的名字';
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  await s(500);
  return JSON.stringify({ nameBefore, nameAfter: (document.querySelector('#sidebar .node-collection').textContent||'').trim() });
})()""")
h.check("就地改名按 Esc 取消，不写回",
        rename.get("nameBefore") and rename.get("nameAfter")
        and rename["nameBefore"].startswith(rename["nameAfter"][:3])
        and "改成别的名字" not in (rename.get("nameAfter") or ""),
        rename)

filter = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const box=document.querySelector('#sidebar input'); if(!box) return JSON.stringify({noBox:true});
  const all=document.querySelectorAll('#sidebar .node').length;
  box.value='不存在的名字zzz'; box.dispatchEvent(new Event('input',{bubbles:true})); await s(400);
  const none=document.querySelectorAll('#sidebar .node').length;
  const emptyText=(document.querySelector('#sidebar')||{}).textContent||'';
  box.value=''; box.dispatchEvent(new Event('input',{bubbles:true})); await s(400);
  return JSON.stringify({ all, none, back: document.querySelectorAll('#sidebar .node').length,
    empty: /没有|无|匹配/.test(emptyText) });
})()""")
h.check("侧栏搜索能过滤、无命中给提示、清空后全部回来",
        filter.get("none", 99) < filter.get("all", 0) and filter.get("back") == filter.get("all"),
        filter)

# ================= palette: run commands, not just open it =================
ran = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const out={};
  const run=async (label)=>{
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true})); await s(400);
    const box=document.querySelector('.overlay input'); if(!box) return 'no palette';
    box.value=label; box.dispatchEvent(new Event('input',{bubbles:true})); await s(350);
    const items=[...document.querySelectorAll('.palette-item')];
    if(!items.length) return 'no match';
    const r=items[0].getBoundingClientRect();
    return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});
  };
  const p=await run('新建文档'); out.doc=p;
  return JSON.stringify(out);
})()""")
h.check("命令面板可以按名字找到命令", ran.get("doc") and ran["doc"].startswith("{"), ran)

# ================= keyboard contract, and does the drawer still tell the truth =================
keys = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const seen={};
  const press=async (key, ctrl, shift)=>{
    window.dispatchEvent(new KeyboardEvent('keydown',{key,ctrlKey:!!ctrl,shiftKey:!!shift,bubbles:true}));
    await s(350);
  };
  const tabs0=document.querySelectorAll('.tabstrip .tab').length;
  await press('n', true); seen.afterCtrlN=document.querySelectorAll('.tabstrip .tab').length;
  await press('N', true, true); seen.afterCtrlShiftN=document.querySelectorAll('.tabstrip .tab').length;
  await press('w', true); seen.afterCtrlW=document.querySelectorAll('.tabstrip .tab').length;
  seen.tabs0=tabs0;
  const theme0=document.documentElement.dataset.theme;
  await press('/', true); seen.themeFlipped=document.documentElement.dataset.theme!==theme0;
  const url=document.querySelector('.url-input'); if(url) url.blur();
  return JSON.stringify(seen);
})()""")
h.check("Ctrl+N / Ctrl+Shift+N / Ctrl+W 增减标签页，Ctrl+/ 翻主题",
        keys.get("afterCtrlN", 0) == keys.get("tabs0", 0) + 1
        and keys.get("afterCtrlShiftN", 0) == keys.get("afterCtrlN", 0) + 1
        and keys.get("afterCtrlW", 0) == keys.get("afterCtrlShiftN", 0) - 1
        and keys.get("themeFlipped") is True,
        keys)

drawer = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const tools=await import('/js/tools.js'); tools.openShortcuts(); await s(600);
  const rows=[...document.querySelectorAll('.modal-right .row')].map(r=>({
    what: r.querySelector('.row-label').textContent.trim(),
    keys: [...r.querySelectorAll('.kbd')].map(k=>k.textContent.trim()) }));
  tools.openShortcuts(); await s(500);
  return JSON.stringify(rows);
})()""")
advertised = {tuple(d["keys"]) for d in drawer} if isinstance(drawer, list) else set()
must_exist = [("Ctrl", "↵"), ("Ctrl", "K"), ("Ctrl", "I"), ("Ctrl", "/"), ("?",)]
h.check("快捷键抽屉列出的键与 onKey 实际绑定一致（防止文档与代码漂移）",
        isinstance(drawer, list) and len(drawer) >= 12
        and all(any(list(m) == list(d) for d in advertised) for m in must_exist),
        {"count": len(drawer) if isinstance(drawer, list) else None, "sample": sorted(map(str, advertised))[:6]})

# ================= status bar =================
fresh_http_tab(BASE + "/list")
send_current()
sb = h.eval_json("""(() => {
  const bar = document.getElementById('statusbar');
  if (!bar) return JSON.stringify({ missing: true });
  const txt = [...bar.querySelectorAll('.sb-item')].map(e => e.textContent.replace(/\\s+/g, ' ').trim());
  const env = bar.querySelector('.sb-item');
  const r = env.getBoundingClientRect();
  return JSON.stringify({ txt, height: Math.round(r.height), onScreen: r.bottom <= innerHeight + 1,
    rows: getComputedStyle(document.querySelector('.app')).gridTemplateRows.split(' ').length });
})()""")
h.check("底部状态栏报出环境、当前 URL 与上一次响应",
        not sb.get("missing") and sb.get("onScreen") and any("200 OK" in t for t in sb.get("txt", []))
        and any("8899" in t for t in sb.get("txt", [])) and any("环境" in t for t in sb.get("txt", [])),
        sb)

# clicking the env half of the bar must open the same switcher, not sit inert
sb_click = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const env=[...document.querySelectorAll('#statusbar .sb-item')][0];
  const r=env.getBoundingClientRect();
  return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
})()""")
h.mouse_at(sb_click["x"], sb_click["y"])
time.sleep(0.5)
h.check("状态栏的环境项是个入口，点它会开切换菜单",
        h.js("!!document.querySelector('.menu .menu-item')") == "true",
        h.js("JSON.stringify([...document.querySelectorAll('.menu .menu-item')].map(m=>m.textContent.trim()))"))
h.js("document.querySelectorAll('.menu').forEach(m=>m.remove())")
time.sleep(0.3)

# Every action toolbar in the app carries a glyph on each verb and puts the
# facts on the left, the verbs on the right. WS used to be three text-only
# buttons floating under a textarea, which read as unfinished next to the rest.
# open a WS tab and land on the message stream, so this measure stands alone
h.js("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await s(250);
  [...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('WebSocket')).click(); await s(500);
})()""")
time.sleep(0.4)
toolbar = h.eval_json("""(() => {
  // scoped to the action toolbars, not every .inline in the app
  const scopes = ['.response-head .btn-row', '.ws-out', '.code-bar'];
  const bare = [];
  for (const sel of scopes) {
    for (const b of document.querySelectorAll(sel)) {
      for (const btn of b.querySelectorAll('button.btn')) {
        if (!btn.querySelector('svg')) bare.push(sel + ' → ' + btn.textContent.trim().slice(0, 14));
      }
    }
  }
  const head = document.querySelector('#request-host .response-head');
  return JSON.stringify({
    bare,
    wsHead: !!head,
    headMeta: head ? [...head.querySelectorAll('.meta')].map(m => m.textContent.trim()) : [],
    headHasDot: !!(head && head.querySelector('.status-dot')),
    clearKeepsCounters: head ? /收|发/.test(head.textContent) : false,
  });
})()""")
h.check("WS 消息流有和 HTTP/SSE 同款的状态头（状态点 + 状态文字 + 右侧动作）",
        toolbar.get("wsHead") and toolbar.get("headHasDot") and bool(toolbar.get("headMeta")),
        {"meta": toolbar.get("headMeta")})
h.check("动作工具条里的按钮都带图标，没有裸文字按钮",
        not toolbar.get("bare"), {"bare": toolbar.get("bare")})

# the head used to freeze at "收 0 / 发 0": incoming frames append to the list
# without repainting the status line, so the totals quietly disagreed with reality
counters = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const u=document.querySelector('.url-input');
  u.value='ws://127.0.0.1:8900'; u.dispatchEvent(new Event('input',{bubbles:true})); await s(150);
  [...document.querySelectorAll('.urlbar button')].find(b=>/连接/.test(b.textContent)).click(); await s(1600);
  const before=(document.querySelector('#request-host .response-head .meta')||{}).textContent||'';
  const a=document.querySelector('.ws-out textarea');
  a.value='{"action":"ping"}'; a.dispatchEvent(new Event('input',{bubbles:true})); await s(200);
  [...document.querySelectorAll('.ws-out button')].find(b=>b.textContent.trim()==='发送').click();
  await s(1500);
  const after=(document.querySelector('#request-host .response-head .meta')||{}).textContent||'';
  return JSON.stringify({ before, after, events: document.querySelectorAll('.event').length,
    changed: before !== after });
})()""")
h.check("WS 状态头的收发计数会随每一帧更新，不是一动不动的 0",
        counters.get("changed") and counters.get("events", 0) >= 2
        and not counters.get("after", "").startswith("已连接 · 收 0 / 发 0"),
        counters)

# ================= tree multi-select + batch delete =================
fixture = h.eval_json("""(async () => {
  const s = await import('/js/state.js');
  const col = s.newCollection('批量删除测试');
  col.children = [];
  for (let i = 1; i <= 4; i++) {
    const n = s.newRequestNode('BD 请求 ' + i);
    n.request.url = '%s/hello';
    col.children.push(n);
  }
  s.state.collections.push(col);
  s.state.expanded[col.id] = true;
  s.state.selectedNodeIds = [];
  s.touch('collections');
  s.emit('tree');
  return JSON.stringify({ col: col.id, kids: col.children.map((c) => c.id) });
})()""" % BASE)
col_id, kids = fixture["col"], fixture["kids"]
row_sel = lambda node_id: '#sidebar .node[data-node="%s"]' % node_id
tabs_before = int(h.js("document.querySelectorAll('.tab').length"))

h.ctrl_click(row_sel(kids[0]))
h.ctrl_click(row_sel(kids[1]))
bar = h.eval_json("""(() => {
  const head = document.querySelector('.sidebar-head');
  return JSON.stringify({
    title: (head.querySelector('.sidebar-title') || {}).textContent,
    del: !!head.querySelector('.btn.danger'),
    stillHasNew: !!head.querySelector('.btn.primary'),
    picked: [...document.querySelectorAll('#sidebar .node.picked')].map((n) => n.dataset.node),
    boxesOn: document.querySelectorAll('#sidebar .pick-box.on').length,
    tabs: document.querySelectorAll('.tab').length });
})()""")
h.check("Ctrl+点两行进多选：头部换成「已选 2 项 + 删除」，两行有勾选圆盘且不开标签页",
        bar.get("title") == "已选 2 项" and bar.get("del") and not bar.get("stillHasNew")
        and bar.get("picked") == kids[:2] and bar.get("boxesOn") == 2
        and bar.get("tabs") == tabs_before, bar)

h.shift_click(row_sel(kids[3]))
ranged = h.eval_json("""(async () => { const s=await import('/js/state.js');
  return JSON.stringify({ ids: s.state.selectedNodeIds,
    title: (document.querySelector('.sidebar-title')||{}).textContent }); })()""")
h.check("Shift+点把可见的一串连选进来（含中间没点过的行）",
        ranged.get("title") == "已选 4 项" and set(ranged.get("ids", [])) == set(kids), ranged)

h.key("Escape")
cleared = h.eval_json("""(async () => { const s=await import('/js/state.js');
  const head=document.querySelector('.sidebar-head');
  return JSON.stringify({ n: s.state.selectedNodeIds.length,
    title: (head.querySelector('.sidebar-title')||{}).textContent,
    boxes: head.querySelectorAll('.pick-box').length }); })()""")
h.check("Esc 退出多选，侧栏头部换回「集合 + 新建」",
        cleared.get("n") == 0 and cleared.get("title") == "集合" and cleared.get("boxes") == 0, cleared)

h.key("a", ctrl=True)
allv = h.eval_json("""(async () => { const s=await import('/js/state.js');
  return JSON.stringify({ n: s.state.selectedNodeIds.length,
    rows: document.querySelectorAll('#sidebar .node').length }); })()""")
h.check("Ctrl+A 选中的正是当前可见的每一行（折叠起来的不会被扫进来）",
        allv.get("n") == allv.get("rows") and allv.get("rows") >= 6, allv)
h.key("Escape")

# a picked collection already contains its picked children, so the batch is one
# deletion, not two — and undo has to put it back exactly where it was
h.ctrl_click(row_sel(col_id))
h.ctrl_click(row_sel(kids[0]))
h.key("Delete")
time.sleep(0.5)
h.click('.modal-foot .btn.primary', timeout=0.9)
gone = h.eval_json("""(async () => { const s=await import('/js/state.js');
  return JSON.stringify({ stillThere: s.state.collections.some((c)=>c.id==='%s'),
    undo: [...document.querySelectorAll('.toast-act')].map((b)=>b.textContent.trim()) }); })()""" % col_id)
h.check("集合和它的子请求同时选中时只算一次删除，删完提示条上给撤销",
        not gone.get("stillThere") and gone.get("undo") == ["撤销"], gone)
h.click('.toast-act', timeout=0.7)
back = h.eval_json("""(async () => { const s=await import('/js/state.js');
  const col=s.state.collections.find((c)=>c.id==='%s');
  return JSON.stringify({ restored: !!col, index: s.state.collections.findIndex((c)=>c.id==='%s'),
    last: s.state.collections.length-1, kids: col?col.children.map((c)=>c.name):[] }); })()""" % (col_id, col_id))
h.check("撤销把集合放回原来的位置，四个子请求顺序不变",
        back.get("restored") and back.get("index") == back.get("last")
        and back.get("kids") == ["BD 请求 1", "BD 请求 2", "BD 请求 3", "BD 请求 4"], back)

# deleting something that is open must not leave a tab pretending it is saved
h.click(row_sel(kids[0]), timeout=0.8)
h.ctrl_click(row_sel(kids[1]))
h.key("Delete")
time.sleep(0.5)
h.click('.modal-foot .btn.primary', timeout=0.9)
orphan = h.eval_json("""(async () => { const s=await import('/js/state.js');
  const t=s.state.tabs.find((x)=>x.title && x.title.indexOf('BD 请求')===0);
  return JSON.stringify({ hasTab: !!t, refId: t?t.refId:null, dirty: t?t.dirty:null,
    left: (s.state.collections.find((c)=>c.id==='%s')||{children:[]}).children.map((c)=>c.name) }); })()""" % col_id)
h.check("删掉正开着的请求后，那个标签页变成未保存的副本而不是指向空气",
        orphan.get("hasTab") and orphan.get("refId") is None and orphan.get("dirty") is True
        and orphan.get("left") == ["BD 请求 3", "BD 请求 4"], orphan)

h.js("""(async () => { const s=await import('/js/state.js');
  const i=s.state.collections.findIndex((c)=>c.id==='%s');
  if (i>=0) s.state.collections.splice(i,1);
  s.state.selectedNodeIds=[]; s.touch('collections'); s.emit('tree'); return 1; })()""" % col_id)

# ================= environment name: two surfaces, one truth =================
# the reported bug: the list had no way to rename at all, and renaming on the
# right left the list showing the old name
env_setup = h.eval_json("""(async () => {
  const s = await import('/js/state.js');
  const e = s.newEnvironment('改名前');
  e.variables = [{ key: 'a', value: '1', enabled: true }];
  s.state.environments.push(e);
  s.state.settings.activeEnvironmentId = e.id;
  s.state.pane = 'environments';
  s.touch('environments'); s.touch('settings');
  s.emit('pane'); s.emit('environment');
  return JSON.stringify({ id: e.id, slot: (document.querySelector('#env-slot')||{}).textContent });
})()""")
env_id = env_setup["id"]
env_row = '#sidebar .node[data-env="%s"]' % env_id

h.double_click(env_row)
inline = h.eval_json("""(() => {
  const i = document.querySelector('#sidebar .env-rename');
  return JSON.stringify({ hasInput: !!i, focused: !!i && document.activeElement === i,
    value: i ? i.value : null, slot: (document.querySelector('#env-slot')||{}).textContent });
})()""")
h.check("双击环境行进入行内改名：输入框拿到焦点并带着现名",
        inline.get("hasInput") and inline.get("focused") and inline.get("value") == "改名前"
        and "改名前" in (inline.get("slot") or ""), inline)

h.type_into('#sidebar .env-rename', '改名后')
h.key("Enter")
renamed = h.eval_json("""(async () => { const s = await import('/js/state.js');
  const e = s.state.environments.find((x) => x.id === '%s');
  const rowEl = document.querySelector('#sidebar .node[data-env="%s"]');
  const name = rowEl && rowEl.querySelector('.name');
  return JSON.stringify({ name: e && e.name, shown: name && name.textContent,
    inputGone: !document.querySelector('#sidebar .env-rename'),
    slot: (document.querySelector('#env-slot')||{}).textContent }); })()""" % (env_id, env_id))
h.check("列表里回车改名：状态、行文字、顶栏切换器三处同时跟着变",
        renamed.get("name") == "改名后" and renamed.get("shown") == "改名后"
        and renamed.get("inputGone") and "改名后" in (renamed.get("slot") or ""), renamed)

h.click(env_row, timeout=0.8)
live = h.eval_json("""(async () => {
  const s = await import('/js/state.js');
  const i = document.querySelector('.env-name');
  if (!i) return JSON.stringify({ noInput: true });
  i.focus();
  i.value = '改名后·右侧';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const rowEl = document.querySelector('#sidebar .node[data-env="%s"]');
  const name = rowEl && rowEl.querySelector('.name');
  const tab = s.state.tabs.find((t) => t.kind === 'env' && t.refId === '%s');
  return JSON.stringify({ keptFocus: document.activeElement === i,
    row: name && name.textContent, tabTitle: tab && tab.title,
    slot: (document.querySelector('#env-slot')||{}).textContent });
})()""" % (env_id, env_id))
h.check("右侧改环境名，左侧列表 / 标签页标题 / 顶栏同步，且输入框不被重绘抢走焦点",
        not live.get("noInput") and live.get("keptFocus") and live.get("row") == "改名后·右侧"
        and live.get("tabTitle") == "改名后·右侧" and "改名后·右侧" in (live.get("slot") or ""), live)

h.js("""(async () => { const s = await import('/js/state.js');
  const i = s.state.environments.findIndex((x) => x.id === '%s');
  if (i >= 0) s.state.environments.splice(i, 1);
  s.state.settings.activeEnvironmentId = null;
  s.touch('environments'); s.touch('settings'); s.emit('environment');
  s.state.pane = 'collections'; s.emit('pane'); return 1; })()""" % env_id)

# ================= long param values =================
LONG_VALUE = "签名串-" + ("payload" * 12) + "\n第二段被换行挡住的内容"
fresh_http_tab(BASE + "/hello")
h.click_subtab("#request-host", "Params")
h.js("""(async () => {
  const st = await import('/js/state.js');
  const t = st.state.tabs.find((x) => x.id === st.state.activeTabId);
  t.draft.params = [{ key: 'blob', value: %s, enabled: true }];
  st.emit('rerender');
  return 1;
})()""" % json.dumps(LONG_VALUE, ensure_ascii=False))
time.sleep(0.6)
wrap = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const row=document.querySelector('#request-host .kv-rows .kv-row:not(.kv-head):not(.ghost)');
  const cell=row.querySelectorAll('.kv-cell')[2];
  const btn=cell.querySelector('.kv-wrap');
  const collapsed={ height: Math.round(row.getBoundingClientRect().height),
    control: cell.firstElementChild ? cell.firstElementChild.tagName.toLowerCase() : null,
    btnHidden: btn ? btn.hidden : null };
  if (btn) { btn.click(); await s(400); }
  const area=cell.querySelector('textarea.kv-value');
  const expanded={ height: Math.round(row.getBoundingClientRect().height),
    lines: area ? Math.round(area.getBoundingClientRect().height / parseFloat(getComputedStyle(area).lineHeight)) : 0,
    value: area ? area.value : null, btnText: cell.querySelector('.kv-wrap') ? cell.querySelector('.kv-wrap').textContent : null,
    cellText: cell.textContent.replace(/\\s+/g, ' ').trim().slice(0, 24) };
  // editing the wrapped value must land back on the model, not just on the box
  if (area) { area.focus(); area.value = area.value + '尾巴'; area.dispatchEvent(new Event('input', { bubbles: true })); await s(300); }
  const keptFocus = document.activeElement === area;
  const st=await import('/js/state.js');
  const tab=st.state.tabs.find((x)=>x.id===st.state.activeTabId);
  const model=tab.draft.params[0].value;
  // re-query: the collapse and the double-click have to act on whatever is live now
  const cell2=document.querySelector('#request-host .kv-rows .kv-row:not(.kv-head):not(.ghost) .kv-cell:nth-child(3)');
  const back=cell2.querySelector('.kv-wrap'); if (back) { back.click(); await s(350); }
  const input=cell2.querySelector('input');
  const collapsedAgain=!!input;
  if (input) { input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await s(350); }
  const reopened=!!cell2.querySelector('textarea.kv-value');
  return JSON.stringify({ collapsed, expanded, keptFocus, collapsedAgain,
    modelTail: model.slice(-8), reopened });
})()""" )
h.check("很长的参数值可以换成整行显示：单行装不下的行会长出「换行」按钮",
        wrap["collapsed"]["control"] == "input" and wrap["collapsed"]["btnHidden"] is False
        and wrap["collapsed"]["height"] <= 44, wrap["collapsed"])
h.check("展开后是同一段文字的多行编辑区，行高明显变高且内容一字不少",
        wrap["expanded"]["lines"] >= 3 and wrap["expanded"]["height"] > wrap["collapsed"]["height"] + 40
        and wrap["expanded"]["value"] == LONG_VALUE and wrap["expanded"]["btnText"] == "收起"
        and "null" not in wrap["expanded"]["cellText"],
        {"lines": wrap["expanded"]["lines"], "height": wrap["expanded"]["height"],
         "same": wrap["expanded"]["value"] == LONG_VALUE, "cellText": wrap["expanded"]["cellText"]})
h.check("多行区里改的字会写回请求参数、不抢焦点，收起后双击输入框还能再展开",
        wrap["modelTail"].endswith("尾巴") and wrap["keptFocus"] and wrap["collapsedAgain"]
        and wrap["reopened"], wrap)

# ================= SSE charset =================
# A stream that says GBK must read correctly with nobody asking…
h.js("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await s(250);
  [...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('SSE')).click(); await s(400);
  const u=document.querySelector('.url-input'); u.value='%s/sse-gbk'; u.dispatchEvent(new Event('input',{bubbles:true})); await s(150);
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('连接')).click(); await s(2000);
})()""" % BASE)
declared = h.eval_json("""(() => {
  const nodes=[...document.querySelectorAll('#response-host .event')];
  const joined=nodes.map((n)=>n.textContent).join(' | ');
  return JSON.stringify({ count: nodes.length,
    readable: joined.indexOf('\\ufffd') === -1 && joined.indexOf('事件 1 中文') !== -1,
    sample: joined.replace(/\\s+/g,' ').trim().slice(0,80) });
})()""")
h.check("声明了 charset=gbk 的 SSE 流，事件正文直接可读，不需要手动改码",
        declared.get("count", 0) >= 3 and declared.get("readable") is True, declared)

# …and one that lies about it can still be read by switching the raw view.
h.js("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await s(250);
  [...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('SSE')).click(); await s(400);
  const u=document.querySelector('.url-input'); u.value='%s/sse-gbk-nolabel'; u.dispatchEvent(new Event('input',{bubbles:true})); await s(150);
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('连接')).click(); await s(2000);
  const raw=[...document.querySelectorAll('#response-host .subtab')].find(b=>b.textContent.trim().startsWith('原始流'));
  if (raw) { raw.click(); await s(400); }
})()""" % BASE)
switched = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const hasBad=(t)=>t.indexOf('\\ufffd') !== -1;
  const shown=()=>[...document.querySelectorAll('#response-host .raw-text')].map((n)=>n.textContent).join('|');
  const before=shown();
  const sel=document.querySelector('.raw-charset');
  if (!sel) return JSON.stringify({ noSelector: true, beforeBad: hasBad(before) });
  sel.click(); await s(240);
  const rows=[...document.querySelectorAll('.menu .menu-item')];
  const options=rows.map((o)=>o.textContent.trim());
  const row=rows.find((o)=>o.getAttribute('data-value')==='gb18030');
  if (!row) return JSON.stringify({ noOption: true, options });
  row.click();
  await s(1200);
  const after=shown();
  return JSON.stringify({ disabled: sel.disabled, options, beforeBad: hasBad(before),
    afterBad: hasBad(after), afterReadable: after.indexOf('事件 1 中文') !== -1,
    beforeSample: before.slice(0,40), afterSample: after.slice(0,40) });
})()""")
h.check("原始流可以换码重解：未声明编码的 GBK 流选 GB18030 后立刻可读",
        not switched.get("noSelector") and not switched.get("disabled")
        and switched.get("beforeBad") is True and switched.get("afterReadable") is True
        and switched.get("afterBad") is False and any("GB18030" in o for o in switched.get("options", [])),
        switched)

# ============ one name, every surface: the global stale-repaint audit ============
# the reported bug was "renamed a request, the left side never changed"; the same
# class turned up in six more places, so each is pinned here
seed = h.eval_json("""(async () => {
  const s = await import('/js/state.js');
  const req = s.state.collections[0].children.find((c) => c.kind === 'request');
  return JSON.stringify({ id: req.id, name: req.name });
})()""")
seed_id, seed_name = seed["id"], seed["name"]
h.click('#sidebar .node[data-node="%s"]' % seed_id, timeout=0.9)

h.type_into("#request-host .req-title", "请求页改名")
live = h.eval_json("""(() => {
  const row = document.querySelector('#sidebar .node[data-node="%s"] .name');
  const tab = [...document.querySelectorAll('.tab.active')].map((t) => t.textContent.trim()).join('');
  return JSON.stringify({ row: row && row.textContent, tab });
})()""" % seed_id)
h.check("在请求页改标题：左侧那一行实时跟着变，标签页标题也变",
        live.get("row") == "请求页改名" and "请求页改名" in live.get("tab", ""), live)

h.double_click('#sidebar .node[data-node="%s"]' % seed_id)
h.type_into("#sidebar .node-rename", "树里改名")
h.key("Enter")
time.sleep(0.5)
reversed_ = h.eval_json("""(async () => {
  const s = await import('/js/state.js');
  const t = s.state.tabs.find((x) => x.id === s.state.activeTabId);
  const node = s.state.collections[0].children.find((c) => c.id === '%s');
  return JSON.stringify({ editor: (document.querySelector('#request-host .req-title') || {}).value,
    draft: t.draft.name, model: node.name });
})()""" % seed_id)
h.check("反过来在树里行内改名：打开着的请求页标题框和 draft 一起更新",
        reversed_.get("editor") == "树里改名" and reversed_.get("draft") == "树里改名"
        and reversed_.get("model") == "树里改名", reversed_)
h.js("""(async () => { const s = await import('/js/state.js');
  const n = s.state.collections[0].children.find((c) => c.id === '%s');
  n.name = %s; n.request.name = %s; s.touch('collections'); s.emit('tree'); s.emit('rerender'); return 1; })()"""
   % (seed_id, json.dumps(seed_name, ensure_ascii=False), json.dumps(seed_name, ensure_ascii=False)))

fresh_http_tab(BASE + "/hello")
h.click_subtab("#request-host", "Params")
status_url = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const cell=document.querySelector('#request-host .kv-rows .kv-row.ghost .kv-cell:nth-child(2)');
  const input=cell.querySelector('input');
  input.focus(); input.value='marker';
  input.dispatchEvent(new Event('input', { bubbles: true })); await s(400);
  const created=document.querySelectorAll('#request-host .kv-rows .kv-row:not(.ghost):not(.kv-head)');
  const last=created[created.length-1];
  const valueCell=last.querySelectorAll('.kv-cell')[2];
  const valueInput=valueCell.querySelector('input');
  valueInput.focus(); valueInput.value='77';
  valueInput.dispatchEvent(new Event('input', { bubbles: true }));
  valueInput.dispatchEvent(new Event('blur', { bubbles: true })); await s(600);
  const bar=[...document.querySelectorAll('#statusbar .sb-item')].map((e)=>e.textContent.trim());
  return JSON.stringify({ bar, url: (document.querySelector('.url-input')||{}).value });
})()""")
h.check("在 Params 单元格里粘整串 URL：底部状态栏报出的也是新地址",
        any("marker=77" in t for t in status_url.get("bar", [])), status_url)

ws_tree = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const st=await import('/js/state.js');
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await s(280);
  [...document.querySelectorAll('.menu-item')].find((m)=>m.textContent.includes('WebSocket')).click(); await s(520);
  const u=document.querySelector('.url-input');
  u.value='ws://127.0.0.1:8900'; u.dispatchEvent(new Event('input',{bubbles:true})); await s(250);
  const save=[...document.querySelectorAll('button')].find((b)=>b.textContent.trim()==='保存');
  if (save) { save.click(); await s(900); }
  const t=st.state.tabs.find((x)=>x.id===st.state.activeTabId);
  const row=document.querySelector('#sidebar .node[data-node="'+(t.refId||'—')+'"]');
  return JSON.stringify({ refId: t.refId || null, rowShown: !!row, rowText: row ? row.textContent.replace(/\\s+/g,' ').trim() : null });
})()""")
h.check("WebSocket 点保存后，左侧树立刻长出这个连接节点",
        ws_tree.get("refId") and ws_tree.get("rowShown") and "8900" in (ws_tree.get("rowText") or ""),
        ws_tree)

env_chrome = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const st=await import('/js/state.js');
  st.state.pane='environments'; st.emit('pane'); await s(350);
  document.querySelector('#sidebar .node').click(); await s(700);
  const swatches=[...document.querySelectorAll('.env-swatches .swatch')];
  swatches[2].click(); await s(350);
  const onIndex=swatches.findIndex((b)=>b.classList.contains('on'));
  const dots=[...document.querySelectorAll('#sidebar .node .swatch')].length;
  const before=st.state.environments.length;
  const more=[...document.querySelectorAll('#request-host .btn-row button')].find((b)=>b.title==='更多');
  if (more) { more.click(); await s(350); }
  const dup=[...document.querySelectorAll('.menu-item')].find((m)=>m.textContent.includes('复制此环境'));
  if (dup) { dup.click(); await s(600); }
  const rows=[...document.querySelectorAll('#sidebar .node .name')].map((n)=>n.textContent);
  return JSON.stringify({ onIndex, dots, before, after: st.state.environments.length, rows });
})()""")
h.check("环境换色：选中环立刻移到新色块（不重绘工作区，侧栏同步）",
        env_chrome.get("onIndex") == 2 and env_chrome.get("dots", 0) >= 2,
        {"onIndex": env_chrome.get("onIndex"), "dots": env_chrome.get("dots")})
h.check("环境「复制此环境」：侧栏列表马上多出副本行",
        env_chrome.get("after") == env_chrome.get("before", 0) + 1
        and any("副本" in r for r in env_chrome.get("rows", [])),
        {"before": env_chrome.get("before"), "after": env_chrome.get("after"),
         "rows": env_chrome.get("rows")})
h.js("""(async () => { const s = await import('/js/state.js');
  s.state.environments = s.state.environments.filter((e) => !/副本$/.test(e.name || ''));
  s.state.pane = 'collections'; s.touch('environments'); s.emit('pane'); return 1; })()""")

doc_sync = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const st=await import('/js/state.js');
  const { createDoc } = await import('/js/doc.js');
  st.state.pane='docs'; st.emit('pane'); await s(400);
  const d=createDoc('同步测试文档'); await s(700);
  const input=document.querySelector('.doc-name');
  if (!input) return JSON.stringify({ noInput: true });
  input.focus(); input.value='文档已改名';
  input.dispatchEvent(new Event('input', { bubbles: true })); await s(600);
  const rows=[...document.querySelectorAll('#sidebar .node-doc .name')].map((n)=>n.textContent.trim());
  const hit=rows.indexOf('文档已改名');
  const del=st.state.docs.findIndex((x)=>x.id===d.id);
  if (del>=0) st.state.docs.splice(del,1);
  for (const t of [...st.state.tabs]) { if (t.kind==='doc') st.closeTab(t.id); }
  st.touch('docs'); st.emit('tree');
  return JSON.stringify({ rows, hit });
})()""")
h.check("文档改名：侧栏文档列表那一行同步（不再只有标签页知道）",
        not doc_sync.get("noInput") and doc_sync.get("hit", -1) >= 0, doc_sync)

# ============ no edge control may be drawn by the OS ============
# the sweep lives in harness.py so tests/style_audit.py and this suite agree on
# what "unstyled" means
bare_now = h.sweep_controls()
h.check("当前界面上没有未被设计系统覆盖的表单控件",
        isinstance(bare_now, list) and not bare_now, bare_now if isinstance(bare_now, list) else bare_now)

# the same sweep, driven from Python so the page never has to know about it
h.js("""(async () => { const t=await import('/js/tools.js');
  document.querySelectorAll('.overlay').forEach(o=>o.remove());
  t.importCurlDialog(null, "curl -X POST 'https://api.demo.com/o?a=1' -H 'A: 1' -d 'x=1'"); return 1; })()""")
time.sleep(1.4)
curl_bare = h.sweep_controls()
h.js("document.querySelectorAll('.overlay').forEach(o=>o.remove()); document.body.classList.remove('has-sheet'); delete document.body.dataset.sheets;")
h.check("cURL 导入弹窗没有漏样式的表单控件", not [r for r in (curl_bare or []) if isinstance(r, dict)], curl_bare)

# ============ separators must not depend on which sibling is selected ============
# the reported bug: hairlines between segments / tabs appeared and vanished
# depending on where the selection sat, so the row looked uneven at random
def separator_counts(container, item="button"):
    """Click every child of `container` in turn and count the painted hairlines
    each time. The count must not move — a separator that depends on which sibling
    is selected is exactly the "有时候生效有时候不生效" defect."""
    return h.eval_json("""(async () => {
      const s=(ms)=>new Promise(r=>setTimeout(r,ms));
      const painted=(el)=>{ const cs=getComputedStyle(el,'::before');
        return cs.content!=='none' && cs.content!=='' && parseFloat(cs.opacity)>0 && parseFloat(cs.width)>=0.5; };
      const list=()=>{ const box=document.querySelector(%s); return box ? [...box.querySelectorAll(%s)] : []; };
      const counts=[];
      const n=list().length;
      for (let i=0;i<n;i++){
        const items=list();
        if (!items[i]) { counts.push(-1); continue; }
        items[i].click(); await s(520);
        counts.push(list().filter(painted).length);
      }
      const back=list(); if (back[0]) { back[0].click(); await s(400); }
      return JSON.stringify({ counts, n });
    })()""" % (json.dumps(container), json.dumps(item)))


fresh_http_tab(BASE + "/list")
seg = separator_counts("#request-host .seg")
# the sliding pill is the boundary now, so the answer is zero lines at every
# position — what must never happen is a count that changes with the selection
h.check("协议分段控件的分隔线不随选中位置变化（有滑块就不再画分隔线）",
        seg.get("n", 0) >= 3 and len(set(seg.get("counts", []))) == 1 and seg.get("counts", [None])[0] == 0,
        seg)

tab_counts = separator_counts(".tabstrip", ".tab")
# Tabs are floating pills now, so the answer is zero dividers at every position.
# What still must never happen is a count that moves when the selection moves —
# that was the original bug, and "0 everywhere" is only meaningful next to
# "n >= 3 tabs", which is why both are asserted.
h.check("标签条是浮起药丸：任何位置都不画发丝线，且计数不随活动标签变化",
        tab_counts.get("n", 0) >= 3 and len(set(tab_counts.get("counts", []))) == 1
        and tab_counts.get("counts", [None])[0] == 0,
        {**tab_counts, "expected": 0})

hovered = h.eval_json("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const tabs=[...document.querySelectorAll('.tabstrip .tab')];
  const painted=(el)=>{ const cs=getComputedStyle(el,'::before');
    return cs.content!=='none' && cs.content!=='' && parseFloat(cs.opacity)>0 && parseFloat(cs.width)>=0.5; };
  const before=tabs.filter(painted).length;
  tabs[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await s(300);
  const during=tabs.filter(painted).length;
  tabs[1].dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  await s(200);
  return JSON.stringify({ before, during, after: tabs.filter(painted).length });
})()""")
h.check("悬停标签不产生也不抹掉任何发丝线（药丸之间本就没有线）",
        hovered.get("before") == hovered.get("during") == hovered.get("after") == 0, hovered)

# 集合信息弹窗里的两张表：卡片只能有一层，空表提示也只能有一次
h.js("""(() => {
  const row = document.querySelector('.node.node-collection');
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
  return 1;
})()""")
time.sleep(0.4)
h.js("""(() => {
  const item = [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('集合信息'));
  if (item) item.click();
  return 1;
})()""")
time.sleep(0.7)
nested = h.eval_json("""(() => {
  const cards = [...document.querySelectorAll('.modal .kv')];
  const hint = (el) => getComputedStyle(el, '::after').content.includes('粘贴');
  return JSON.stringify({
    nested: cards.filter((c) => c.querySelector('.kv')).length,
    total: cards.length,
    hints: cards.filter(hint).length,
    emptyTables: cards.filter((c) => !c.querySelector('.kv-row:not(.kv-head):not(.ghost)')).length,
  });
})()""")
h.check("集合信息弹窗里卡片不套卡片，不显示教学式空表提示",
        nested.get("nested") == 0 and nested.get("hints") == 0, nested)
h.key("Escape")
time.sleep(0.35)

# ---- 请求页的表面语言：三级地面、表卡吃满半屏、脚注在卡内、空响应居中 ----------
# The page used to be a small card lost in ~140px of bare canvas, over a second
# half that was bare canvas too -- and --sheet equalled --bg, so the two halves
# were the same grey and the seam between them was invisible. These keep that
# composition from sliding back.
fresh_http_tab('https://api.example.com/v1/orders?status=paid')
time.sleep(0.5)
ladder = h.eval_json("""(() => {
  // compare against the token as the browser resolves it, not a literal: an
  // earlier check in this suite flips the theme and never flips it back
  const probe = document.createElement('div');
  probe.style.background = 'var(--band)';
  document.body.appendChild(probe);
  const bandRgb = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const s = getComputedStyle(document.documentElement);
  const token = (n) => s.getPropertyValue(n).trim();
  const card = document.querySelector('#request-host .kv');
  const head = document.querySelector('#request-host .kv-head');
  const foot = document.querySelector('#request-host .kv-foot');
  const rows = document.querySelector('#request-host .kv-rows');
  const half = document.querySelector('#request-host').getBoundingClientRect();
  const plate = document.querySelector('#response-host .empty');
  const pb = plate && plate.getBoundingClientRect();
  const rb = document.querySelector('#response-host').getBoundingClientRect();
  const target = plate && plate.querySelector('.empty-target');
  return JSON.stringify({
    band: token('--band'), sheet: token('--sheet'), bg: token('--bg'),
    cardBg: card && getComputedStyle(card).backgroundColor,
    headBg: head && getComputedStyle(head).backgroundColor, bandRgb,
    bareBelow: card ? Math.round(half.bottom - card.getBoundingClientRect().bottom) : -1,
    cardContentSized: card && getComputedStyle(card).flexGrow === '0',
    footInCard: !!(foot && card && card.contains(foot)),
    footBelowRows: !!(foot && rows && foot.getBoundingClientRect().top >= rows.getBoundingClientRect().bottom),
    looseHint: !!document.querySelector('#request-host .pane > .hint'),
    plateCentered: pb ? Math.abs((pb.left + pb.right) / 2 - (rb.left + rb.right) / 2) < 2 : false,
    plateShorterThanHalf: pb ? pb.height < rb.height - 40 : false,
    target: target ? target.textContent : null,
  });
})()""")
h.check("地面有三档：画布 != 窗口底 != 卡片白",
        ladder.get("band") and ladder.get("sheet") != ladder.get("bg")
        and ladder.get("sheet") != ladder.get("cardBg"), ladder)
h.check("表头带用 --band 这一档，不是压在白卡上的 1% 灰",
        ladder.get("headBg") == ladder.get("bandRgb"), ladder)
h.check("参数表按内容高度排版，保留响应阅读空间",
        ladder.get("cardContentSized"), ladder)
h.check("请求参数页不显示多余脚注和教学提示",
        not ladder.get("footInCard") and not ladder.get("looseHint"), ladder)
h.check("空响应是有界居中的一块，不是填满半屏的白板",
        ladder.get("plateCentered") and ladder.get("plateShorterThanHalf"), ladder)
h.check("没发过时把要发出的目标摆在眼前",
        "GET" in (ladder.get("target") or "") and "orders" in (ladder.get("target") or ""), ladder)

h.js("""(() => {
  // earlier checks in this suite roam the rail, so ask for the collections page
  // by name rather than assuming the tree is what is showing
  const rail = document.querySelector('[data-rail=collections]');
  if (rail && !rail.classList.contains('active')) rail.click();
  return 1;
})()""")
time.sleep(0.5)
h.js("""(() => {
  const row = [...document.querySelectorAll('#sidebar .node[data-node]')]
    .find((n) => /Echo GET/.test(n.textContent));
  if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return !!row;
})()""")
time.sleep(0.8)
crumb = h.eval_json("""(() => {
  const c = document.querySelector('.req-crumb');
  return JSON.stringify({ text: c ? c.textContent : null });
})()""")
h.check("已保存请求的标题行报出它所在的集合",
        bool(crumb.get("text")) and "示例接口" in crumb["text"], crumb)
h.js("document.querySelector('.req-crumb').click()")
time.sleep(0.5)
h.check("点集合路径会在左树里点亮对应行",
        h.js("!!document.querySelector('#sidebar .node.just-added')") == "true", crumb)

h.check("整轮界面扫描没有产生 JS 报错", not h.console_errors(), h.console_errors()[:3])

h.finish()
