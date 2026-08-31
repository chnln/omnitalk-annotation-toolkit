"""Serve the bundled annotation workspace on this computer only."""

from __future__ import annotations

import argparse
import errno
from functools import partial
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import sys
from urllib.parse import unquote, urlsplit
import webbrowser

from . import __version__
from .downloads import DownloadError, DownloadManager, default_download_directory, save_export
from .folders import choose_download_folder

HOST = "127.0.0.1"
DEFAULT_PORT = 8765
STATIC_ROOT = Path(__file__).resolve().parent / "static"
MAX_REQUEST_BYTES = 64 * 1024 * 1024


class AnnotationHandler(BaseHTTPRequestHandler):
    """Loopback application routes with same-origin writes and confined files."""

    server_version = f"OmniTalkAnnotation/{__version__}"
    sys_version = ""

    def __init__(self, *args, static_root: Path = STATIC_ROOT, **kwargs):
        self.static_root = static_root.resolve()
        super().__init__(*args, **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        # YouTube uses this origin to identify the embedding client.
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if self._trusted_host():
            self._serve(include_body=True)

    def do_HEAD(self):
        if self._trusted_host():
            self._serve(include_body=False)

    def _trusted_host(self):
        hosts = self.headers.get_all("Host", [])
        port = self.server.server_address[1]
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if port == 80:
            allowed.update({"127.0.0.1", "localhost"})
        if len(hosts) != 1 or hosts[0].lower() not in allowed:
            self._json({"error": "Only the local toolkit host is allowed."}, 400)
            return False
        origins = self.headers.get_all("Origin", [])
        if (origins and origins != [f"http://{hosts[0]}"]
                or self.headers.get("Sec-Fetch-Site") == "cross-site"):
            self._json({"error": "Cross-origin toolkit requests are not allowed."}, 400)
            return False
        return True

    def do_POST(self):
        if not self._trusted_host():
            return
        if self.headers.get_all("Origin", []) != [f"http://{self.headers['Host']}"]:
            self._json({"error": "A same-origin browser request is required."}, 400)
            return
        if self.headers.get_content_type() != "application/json":
            self._json({"error": "Content-Type must be application/json."}, 400)
            return
        if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) != 1:
            self._json({"error": "One Content-Length header is required; chunked requests are not accepted."}, 400)
            return
        try:
            length = int(self.headers["Content-Length"])
        except ValueError:
            length = -1
        if not 0 < length <= MAX_REQUEST_BYTES:
            self._json({"error": "JSON requests must contain between 1 byte and 64 MB."}, 400)
            return
        try:
            path = urlsplit(self.path).path
        except ValueError:
            self._json({"error": "Invalid local API URL."}, 400)
            return
        if path not in {"/api/downloads", "/api/downloads/batch", "/api/downloads/choose-folder", "/api/exports"}:
            self._json({"error": "This local API route does not exist."}, 400)
            return
        self.connection.settimeout(30)
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete body")
            data = json.loads(raw.decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        except (UnicodeDecodeError, ValueError, RecursionError, OSError):
            self._json({"error": "The request body must be complete, valid UTF-8 JSON with finite numbers."}, 400)
            return
        try:
            if path == "/api/downloads":
                self._json({"job": self.server.downloads.submit(data)}, 202)
            elif path == "/api/downloads/batch":
                jobs = self.server.downloads.submit_batch(data)
                self._json({"jobs": jobs, "destination": jobs[0]["destination"]}, 202)
            elif path == "/api/downloads/choose-folder":
                if not isinstance(data, dict) or data:
                    raise DownloadError("The folder-picker request must be an empty JSON object.")
                self._json({"path": choose_download_folder()})
            else:
                self._json(save_export(data, self.server.downloads.download_dir), 201)
        except DownloadError as error:
            self._json({"error": str(error)}, error.status)
        except OSError as error:
            self._json({"error": f"Cannot save to the local output folder: {error}"}, 503)

    def _json(self, data, status=200, include_body=True):
        self._respond(json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8"),
                      "application/json; charset=utf-8", include_body, status)

    def _serve(self, *, include_body: bool):
        try:
            path = unquote(urlsplit(self.path).path, errors="strict")
        except (UnicodeDecodeError, ValueError):
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid URL")
            return

        if path == "/api/health":
            body = json.dumps({
                "status": "ok", "app": "omnitalk-annotation-toolkit",
                "version": __version__,
            }).encode("utf-8")
            self._respond(body, "application/json; charset=utf-8", include_body)
            return

        if path == "/api/downloads":
            self._json(self.server.downloads.snapshot(), include_body=include_body)
            return

        # Reject traversal before resolving; resolve() also catches symlinks.
        if "\x00" in path or "\\" in path or ".." in path.split("/"):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        relative = "index.html" if path == "/" else path.lstrip("/")
        try:
            asset = (self.static_root / relative).resolve()
            if not asset.is_relative_to(self.static_root) or not asset.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            body = asset.read_bytes()
        except (OSError, RuntimeError, ValueError):
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        content_type = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
        if asset.suffix in {".js", ".mjs"}:
            content_type = "text/javascript"
        if content_type.startswith("text/"):
            content_type += "; charset=utf-8"
        self._respond(body, content_type, include_body)

    def _respond(self, body: bytes, content_type: str, include_body: bool, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if include_body:
            self.wfile.write(body)


def create_server(port: int = DEFAULT_PORT, *, static_root: Path = STATIC_ROOT,
                  download_dir: Path | None = None, download_manager=None):
    """Bind only to IPv4 loopback. Port 0 is useful for isolated tests."""
    handler = partial(AnnotationHandler, static_root=static_root)
    server = ThreadingHTTPServer((HOST, port), handler)
    server.downloads = download_manager or DownloadManager(download_dir)
    return server


def _port(value: str) -> int:
    try:
        port = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("port must be an integer") from error
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Open the OmniTalk video annotation workspace locally."
    )
    parser.add_argument("--port", type=_port, default=DEFAULT_PORT,
                        help=f"local port (default: {DEFAULT_PORT})")
    parser.add_argument("--no-browser", action="store_true",
                        help="do not open the default browser automatically")
    parser.add_argument("--download-dir", type=Path, default=default_download_directory(),
                        help="folder for videos and annotation JSON (default: ~/Downloads)")
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args(argv)

    try:
        server = create_server(args.port, download_dir=args.download_dir)
    except OSError as error:
        if error.errno == errno.EADDRINUSE:
            alternative = args.port + 1 if args.port < 65535 else DEFAULT_PORT
            print(f"Port {args.port} is already in use. Try --port {alternative}.",
                  file=sys.stderr)
        else:
            print(f"Cannot start the local server: {error}", file=sys.stderr)
        return 1

    url = f"http://{HOST}:{args.port}"
    print(f"OmniTalk annotation toolkit · {url}", flush=True)
    print("Local access only. Press Ctrl+C to stop.", flush=True)
    print(f"Downloads and exports: {server.downloads.download_dir}", flush=True)
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except webbrowser.Error:
            print(f"Open {url} in your browser.", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nAnnotation server stopped.")
    finally:
        server.server_close()
    return 0
