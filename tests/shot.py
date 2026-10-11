"""Grab a PNG of the running window over CDP so the design can actually be seen.

Usage: python tests/shot.py [out.png] [js-to-run-before-capture]
"""
import base64
import json
import sys
import time
import urllib.request

import websocket

PORT = 9223
OUT = sys.argv[1] if len(sys.argv) > 1 else "shot.png"
PREP = sys.argv[2] if len(sys.argv) > 2 else ""

with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as response:
    url = next(p["webSocketDebuggerUrl"] for p in json.load(response) if p.get("type") == "page" and "tauri" in p.get("url", ""))

ws = websocket.create_connection(url, timeout=60)
counter = 0


def call(method, params=None):
    global counter
    counter += 1
    ws.send(json.dumps({"id": counter, "method": method, "params": params or {}}))
    while True:
        payload = json.loads(ws.recv())
        if payload.get("id") == counter:
            if "error" in payload:
                raise SystemExit(json.dumps(payload["error"]))
            return payload.get("result", {})


call("Runtime.enable")
if PREP:
    call("Runtime.evaluate", {"expression": PREP, "awaitPromise": True})
    time.sleep(0.6)
shot = call("Page.captureScreenshot", {"format": "png"})
open(OUT, "wb").write(base64.b64decode(shot["data"]))
print("wrote", OUT, len(shot["data"]), "b64 bytes")
