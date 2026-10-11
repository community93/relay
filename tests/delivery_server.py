import json
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body=json.dumps({'data':[{'id':1,'name':'Demo'},{'id':2,'active':True}], 'accessToken':'response-secret-for-export'},ensure_ascii=False).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def do_POST(self):
        length=int(self.headers.get('Content-Length') or 0)
        if length:self.rfile.read(length)
        self.do_GET()
    def log_message(self,*args):pass
ThreadingHTTPServer(('127.0.0.1',18999),Handler).serve_forever()
