"""Ask the running window what it actually computed. Usage: python tests/probe.py "<js>"

shot.py proves how a screen looks; this proves why, by reading computed styles and
hit-testing a point down to the element that owns its background.
"""
import json
import sys
import urllib.request

import websocket

PORT = 9223
EXPR = sys.argv[1] if len(sys.argv) > 1 else "1+1"

with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as response:
    url = next(p["webSocketDebuggerUrl"] for p in json.load(response)
               if p.get("type") == "page" and "tauri" in p.get("url", ""))

ws = websocket.create_connection(url, timeout=60)
ws.send(json.dumps({"id": 1, "method": "Runtime.enable", "params": {}}))
ws.recv()
ws.send(json.dumps({"id": 2, "method": "Runtime.evaluate",
                    "params": {"expression": EXPR, "returnByValue": True,
                               "awaitPromise": True}}))
while True:
    payload = json.loads(ws.recv())
    if payload.get("id") == 2:
        if "error" in payload:
            print("CDP error:", json.dumps(payload["error"]))
        else:
            value = payload.get("result", {}).get("result", {}).get("value")
            print(value if isinstance(value, str) else json.dumps(value, indent=1))
        break
