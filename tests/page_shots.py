"""Shoot the surfaces that are easy to break and easy to miss.

A token-layer redesign lands on the main screen first and the sub-pages last, so
this walks the settings sheet, the environment pane, a document and a real
response, in both themes, and reports any surface that failed to render at all
rather than trusting that "it inherits the tokens" means it looks right.
"""
import base64
import json
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import websocket

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
PORT = 9223

with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as response:
    URL = next(p["webSocketDebuggerUrl"] for p in json.load(response)
               if p.get("type") == "page" and "tauri" in p.get("url", ""))

ws = websocket.create_connection(URL, timeout=90)
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
        return "EXC " + str(out["exceptionDetails"].get("exception", {}).get("description", ""))[:180]
    return out.get("result", {}).get("value")


call("Runtime.enable")
call("Page.enable")
BASE = "http://127.0.0.1:8899"

NAVS = {
    "response": """(async () => {
      const s=(ms)=>new Promise(r=>setTimeout(r,ms));
      document.querySelectorAll('.tabstrip .tab-new')[0].click(); await s(260);
      [...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('HTTP')).click(); await s(320);
      const u=document.querySelector('.url-input'); u.value='%s/list';
      u.dispatchEvent(new Event('input',{bubbles:true})); await s(150);
      [...document.querySelectorAll('.urlbar button')].find(b=>/Send|发送/.test(b.textContent)).click();
      await s(1800); return 'ok';
    })()""" % BASE,
    "settings": """(async () => { const m = await import('/js/tools.js'); m.openSettingsDialog(); return 'ok'; })()""",
    "environments": "(() => { document.querySelector('button[data-rail=environments]').click(); return 'ok'; })()",
    "history": "(() => { document.querySelector('button[data-rail=history]').click(); return 'ok'; })()",
    "docs": "(() => { document.querySelector('button[data-rail=docs]').click(); return 'ok'; })()",
    "collections": "(() => { document.querySelector('button[data-rail=collections]').click(); return 'ok'; })()",
}

for theme in ("light", "dark"):
    js("document.documentElement.dataset.theme='%s'; 'ok'" % theme)
    time.sleep(0.4)
    for name, nav in NAVS.items():
        js(nav)
        time.sleep(0.7)
        shot = call("Page.captureScreenshot", {"format": "png"})
        path = str(Path(tempfile.gettempdir()) / ("pg-%s-%s.png" % (name, theme)))
        open(path, "wb").write(base64.b64decode(shot["data"]))
        blank = js("""(() => {
          const host = document.querySelector('.workspace, #sidebar');
          const t = (host ? host.innerText : '').replace(/\\s+/g,' ').trim();
          return JSON.stringify({ chars: t.length, sample: t.slice(0, 46) });
        })()""")
        print("%-14s %-6s %s" % (name, theme, blank))
