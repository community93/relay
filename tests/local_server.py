"""Local fixtures for end-to-end checks: JSON, echo, redirect, cookies, binary,
slow and an SSE stream over HTTP; a WebSocket echo on 8900.

    python tests/local_server.py
"""

import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HTTP_PORT = 8899
WS_PORT = 8900


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, code, body=b"", ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/hello":
            self._send(200, json.dumps({"ok": True, "msg": "你好 Relay", "query": self.path}).encode())
        elif path == "/echo":
            payload = {
                "received": "",
                "query": self.path.split("?")[1] if "?" in self.path else "",
                "headers": dict(self.headers.items()),
            }
            self._send(200, json.dumps(payload, ensure_ascii=False).encode())
        elif path == "/redirect":
            self._send(302, b"", extra={"Location": "/hello"})
        elif path == "/redirect-cross":
            # Same server, different hostname: 127.0.0.1 -> localhost. Lets a test
            # prove an allowlist pinned to one covers the other and vice versa.
            port = self.server.server_address[1]
            self._send(302, b"", extra={"Location": f"http://localhost:{port}/hello"})
        elif path == "/login":
            self._send(200, b'{"user":"tom"}', extra={"Set-Cookie": "session=abc123; Path=/; HttpOnly"})
        elif path == "/gbk":
            body = json.dumps({"城市": "上海", "状态": "成功"}, ensure_ascii=False).encode("gbk")
            self._send(200, body, "application/json; charset=gbk")
        elif path == "/gbk-nolabel":
            body = json.dumps({"城市": "北京", "备注": "无 charset 声明"}, ensure_ascii=False).encode("gbk")
            self._send(200, body, "application/json")
        elif path == "/list":
            rows = [
                {"id": 1, "机构": "上海分行", "金额": 1200.5, "状态": "已核"},
                {"id": 2, "机构": "成都分行", "金额": 880, "状态": "待复核"},
            ]
            self._send(200, json.dumps({"data": {"items": rows, "total": 2}}, ensure_ascii=False).encode())
        elif path == "/ndjson":
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            for i in range(1, 5):
                self.wfile.write((json.dumps({"seq": i, "值": f"第{i}行"}, ensure_ascii=False) + chr(10)).encode())
                self.wfile.flush()
                time.sleep(0.15)
        elif path == "/tokens":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            for piece in ["模型", "返回", "的", "增量", "文本"]:
                self.wfile.write(piece.encode())
                self.wfile.flush()
                time.sleep(0.15)
        elif path == "/bin":
            self._send(200, bytes([0, 1, 2, 3, 0xFF, 0xFE, 0x7F]), "application/octet-stream")
        elif path == "/file":
            # a download endpoint that names itself. ?utf asks for the RFC 5987
            # form too, which is how a non-ASCII filename actually arrives.
            query = self.path.split("?")[1] if "?" in self.path else ""
            if "utf" in query:
                value = "attachment; filename=\"report.xlsx\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.xlsx"
            else:
                value = "attachment; filename=\"quarterly-report.xlsx\""
            self._send(200, bytes([0x50, 0x4B, 3, 4]) + b"zip-zip", "application/octet-stream",
                       {"Content-Disposition": value})
        elif path == "/huge":
            # bigger than the render budget, so the "only the first N chars are
            # painted" notice has to show up instead of the UI just freezing
            items = [{"i": i, "text": "填充内容" * 12} for i in range(12000)]
            self._send(200, json.dumps({"items": items}, ensure_ascii=False).encode())
        elif path == "/slow":
            time.sleep(3)
            self._send(200, b'{"slow":true}')
        elif path.startswith("/sse-gbk"):
            # same framing as /sse but the payload is GBK. With the label the
            # engine should honour it on its own; without it the raw view's
            # charset picker is the only way to read the stream.
            declared = "nolabel" not in path
            self.send_response(200)
            self.send_header(
                "Content-Type",
                "text/event-stream; charset=gbk" if declared else "text/event-stream",
            )
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            for i in range(1, 4):
                frame = f'data: {{"seq": {i}, "text": "事件 {i} 中文"}}\n\n'
                self.wfile.write(frame.encode("gbk"))
                self.wfile.flush()
                time.sleep(0.15)
        elif path == "/sse":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            for i in range(1, 6):
                frame = (
                    "event: tick\n"
                    f"id: {i}\n"
                    f'data: {{"seq": {i}, "text": "事件 {i}"}}\n'
                    ": keep-alive comment\n"
                    "\n"
                )
                self.wfile.write(frame.encode())
                self.wfile.flush()
                time.sleep(0.2)
            self.wfile.write(b'retry: 500\ndata: line-a\ndata: line-b\n\n')
            self.wfile.flush()
        else:
            self._send(404, json.dumps({"error": "not found", "path": path}).encode())

    def do_POST(self):
        if self.path.startswith("/sse-post"):
            length = int(self.headers.get("content-length") or 0)
            echo = self.rfile.read(length).decode("utf-8", "replace") if length else ""
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            for i in range(1, 4):
                frame = "event: delta" + chr(10) + "data: " + json.dumps({"seq": i, "echo": echo}, ensure_ascii=False) + chr(10) + chr(10)
                self.wfile.write(frame.encode())
                self.wfile.flush()
                time.sleep(0.15)
            return
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        payload = {
            "received": raw.decode("utf-8", "replace"),
            "query": self.path.split("?")[1] if "?" in self.path else "",
            "headers": dict(self.headers.items()),
        }
        self._send(200, json.dumps(payload, ensure_ascii=False).encode())

    def do_DELETE(self):
        self._send(200, json.dumps({"deleted": self.path}).encode())


async def ws_handler(socket):
    import websockets

    await socket.send(json.dumps({"hello": "from local ws", "ts": time.time()}))
    async for message in socket:
        text = message if isinstance(message, str) else f"binary:{len(message)} bytes"
        await socket.send(json.dumps({"echo": text, "count": id(socket)}))


async def run_ws():
    import websockets

    async with websockets.serve(ws_handler, "127.0.0.1", WS_PORT, ping_interval=None):
        print(f"ws://127.0.0.1:{WS_PORT} ready", flush=True)
        await asyncio.Future()


def main():
    httpd = ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print(f"http://127.0.0.1:{HTTP_PORT} ready", flush=True)
    asyncio.run(run_ws())


if __name__ == "__main__":
    main()
