"""Isolated real HTTP fixture for assertions and scoped variable chains."""
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self): self.do_GET()
    def do_DELETE(self): self.do_GET()
    def do_GET(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length', '0'))).decode('utf-8')
        status = 200
        if self.path == '/login': value = {'data': {'token': 'chain-token', 'count': 0, 'valid': False, 'nil': None}}
        elif self.path == '/no-token': value = {'data': {}}
        elif self.path == '/deny': status = 401; value = {'error': 'unauthorized'}
        elif self.path == '/slow': time.sleep(1); value = {'done': True}
        elif self.path == '/bad-json': value = None
        else:
            if self.headers.get('Authorization') != 'Bearer chain-token': status = 401
            value = {'id': 7, 'name': 'demo', 'authorized': status == 200, 'received': raw, 'tenant': self.headers.get('X-Tenant', '')}
        body = (json.dumps(value) if value is not None else 'not json').encode()
        self.send_response(status); self.send_header('Content-Type', 'application/json'); self.send_header('X-Token', 'header-token'); self.send_header('Content-Length', str(len(body))); self.end_headers()
        try: self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError): pass

if __name__ == '__main__': ThreadingHTTPServer(('127.0.0.1', 19110), Handler).serve_forever()
