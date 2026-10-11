"""How long does an interaction take, and does it actually get there?

Two distinct failures live here and they are easy to conflate:

* **jank** — the handler or the paint blocks the main thread, so the app feels
  sticky even though it ends up correct.
* **never arriving** — the click lands, the state updates, but the view settles
  somewhere else. That is the bug family the segmented control belonged to.

So every interaction is measured (frames + milliseconds to a committed paint)
*and* polled until its post-condition holds. A check passes only if the UI both
arrives and arrives quickly.

    python tests/e2e_latency.py [cdp-port]
"""

import json
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import BASE, Harness  # noqa: E402

h = Harness(label="latency")

# A long task is anything over 50ms on the main thread; at 60Hz that is three
# dropped frames, which is exactly the threshold where a click feels sticky.
LONG_TASK_LIMIT = 50
FRAME_BUDGET = 8


def timed(name, action, predicate, budget_ms=140.0, runs=3, reset=None):
    """Warm up once (module loading and first paint are not representative), then
    measure. `predicate` is polled after each run to prove it converged.

    `reset` runs *before* the warm-up, before every sample and after the last one:
    a measurement that leaves the app in its post-action state makes the next
    test start somewhere it never asked to be.
    """
    def restore():
        if reset:
            h.js("(() => { %s })()" % reset)
            time.sleep(0.45)

    samples = []
    problems = []
    restore()
    h.js("(() => { %s })()" % action)
    time.sleep(0.5)
    for _ in range(runs):
        restore()
        out = h.measure(action)
        if out.get("jsError"):
            problems.append(out["jsError"])
            break
        if out.get("error"):
            problems.append(f"handler threw: {out['error']}")
        samples.append(out)
        settled = h.settle(predicate, limit=2500)
        if not settled.get("ok"):
            problems.append({"never converged": settled})
        if (out.get("long") or []):
            problems.append({"longtask": out["long"]})
    restore()
    if not samples:
        h.check(name, False, problems)
        return
    med_ms = statistics.median(s["ms"] for s in samples)
    med_frames = statistics.median(s["frames"] for s in samples)
    worst = max(s["ms"] for s in samples)
    ok = med_ms <= budget_ms and med_frames <= FRAME_BUDGET and not problems
    detail = {"medianMs": med_ms, "worstMs": worst, "medianFrames": med_frames, "budget": budget_ms}
    if problems:
        detail["problems"] = problems[:3]
    h.check(name, ok, detail)


def close_overlays():
    h.js("""(() => {
      document.querySelectorAll('.overlay .modal-head button').forEach((b) => b.click());
      document.querySelectorAll('.menu').forEach((m) => m.remove());
    })()""")
    time.sleep(0.5)


# ---------------- a known starting point ----------------
h.js("""(() => {
  document.querySelectorAll('.overlay').forEach(o => o.remove());
  document.body.classList.remove('has-sheet'); delete document.body.dataset.sheets;
})()""")
h.js("document.querySelectorAll('.tabstrip .tab-new')[0].click()")
time.sleep(0.35)
h.js("[...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('HTTP')).click()")
time.sleep(0.5)
h.js("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const u=document.querySelector('.url-input');
  u.value='%s/list'; u.dispatchEvent(new Event('input',{bubbles:true})); await s(150);
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click();
  await s(1800);
})()""" % BASE)

# ---------------- the interactions a user actually performs ----------------
timed("切换请求子标签不卡顿且切得过来",
      """const t=[...document.querySelectorAll('#request-host .subtab')]
           .find(b=>b.textContent.trim().startsWith('Headers')); t.click();""",
      """[...document.querySelectorAll('#request-host .subtab')].find(b=>b.textContent.trim().startsWith('Headers')).classList.contains('on')
         && !!document.querySelector('#request-host .kv')""",
      reset="""const p=[...document.querySelectorAll('#request-host .subtab')]
              .find(b=>b.textContent.trim().startsWith('Params')); p.click();""")

timed("切换响应子标签（Body/Headers/Cookies）不卡顿",
      """const t=[...document.querySelectorAll('#response-host .subtab')]
           .find(b=>b.textContent.trim().startsWith('Headers')); t.click();""",
      """[...document.querySelectorAll('#response-host .subtab')].find(b=>b.textContent.trim().startsWith('Headers')).classList.contains('on')""",
      reset="""const b=[...document.querySelectorAll('#response-host .subtab')]
              .find(x=>x.textContent.trim()==='Body'); b.click();""")

timed("响应视图 Pretty/树/Raw 切换不卡顿",
      """const b=[...document.querySelectorAll('.code-bar .seg button')].find(x=>x.textContent.trim()==='树'); b.click();""",
      """!!document.querySelector('.response-body .twist, .response-body .tree')""",
      reset="""const b=[...document.querySelectorAll('.code-bar .seg button')].find(x=>x.textContent.trim()==='Pretty'); b && b.click();""")

timed("切协议 HTTP→SSE 不卡顿且换掉整个 composer",
      """const b=[...document.querySelectorAll('.urlbar .seg button')].find(x=>x.textContent.trim()==='SSE'); b.click();""",
      """[...document.querySelectorAll('.urlbar .seg button')].find(x=>x.textContent.trim()==='SSE').classList.contains('on')
         && [...document.querySelectorAll('.urlbar button')].some(x=>/连接/.test(x.textContent))""",
      reset="""const b=[...document.querySelectorAll('.urlbar .seg button')].find(x=>x.textContent.trim()==='HTTP'); b.click();""")

timed("打开方法下拉菜单不卡顿",
      """document.querySelector('.method-pick').click();""",
      """!!document.querySelector('.menu .menu-item')""",
      reset="""document.querySelectorAll('.menu').forEach(m=>m.remove());""")

timed("打开设置弹窗（sheet 升起）不卡顿",
      """[...document.querySelectorAll('.topbar button')].find(b=>b.title==='设置').click();""",
      """!!document.querySelector('.overlay .modal')""",
      reset="""document.querySelectorAll('.overlay .modal-head button').forEach(b=>b.click());""")

timed("打开快捷键抽屉不卡顿",
      """[...document.querySelectorAll('.topbar button')].find(b=>/快捷键/.test(b.title||'')).click();""",
      """!!document.querySelector('.modal-right')""",
      reset="""document.querySelectorAll('.overlay .modal-head button').forEach(b=>b.click());""")

timed("切换深浅主题不卡顿",
      """document.documentElement.dataset.theme = 'dark';""",
      """document.documentElement.dataset.theme === 'dark'""",
      reset="""document.documentElement.dataset.theme = 'light';""")

timed("侧栏 rail 换面板不卡顿",
      """document.querySelector('button[data-rail=history]').click();""",
      """document.querySelector('button[data-rail=history]').classList.contains('active')""",
      reset="""document.querySelector('button[data-rail=collections]').click();""")

timed("KV 表格加一行不卡顿",
      """const g=document.querySelector('#request-host .kv-row.ghost input');
         g.value='latencyKey'; g.dispatchEvent(new Event('input',{bubbles:true}));""",
      """[...document.querySelectorAll('#request-host .kv-row:not(.ghost) input')].some(i=>i.value==='latencyKey')""",
      reset="""document.querySelector('.tab')?.click(); const b=[...document.querySelectorAll('#request-host .subtab')].find(x=>x.textContent.trim().startsWith('Params'));b?.click();""")

timed("JSON 树全部展开不卡顿",
      """const b=[...document.querySelectorAll('.response-body button')].find(x=>x.textContent.trim()==='全部展开'); b && b.click();""",
      """true""")

close_overlays()

# ---------------- does it survive being hammered? ----------------
# Rapid alternating clicks are where a UI that "settles late" turns up: each click
# queues work, and if the last one loses the app ends in the wrong state.
# The subtabs are re-queried every iteration on purpose — switching a subtab
# re-renders the pane, so a node captured before the loop is detached after the
# first click and the whole test would silently be clicking nothing.
stress = h.eval_json("""(async () => {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  const nodesBefore = document.getElementsByTagName('*').length;
  const names = [...document.querySelectorAll('#request-host .subtab')].map(b => b.textContent.trim());
  const t0 = performance.now();
  let missed = 0;
  for (let i = 0; i < 20; i++) {
    const tabs = [...document.querySelectorAll('#request-host .subtab')];
    const b = tabs[i % tabs.length];
    if (!b) { missed++; continue; }
    b.click();
    await s(28);
  }
  await s(600);
  const clickMs = (performance.now() - t0) / 20;
  const tabs = [...document.querySelectorAll('#request-host .subtab')];
  const lit = tabs.findIndex(b => b.classList.contains('on'));
  return JSON.stringify({
    count: tabs.length, names,
    nodesBefore, nodesAfter: document.getElementsByTagName('*').length,
    perClickMs: +clickMs.toFixed(1), lit, missed,
    stray: [...document.querySelectorAll('body *')].filter((e) => [...e.childNodes]
      .some((n) => n.nodeType === 3 && /^(null|undefined)$/.test((n.nodeValue || '').trim()))).length,
    stuckOverlay: !!document.querySelector('.overlay:not(.closing)'),
  });
})()""")
leak = stress.get("nodesAfter", 0) - stress.get("nodesBefore", 0)
# 20 clicks over N tabs: the last one is index 19 % N
expected_lit = 19 % stress.get("count", 1)
h.check("子标签连点 20 次：每次都算得快、最后停在正确一项、不涨节点",
        stress.get("lit") == expected_lit and stress.get("perClickMs", 9e9) < 80
        and not stress.get("missed") and abs(leak) < 150
        and not stress.get("stray") and not stress.get("stuckOverlay"),
        {"perClickMs": stress.get("perClickMs"), "litIndex": stress.get("lit"),
         "expectedLit": expected_lit, "nodeDelta": leak, "missed": stress.get("missed")})

# a stuck overlay is the worst kind of "切换不过来": the app looks frozen
stack = h.eval_json("""(async () => {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  const open = () => [...document.querySelectorAll('.topbar button')].find(b=>b.title==='设置').click();
  open(); await s(500);
  const first = document.querySelectorAll('.overlay').length;
  open(); await s(500);
  const second = document.querySelectorAll('.overlay').length;
  document.querySelectorAll('.overlay .modal-head button').forEach(b => b.click());
  await s(900);
  return JSON.stringify({ first, second,
    left: document.querySelectorAll('.overlay:not(.closing)').length,
    sheets: document.body.dataset.sheets || null,
    hasSheetClass: document.body.classList.contains('has-sheet') });
})()""")
h.check("叠两层弹窗再全部关掉，遮罩与 has-sheet 计数都归零（不会留下点不动的层）",
        stack.get("first") == 1 and stack.get("second") == 2 and stack.get("left") == 0
        and not stack.get("sheets") and not stack.get("hasSheetClass"),
        stack)

h.check("整轮延迟测试没有产生 JS 报错", not h.console_errors(), h.console_errors()[:3])

h.finish()
