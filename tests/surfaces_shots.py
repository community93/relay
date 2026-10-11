"""Walk every surface Relay has and shoot it in both themes.

A token-layer redesign lands on the request page first; the sub-pages only get
what they inherit. This exists to find the ones that inherited badly, so each
pass reports whether the screen actually rendered something as well as writing
the PNG.

    python tests/surfaces_shots.py [theme]
"""
import base64
import json
import os
import sys
import time
import urllib.request

import websocket

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
PORT = 9223
BASE = "http://127.0.0.1:8899"
OUT = os.path.expandvars(r"%TEMP%\surfaces")
os.makedirs(OUT, exist_ok=True)

with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as response:
    URL = next(p["webSocketDebuggerUrl"] for p in json.load(response)
               if p.get("type") == "page" and "tauri" in p.get("url", ""))

ws = websocket.create_connection(URL, timeout=120)
ctr = [0]


def call(method, params=None):
    ctr[0] += 1
    ws.send(json.dumps({"id": ctr[0], "method": method, "params": params or {}}))
    while True:
        got = json.loads(ws.recv())
        if got.get("id") == ctr[0]:
            if "error" in got:
                return {"__error": got["error"]}
            return got.get("result", {})


def js(expr):
    out = call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    if "exceptionDetails" in out:
        return "EXC " + str(out["exceptionDetails"].get("exception", {}).get("description", ""))[:200]
    return out.get("result", {}).get("value")


call("Runtime.enable")
call("Page.enable")

PRELUDE = "const s=(ms)=>new Promise(r=>setTimeout(r,ms));"


def dismiss():
    """Close anything a previous step left up. Without this a modal or menu
    survives into the next screenshot, and the shot then documents the overlay
    rather than the surface it was meant to audit."""
    js("""(async () => {
      const s=(ms)=>new Promise(r=>setTimeout(r,ms));
      for (let i=0;i<4;i++) {
        const menus=[...document.querySelectorAll('.menu')];
        for (const m of menus) m.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        document.querySelectorAll('.overlay .modal-head button').forEach((b)=>{ try { b.click(); } catch (e) {} });
        document.querySelectorAll('.drawer.open, .drawer').forEach((d)=>d.classList.remove('open'));
        await s(120);
      }
      document.querySelectorAll('.overlay').forEach((o)=>o.remove());
      document.body.classList.remove('has-sheet');
      delete document.body.dataset.sheets;
      return 'clear';
    })()""")
    time.sleep(0.35)


def new_tab(protocol, url):
    """Open a fresh tab of a given protocol pointed at a fixture endpoint."""
    dismiss()
    return js(f"""(async () => {{
      {PRELUDE}
      document.querySelectorAll('.tabstrip .tab-new')[0].click(); await s(300);
      [...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('{protocol}')).click();
      await s(400);
      const u=document.querySelector('.url-input');
      if(!u) return 'no url input';
      u.value='{url}'; u.dispatchEvent(new Event('input',{{bubbles:true}})); await s(200);
      return 'ok';
    }})()""")


def click_subtab(label):
    """Subtabs hang off whichever half of the workspace owns the view — the SSE
    stream's 事件/原始流/Headers row is in the response host, Body tabs are in the
    request host — so search both instead of guessing."""
    return js(f"""(async () => {{
      {PRELUDE}
      const b=[...document.querySelectorAll('#request-host .subtab, #response-host .subtab')]
        .find(x=>x.textContent.trim().startsWith('{label}'));
      if(!b) return 'no subtab {label}';
      b.click(); await s(450); return 'ok';
    }})()""")


def click_response_tab(label):
    """The response's Pretty/树/Raw switch is a `.seg` inside `.code-bar` in the
    response body, not in `.response-head` — a head-scoped selector never finds
    it, and the shot silently documented the previous screen."""
    return js(f"""(async () => {{
      {PRELUDE}
      const b=[...document.querySelectorAll('#response-host .subtab, #response-host .seg button')]
        .find(x=>x.textContent.trim().startsWith('{label}'));
      if(!b) return 'no response tab {label}';
      b.click(); await s(450); return 'ok';
    }})()""")


def rail(key):
    return js(f"""(async () => {{
      {PRELUDE}
      const b=document.querySelector('button[data-rail={key}]');
      if(!b) return 'no rail {key}';
      b.click(); await s(500); return 'ok';
    }})()""")


def body_mode(mode):
    return js(f"""(async () => {{
      {PRELUDE}
      const labels={{raw:'JSON',form:'表单',urlencoded:'URL 编码',file:'二进制',none:'无'}};
      const row=[...document.querySelectorAll('#request-host .body-formats button')]
        .find(r=>r.textContent.trim()===labels['{mode}']);
      if(!row) return 'no option {mode}';
      row.click(); await s(450); return 'ok';
    }})()""")


def shoot(name, theme):
    shot = call("Page.captureScreenshot", {"format": "png"})
    path = os.path.join(OUT, f"{name}-{theme}.png")
    if "data" in shot:
        open(path, "wb").write(base64.b64decode(shot["data"]))
    return path


def report(name, theme):
    state = js("""(() => {
      const hosts=[document.querySelector('#request-host'), document.querySelector('#response-host'),
                   document.querySelector('#sidebar')];
      const filled=hosts.filter(h=>h && h.innerText.replace(/\\s+/g,'').length>0).length;
      const native=document.querySelectorAll('select').length;
      const boxes=[...document.querySelectorAll('.group, .kv, .sheet-card')]
        .map(n=>Math.round(parseFloat(getComputedStyle(n).borderRadius)));
      const uniq=[...new Set(boxes)];
      return JSON.stringify({filled, native, radii: uniq.slice(0,6),
        text: (document.querySelector('.workspace')||{}).innerText ? 1 : 0});
    })()""")
    print(f"  {name:26s} {theme:5s} {state}")


def seed_runner():
    """让运行页带着一次真跑完的结果入镜 —— 空卡片说明不了任何东西。"""
    return js(f"""(async () => {{
      {PRELUDE}
      const st = await import('/js/state.js');
      const m = await import('/js/runner.js');
      if (!st.state.runners.length) {{
        const r = m.createRunner('冒烟 · 全链路');
        r.sources = st.state.collections.slice(0, 2).map((c) => c.id);
        st.touch('runners');
        // 不 await：示例集合里有一条故意慢的请求，等它跑完会把这一屏卡成超时。
        // 正好让截图拍到"正在跑"的样子 —— 进度条和停止按钮才是这块界面的主角。
        m.runRunner(r);
      }}
      document.querySelector('button[data-rail=runner]').click();
      await s(400);
      // 光切侧栏不够：工作区还停在上一张标签上，必须真的打开计划的标签页
      st.openRunner(st.state.runners[0]);
      await s(900);
      return 'ok';
    }})()""")


def runner_result():
    """等这一次跑完并展开 —— 过/败/跳三种行色只有跑完才看得到。"""
    return js(f"""(async () => {{
      {PRELUDE}
      const st = await import('/js/state.js');
      for (let i = 0; i < 60 && !((st.state.runs[0] || {{}}).finishedAt); i += 1) await s(500);
      st.openRunner(st.state.runners[0]);
      await s(500);
      const head = document.querySelector('.run-block .run-head');
      if (head) {{ head.click(); await s(400); }}
      return 'ok';
    }})()""")


def schedule_daily():
    """先把定时打开 —— 关着的时候「方式」分段根本不渲染，直接点会静默落空。"""
    return js(f"""(async () => {{
      {PRELUDE}
      const row = [...document.querySelectorAll('.row')].find((x) => x.textContent.includes('按计划自动运行'));
      if (!row) return 'no schedule row';
      const sw = row.querySelector('.switch');
      if (sw && !sw.classList.contains('on')) {{ sw.click(); await s(450); }}
      const seg = [...document.querySelectorAll('.runner-pane .seg')].find((x) => x.textContent.includes('每天定点'));
      if (!seg) return 'no seg';
      seg.querySelectorAll('button')[1].click();
      await s(450);
      return 'ok';
    }})()""")


PLAN = [
    ("collections-tree", lambda: rail("collections"), None),
    ("runner-plan", lambda: seed_runner(), None),
    ("runner-result", lambda: runner_result(), None),
    ("runner-schedule", lambda: schedule_daily(), None),
    ("env-settings", lambda: rail("environments"), None),
    ("docs-list", lambda: rail("docs"), None),
    ("history", lambda: rail("history"), None),
    ("http-params", lambda: (new_tab("HTTP", f"{BASE}/list"), click_subtab("Params")), None),
    ("http-body-raw", lambda: (new_tab("HTTP", f"{BASE}/echo"), click_subtab("Body"), body_mode("raw")), None),
    ("http-body-form", lambda: (click_subtab("Body"), body_mode("form")), None),
    ("http-body-file", lambda: (click_subtab("Body"), body_mode("file")), None),
    ("http-auth", lambda: (click_subtab("Auth"),), None),
    ("http-settings", lambda: (click_subtab("Settings"),), None),
    ("http-response", lambda: (new_tab("HTTP", f"{BASE}/list"),
                               js(f"""(async()=>{{{PRELUDE}
                                 [...document.querySelectorAll('.urlbar button')]
                                   .find(b=>/Send|发送/.test(b.textContent)).click(); await s(1800); return 'sent';}})()""")),
     None),
    ("response-json-tree", lambda: click_response_tab("树"), None),
    ("sse-events", lambda: new_tab("SSE", f"{BASE}/sse"), None),
    ("sse-raw", lambda: click_subtab("原始流"), None),
    ("ws-conn", lambda: new_tab("WebSocket", "ws://127.0.0.1:8900"), None),
]

themes = sys.argv[1:] or ["light", "dark"]
for theme in themes:
    js(f"document.documentElement.dataset.theme='{theme}'; 'ok'")
    time.sleep(0.5)
    print(f"\n=== {theme} ===")
    for name, go, _ in PLAN:
        dismiss()
        steps = go()
        # 一个被丢掉的返回值就是这张图假掉的开始：导航脚本里任何一段 JS 抛了
        # SyntaxError 或 EXC，画面只会安静地停在上一屏，看起来像"页面没做"。
        for step in steps if isinstance(steps, list) else [steps]:
            # 三种"这一屏没拍到该拍的东西"的形状：JS 抛错、返回了 no/missing 这类
            # 落空字符串、以及 harness 的 jsError。只认第一种会漏掉 schedule 那一屏。
            note = None
            if isinstance(step, str) and (step.startswith("EXC") or step.startswith("no ") or step == "missing"):
                note = step
            elif isinstance(step, dict) and (step.get("jsError") or step.get("missing")):
                note = str(step.get("jsError") or step)
            if note:
                print(f"  !! {name}: 导航没走到该屏 — {note[:160]}")
        time.sleep(0.9)
        shoot(name, theme)
        report(name, theme)

print("\nPNGs in", OUT)
