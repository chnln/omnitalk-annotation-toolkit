"""Exercise actual HTTP requests against temporary, isolated assets."""

from contextlib import redirect_stderr
from http.client import HTTPConnection
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from unittest.mock import patch

from annotation_toolkit import __version__
from annotation_toolkit.downloads import DownloadError, DownloadManager
from annotation_toolkit.server import create_server, main
from test_downloads import project_fixture


class AnnotationServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = TemporaryDirectory()
        root = Path(cls.temp.name)
        cls.assets = root / "static"
        cls.assets.mkdir()
        (cls.assets / "index.html").write_text("<h1>Local workspace</h1>")
        (cls.assets / "app.js").write_text("console.log('local');")
        (cls.assets / "nested").mkdir()
        (cls.assets / "nested" / "index.html").write_text("No directory routing")
        (root / "private.txt").write_text("PRIVATE CONTENT")
        (cls.assets / "escape.txt").symlink_to(root / "private.txt")
        (cls.assets / "escape-dir").symlink_to(root, target_is_directory=True)
        cls.server = create_server(0, static_root=cls.assets, download_dir=root / "downloads")
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        cls.temp.cleanup()

    def request(self, path, method="GET", body=None, headers=None):
        connection = HTTPConnection(*self.server.server_address, timeout=2)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_loopback_binding(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")

    def test_home_and_headers(self):
        status, headers, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn(b"Local workspace", body)
        self.assertEqual(headers["Content-Type"], "text/html; charset=utf-8")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Referrer-Policy"], "strict-origin-when-cross-origin")
        self.assertEqual(headers["Cache-Control"], "no-cache")

    def test_javascript_with_query(self):
        status, headers, body = self.request("/app.js?v=1")
        self.assertEqual(status, 200)
        self.assertIn("javascript", headers["Content-Type"])
        self.assertEqual(body, b"console.log('local');")

    def test_head_has_headers_but_no_body(self):
        status, headers, body = self.request("/", "HEAD")
        self.assertEqual(status, 200)
        self.assertGreater(int(headers["Content-Length"]), 0)
        self.assertEqual(body, b"")

    def test_health(self):
        status, headers, body = self.request("/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
        self.assertEqual(json.loads(body), {
            "status": "ok", "app": "omnitalk-annotation-toolkit",
            "version": __version__,
        })

    def test_no_listings_or_missing_assets(self):
        for path in ("/nested", "/nested/", "/missing", "/api/unknown"):
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 404)

    def test_cannot_read_outside_assets(self):
        for path in (
            "/../private.txt", "/%2e%2e/private.txt", "/%2e%2e%2fprivate.txt",
            "/nested/../../private.txt", "/escape.txt", "/escape-dir/private.txt",
            "/%00", "/..%5cprivate.txt", "/%252e%252e/private.txt",
        ):
            with self.subTest(path=path):
                status, _, body = self.request(path)
                self.assertEqual(status, 404)
                self.assertNotIn(b"PRIVATE CONTENT", body)

    def post(self, path, data, **headers):
        defaults = {"Origin": f"http://127.0.0.1:{self.server.server_address[1]}",
                    "Content-Type": "application/json"}
        defaults.update(headers)
        return self.request(path, "POST", json.dumps(data).encode(), defaults)

    def test_download_status_and_capability_shape(self):
        status, _, body = self.request("/api/downloads")
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertIn("jobs", data)
        self.assertEqual(set(data["capabilities"]), {"ready", "yt_dlp", "ffmpeg", "js_runtime", "download_dir", "qualities", "default_quality"})
        self.assertTrue(Path(data["capabilities"]["download_dir"]).is_absolute())
        self.assertEqual(data["capabilities"]["default_quality"], "1080")
        self.assertIn("best", data["capabilities"]["qualities"])

    def test_cross_origin_and_untrusted_host_requests_fail(self):
        for headers in ({"Origin": "https://evil.invalid"}, {"Host": "evil.invalid"},
                        {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                status, _, body = self.request("/api/downloads", headers=headers)
                self.assertEqual(status, 400)
                self.assertIn("error", json.loads(body))
        for headers in ({"Origin": "null"}, {"Content-Type": "text/plain"}, {"Host": "evil.invalid"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.post("/api/downloads", {}, **headers)[0], 400)
        self.assertEqual(self.request("/api/downloads", "POST", b"{}", {"Content-Type": "application/json"})[0], 400)

    def test_json_body_limit_and_malformed_json_rejected(self):
        origin = f"http://127.0.0.1:{self.server.server_address[1]}"
        headers = {"Origin": origin, "Content-Type": "application/json", "Content-Length": str(64 * 1024 * 1024 + 1)}
        self.assertEqual(self.request("/api/exports", "POST", b"", headers)[0], 400)
        for body in (b"{", b"{\"number\": NaN}", b"\xff"):
            headers = {"Origin": origin, "Content-Type": "application/json"}
            self.assertEqual(self.request("/api/exports", "POST", body, headers)[0], 400)

    def test_invalid_download_does_not_queue_and_errors_are_json(self):
        before = len(self.server.downloads.snapshot()["jobs"])
        status, _, body = self.post("/api/downloads", {"video_id": "file:///private", "scope": "full"})
        self.assertEqual(status, 400)
        self.assertIn("error", json.loads(body))
        self.assertEqual(len(self.server.downloads.snapshot()["jobs"]), before)

    def test_download_api_accepts_job_and_reports_real_local_completion(self):
        def runner(job, root, update):
            root.mkdir(parents=True, exist_ok=True)
            target = root / f"{job['id']}.mp4"
            target.write_bytes(b"mock media")
            return target
        root = Path(self.temp.name) / "mock-downloads"
        manager = DownloadManager(root, runner=runner)
        manager.capabilities["ready"] = True
        with patch.object(self.server, "downloads", manager):
            status, _, body = self.post("/api/downloads", {"video_id": "jNQXAC9IVRw", "scope": "full"})
            self.assertEqual(status, 202)
            created = json.loads(body)["job"]
            self.assertEqual(created["status"], "queued")
            manager._queue.join()
            status, _, body = self.request("/api/downloads")
            self.assertEqual(status, 200)
            finished = json.loads(body)["jobs"][0]
            self.assertEqual(finished["id"], created["id"])
            self.assertEqual(finished["status"], "completed")
            self.assertTrue(Path(finished["path"]).is_file())

    def test_batch_api_queues_to_chosen_folder_and_rejects_invalid_batch_atomically(self):
        def runner(job, root, update):
            target = root / f"{job['id']}.mp4"
            target.write_bytes(b"mock media")
            return target
        selected = Path(self.temp.name).resolve() / "selected"
        selected.mkdir(exist_ok=True)
        manager = DownloadManager(Path(self.temp.name) / "default", runner=runner)
        manager.capabilities["ready"] = True
        clip = {"video_id": "jNQXAC9IVRw", "scope": "clip", "start_seconds": 1, "end_seconds": 2}
        with patch.object(self.server, "downloads", manager):
            status, _, body = self.post("/api/downloads/batch", {"downloads": [clip] * 5, "destination": str(selected)})
            self.assertEqual(status, 202)
            response = json.loads(body)
            jobs = response["jobs"]
            self.assertEqual(len(jobs), 5)
            shared = Path(response["destination"])
            self.assertEqual(shared.parent, selected)
            self.assertTrue(all(job["destination"] == str(shared) for job in jobs))
            manager._queue.join()
            self.assertTrue(all(job["status"] == "completed" for job in manager.snapshot()["jobs"]))
            self.assertEqual(list(selected.iterdir()), [shared])
            self.assertEqual(len(list(shared.iterdir())), 5)
            self.assertTrue(all(path.is_file() and path.suffix == ".mp4" for path in shared.iterdir()))
            status, _, body = self.post("/api/downloads/batch", {"downloads": [clip, {}], "destination": str(selected)})
            self.assertEqual(status, 400)
            self.assertIn("error", json.loads(body))
            self.assertEqual(len(manager.snapshot()["jobs"]), 5)
            self.assertEqual(list(selected.iterdir()), [shared])

    def test_folder_picker_api_cancel_errors_and_origin_protection(self):
        for selected in (str(Path(self.temp.name).resolve()), None):
            with patch("annotation_toolkit.server.choose_download_folder", return_value=selected) as choose:
                status, _, body = self.post("/api/downloads/choose-folder", {})
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body), {"path": selected})
                choose.assert_called_once_with()
        with patch("annotation_toolkit.server.choose_download_folder") as choose:
            self.assertEqual(self.post("/api/downloads/choose-folder", {"script": "untrusted"})[0], 400)
            self.assertEqual(self.post("/api/downloads/choose-folder", {}, Origin="https://evil.invalid")[0], 400)
            choose.assert_not_called()
        with patch("annotation_toolkit.server.choose_download_folder", side_effect=DownloadError("Enter a folder manually.", 503)):
            status, _, body = self.post("/api/downloads/choose-folder", {})
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(body), {"error": "Enter a folder manually."})

    def test_export_api_saves_real_json_and_no_download_file_route_exists(self):
        project = project_fixture()
        status, _, body = self.post("/api/exports", project)
        self.assertEqual(status, 201)
        result = json.loads(body)
        target = Path(result["path"])
        self.assertEqual(json.loads(target.read_text(encoding="utf-8")), project)
        self.assertEqual(self.request(f"/downloads/annotations/{result['filename']}")[0], 404)

    def test_unknown_write_route_is_rejected(self):
        self.assertEqual(self.post("/api/health", {})[0], 400)

    def test_port_conflict_has_actionable_cli_error(self):
        error_output = io.StringIO()
        port = self.server.server_address[1]
        with redirect_stderr(error_output):
            exit_code = main(["--no-browser", "--port", str(port)])
        self.assertEqual(exit_code, 1)
        self.assertIn(f"Port {port} is already in use", error_output.getvalue())
        self.assertIn("--port", error_output.getvalue())


if __name__ == "__main__":
    unittest.main()
