# Local server for the ASCII Engine with caching off, so a reload always picks up the latest files.
# Run from this folder:  python3 serve.py   then open http://localhost:5183
import http.server
import socketserver


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', 5183), NoCache) as httpd:
    print('ASCII Engine on http://localhost:5183')
    httpd.serve_forever()
