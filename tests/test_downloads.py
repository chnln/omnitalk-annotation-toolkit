from copy import deepcopy
import errno
import json
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
from threading import Event
import unittest
from unittest.mock import patch
from uuid import uuid4

from annotation_toolkit.downloads import (
    DownloadError, DownloadManager, MAX_PENDING, QUALITIES, _check_metadata,
    _prepare_mp4, _publish_mp4, default_download_directory, download_video,
    format_selector, save_export, validate_request,
)


def project_fixture():
    stamp = "2026-08-31T00:00:00.000Z"
    return {
        "schema_version": "1.0", "project_id": str(uuid4()),
        "project_name": "中文 annotations", "annotator": {"id": "local", "name": "参与者"},
        "created_at": stamp, "updated_at": stamp,
        "videos": [{"id": str(uuid4()), "source": "youtube", "video_id": "jNQXAC9IVRw",
                    "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw", "title": "Example",
                    "duration_seconds": 19, "created_at": stamp,
                    "clips": [{"id": str(uuid4()), "start_seconds": 1.125, "end_seconds": 6.125,
                               "note": "原始备注 🦒", "tags": ["interruption"],
                               "created_at": stamp, "updated_at": stamp}]}],
    }


def capabilities(path):
    return {"ready": True, "yt_dlp": True, "ffmpeg": True,
            "js_runtime": "node", "download_dir": str(path),
            "qualities": list(QUALITIES), "default_quality": "1080"}


def mp4_probe(width=640, height=360):
    return {"video": {"codec_name": "h264", "width": width, "height": height},
            "audio": {"codec_name": "aac"}, "format": "mov,mp4,m4a,3gp,3g2,mj2"}


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / "downloads"

    def manager(self, runner):
        with patch("annotation_toolkit.downloads.detect_capabilities", side_effect=capabilities):
            return DownloadManager(self.root, runner=runner)

    def test_untrusted_download_inputs_rejected_without_jobs(self):
        manager = self.manager(lambda *args: None)
        requests = [None, [], {}, {"video_id": "https://evil.invalid/video", "scope": "full"},
                    {"video_id": "jNQXAC9IVRw", "scope": []},
                    {"video_id": "../private", "scope": "full"},
                    {"video_id": "jNQXAC9IVRw", "scope": "full", "path": "/tmp/escape"}]
        for start, end in [(1, 1), (4, 3), (-1, 5), (True, 4), (0, float("inf")),
                           (0, float("nan")), (0, 10 ** 500), (0, 604801)]:
            requests.append({"video_id": "jNQXAC9IVRw", "scope": "clip",
                             "start_seconds": start, "end_seconds": end})
        for request in requests:
            with self.subTest(request=str(request)[:100]), self.assertRaises(DownloadError):
                manager.submit(request)
        self.assertEqual(manager.snapshot()["jobs"], [])
        self.assertFalse(self.root.exists())

    def test_metadata_rejects_live_playlist_wrong_id_and_bad_bounds(self):
        job = validate_request({"video_id": "jNQXAC9IVRw", "scope": "clip",
                                "start_seconds": 1.125, "end_seconds": 6.125})
        valid = {"id": job["video_id"], "duration": 19, "live_status": "not_live"}
        _check_metadata(valid, job)
        for changes in ({"is_live": True}, {"live_status": "is_upcoming"},
                        {"_type": "playlist"}, {"id": "wrong"}, {"duration": 5}, {"entries": []}):
            with self.subTest(changes=changes), self.assertRaises(DownloadError):
                _check_metadata({**valid, **changes}, job)

    def test_full_video_requires_finite_duration(self):
        job = validate_request({"video_id": "jNQXAC9IVRw", "scope": "full"})
        with self.assertRaises(DownloadError):
            _check_metadata({"id": job["video_id"], "duration": None}, job)

    def test_safe_downloader_options_and_exact_fractional_range(self):
        captured = {}

        class FakeDownloader:
            def __init__(self, options):
                captured.update(options)

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def extract_info(self, url, download):
                self.assertions = (url, download)
                captured["url"] = url
                captured["metadata_only"] = not download
                return {"id": "jNQXAC9IVRw", "duration": 19}

            def process_ie_result(self, info, download):
                target = Path(captured["paths"]["home"]) / captured["outtmpl"].replace("%(ext)s", "mp4")
                target.write_bytes(b"mock media with audio")
                captured["download"] = download

        job = {"id": str(uuid4()), **validate_request({"video_id": "jNQXAC9IVRw", "scope": "clip",
                                                       "start_seconds": 1.125, "end_seconds": 6.125})}
        updates = []
        with patch("yt_dlp.YoutubeDL", FakeDownloader), patch("annotation_toolkit.downloads._runtime", return_value=("node", "/bin/node")), patch("annotation_toolkit.downloads.shutil.which", return_value="/bin/ffmpeg"), patch("annotation_toolkit.downloads._probe_media", return_value=mp4_probe()):
            target = download_video(job, self.root, lambda **kwargs: updates.append(kwargs))
        self.assertEqual(target.parent, self.root)
        self.assertEqual(target.suffix, ".mp4")
        self.assertIn(job["id"], target.name)
        self.assertIn("1080p", target.name)
        self.assertEqual(list(self.root.iterdir()), [target])
        self.assertIn({"width": 640, "height": 360}, updates)
        self.assertEqual(captured["url"], "https://www.youtube.com/watch?v=jNQXAC9IVRw")
        self.assertTrue(captured["metadata_only"])
        self.assertTrue(captured["download"])
        self.assertEqual(list(captured["download_ranges"]({}, None)), [{"start_time": 1.125, "end_time": 6.125}])
        self.assertTrue(captured["force_keyframes_at_cuts"])
        self.assertEqual(captured["format_sort"], ["lang", "res", "vcodec:h264", "acodec:aac", "vext:mp4", "aext:m4a"])
        self.assertEqual(captured["allowed_extractors"], ["youtube"])
        self.assertIn("height<=1080", captured["format"])
        self.assertIsNone(captured["cookiesfrombrowser"])
        self.assertFalse(captured["cachedir"])
        self.assertFalse(captured["enable_file_urls"])
        self.assertEqual(captured["remote_components"], [])
        self.assertEqual(captured["js_runtimes"], {"node": {"path": "/bin/node"}})
        from yt_dlp.globals import plugin_dirs
        self.assertEqual(plugin_dirs.value, [])

    def test_queue_is_bounded_and_worker_survives_failures(self):
        started, release = Event(), Event()
        calls = []

        def runner(job, root, update):
            calls.append(job["id"])
            if len(calls) == 1:
                started.set()
                release.wait(timeout=3)
                raise RuntimeError("Simulated network failure")
            root.mkdir(parents=True, exist_ok=True)
            path = root / f"{job['id']}.mp4"
            path.write_bytes(b"media")
            return path

        with patch("annotation_toolkit.downloads.MAX_PENDING", 3):
            manager = self.manager(runner)
        request = {"video_id": "jNQXAC9IVRw", "scope": "full"}
        first = manager.submit(request)
        self.assertTrue(started.wait(timeout=2))
        for _ in range(3):
            manager.submit(request)
        with self.assertRaises(DownloadError) as error:
            manager.submit(request)
        self.assertEqual(error.exception.status, 409)
        release.set()
        manager._queue.join()
        jobs = manager.snapshot()["jobs"]
        self.assertEqual(len(jobs), 4)
        self.assertEqual(next(job for job in jobs if job["id"] == first["id"])["status"], "failed")
        self.assertEqual(sum(job["status"] == "completed" for job in jobs), 3)

    def test_history_is_bounded_and_outside_output_is_not_success(self):
        outside = Path(self.temp.name) / "outside.mp4"
        outside.write_bytes(b"not a permitted output")
        manager = self.manager(lambda *args: outside)
        with patch("annotation_toolkit.downloads.MAX_HISTORY", 50):
            for _ in range(52):
                manager.submit({"video_id": "jNQXAC9IVRw", "scope": "full"})
                manager._queue.join()
        jobs = manager.snapshot()["jobs"]
        self.assertEqual(len(jobs), 50)
        self.assertTrue(all(job["status"] == "failed" for job in jobs))
        self.assertTrue(all(job["path"] is None for job in jobs))

    def test_selected_destination_is_resolved_and_used_for_every_batch_job(self):
        selected = Path(self.temp.name).resolve() / "chosen folder 中文"
        selected.mkdir()
        alias = Path(self.temp.name).resolve() / "folder-alias"
        alias.symlink_to(selected, target_is_directory=True)
        seen = []

        def runner(job, root, update):
            seen.append(root)
            target = root / f"{job['id']}.mp4"
            target.write_bytes(b"mock media")
            return target

        manager = self.manager(runner)
        request = {"video_id": "jNQXAC9IVRw", "scope": "clip", "start_seconds": 1, "end_seconds": 2}
        first = manager.submit({**request, "destination": str(alias)})
        batch = manager.submit_batch({"downloads": [request] * 6, "destination": str(alias)})
        manager._queue.join()
        shared = Path(batch[0]["destination"])
        self.assertEqual(shared.parent, selected)
        self.assertTrue(shared.name.startswith("omnitalk_jNQXAC9IVRw_clips_"))
        self.assertEqual(seen, [selected] + [shared] * 6)
        self.assertEqual(first["destination"], str(selected))
        self.assertEqual(len(batch), 6)
        self.assertTrue(all(job["destination"] == str(shared) for job in batch))
        self.assertEqual(len(list(selected.glob("*.mp4"))), 1)
        self.assertEqual(len(list(shared.iterdir())), 6)
        self.assertTrue(all(path.is_file() and path.suffix == ".mp4" for path in shared.iterdir()))
        self.assertEqual(len(list(selected.iterdir())), 2)
        self.assertFalse(self.root.exists())
        self.assertTrue(all(Path(job["path"]).is_relative_to(selected) for job in manager.snapshot()["jobs"]))

    def test_batch_is_validated_atomically_and_missing_custom_paths_rejected(self):
        manager = self.manager(lambda *args: None)
        request = {"video_id": "jNQXAC9IVRw", "scope": "clip", "start_seconds": 1, "end_seconds": 2}
        cases = [
            {"downloads": [], "destination": str(self.root)},
            {"downloads": [request] * (MAX_PENDING + 1), "destination": str(self.root)},
            {"downloads": [request, {**request, "end_seconds": 0}], "destination": str(self.root)},
            {"downloads": [request, {**request, "destination": "/tmp"}], "destination": str(self.root)},
            {"downloads": [request], "destination": "relative"},
            {"downloads": [request], "destination": str(self.root.parent / "missing")},
            {"downloads": [request]},
        ]
        for payload in cases:
            with self.subTest(keys=payload.keys()), self.assertRaises(DownloadError):
                manager.submit_batch(payload)
        for destination in (None, [], "", "~", "file:///tmp", "relative", str(self.root.parent / "missing")):
            with self.subTest(destination=destination), self.assertRaises(DownloadError):
                manager.submit({**request, "destination": destination})
        self.assertEqual(manager.snapshot()["jobs"], [])
        self.assertFalse(self.root.exists())

    def test_whole_ten_thousand_clip_batch_and_atomic_queue_capacity(self):
        started, release = Event(), Event()

        def runner(*args):
            started.set()
            release.wait(timeout=5)
            raise RuntimeError("Mock failure without media or files")

        manager = self.manager(runner)
        request = {"video_id": "jNQXAC9IVRw", "scope": "clip", "start_seconds": 1, "end_seconds": 2}
        self.assertEqual(manager._queue.maxsize, 10000)
        jobs = manager.submit_batch({"downloads": [request] * 10000, "destination": str(self.root)})
        self.assertEqual(len(jobs), 10000)
        self.assertEqual(len({job["id"] for job in jobs}), 10000)
        shared = Path(jobs[0]["destination"])
        self.assertEqual(shared.parent, self.root)
        self.assertEqual(list(self.root.iterdir()), [shared])
        self.assertTrue(started.wait(timeout=2))
        try:
            with self.assertRaises(DownloadError) as error:
                manager.submit_batch({"downloads": [request, request], "destination": str(self.root)})
            self.assertEqual(error.exception.status, 409)
            self.assertEqual(len(manager.snapshot()["jobs"]), 10000)
            self.assertEqual(list(self.root.iterdir()), [shared])
        finally:
            release.set()
        manager._queue.join()
        self.assertEqual(len(manager.snapshot()["jobs"]), 10000)
        self.assertTrue(all(job["status"] == "failed" for job in manager.snapshot()["jobs"]))
        self.assertEqual(list(self.root.iterdir()), [shared])
        self.assertEqual(list(shared.iterdir()), [])

    def test_batch_folder_creation_failure_cannot_enqueue_any_jobs(self):
        manager = self.manager(lambda *args: None)
        request = {"video_id": "jNQXAC9IVRw", "scope": "clip", "start_seconds": 1, "end_seconds": 2}
        with patch("annotation_toolkit.downloads.tempfile.mkdtemp", side_effect=PermissionError("not writable")):
            with self.assertRaises(PermissionError):
                manager.submit_batch({"downloads": [request] * 3, "destination": str(self.root)})
        self.assertEqual(manager.snapshot()["jobs"], [])
        self.assertEqual(manager._queue.qsize(), 0)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_separate_batches_never_reuse_or_overwrite_a_shared_folder(self):
        def runner(job, destination, update):
            path = destination / "clip.mp4"
            path.write_bytes(job["id"].encode())
            return path

        manager = self.manager(runner)
        request = {"video_id": "jNQXAC9IVRw", "scope": "clip", "start_seconds": 1, "end_seconds": 2}
        payload = {"downloads": [request], "destination": str(self.root)}
        first = manager.submit_batch(payload)[0]
        manager._queue.join()
        first_folder = Path(first["destination"])
        original = (first_folder / "clip.mp4").read_bytes()
        second = manager.submit_batch(payload)[0]
        manager._queue.join()
        self.assertNotEqual(first["destination"], second["destination"])
        self.assertEqual((first_folder / "clip.mp4").read_bytes(), original)
        self.assertEqual(len(list(self.root.iterdir())), 2)

    def test_flat_publication_never_overwrites_existing_files(self):
        self.root.mkdir()
        existing = self.root / "video_full_1080p_unique.mp4"
        existing.write_bytes(b"existing user file")
        with TemporaryDirectory(dir=self.root, prefix=".omnitalk-") as temporary:
            source = Path(temporary) / "source.mp4"
            source.write_bytes(b"new media")
            result = _publish_mp4(source, self.root, existing.stem)
        self.assertNotEqual(result, existing)
        self.assertEqual(result.parent, self.root)
        self.assertEqual(result.read_bytes(), b"new media")
        self.assertEqual(existing.read_bytes(), b"existing user file")
        self.assertEqual(set(self.root.iterdir()), {existing, result})

    def test_publication_fallback_is_exclusive_and_cleans_failed_copy(self):
        self.root.mkdir()
        with TemporaryDirectory(dir=self.root, prefix=".omnitalk-") as temporary:
            source = Path(temporary) / "source.mp4"
            source.write_bytes(b"new media")
            existing = self.root / "keep.mp4"
            existing.write_bytes(b"existing")
            with patch("annotation_toolkit.downloads.os.link", side_effect=OSError(errno.ENOTSUP, "unsupported")):
                result = _publish_mp4(source, self.root, "keep")
                self.assertEqual(result.read_bytes(), b"new media")
                self.assertEqual(existing.read_bytes(), b"existing")
                with patch("annotation_toolkit.downloads.shutil.copyfileobj", side_effect=OSError("disk full")), self.assertRaises(OSError):
                    _publish_mp4(source, self.root, "failed")
            self.assertFalse((self.root / "failed.mp4").exists())

    def test_failed_download_removes_hidden_staging_and_partial_media(self):
        job = {"id": str(uuid4()), **validate_request({"video_id": "jNQXAC9IVRw", "scope": "full"})}
        with patch("yt_dlp.YoutubeDL") as downloader, patch("annotation_toolkit.downloads._runtime", return_value=("node", "/bin/node")), patch("annotation_toolkit.downloads.shutil.which", return_value="/bin/ffmpeg"):
            client = downloader.return_value.__enter__.return_value
            client.extract_info.return_value = {"id": job["video_id"], "duration": 19}

            def fail(*args, **kwargs):
                folder = Path(downloader.call_args.args[0]["paths"]["home"])
                (folder / "source.mp4.part").write_bytes(b"partial")
                raise RuntimeError("network failed")

            client.process_ie_result.side_effect = fail
            with self.assertRaises(RuntimeError):
                download_video(job, self.root, lambda **kwargs: None)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_default_download_folder_belongs_to_each_runtime_user(self):
        for participant in ("participant-one", "participant-two"):
            home = Path(self.temp.name).resolve() / participant
            with patch.object(Path, "home", return_value=home), patch("annotation_toolkit.downloads.detect_capabilities", side_effect=capabilities):
                manager = DownloadManager()
                self.assertEqual(default_download_directory(), home / "Downloads")
                self.assertEqual(manager.download_dir, home / "Downloads")
            self.assertFalse(home.exists())

    def test_invalid_quality_rejects_single_and_whole_batch(self):
        manager = self.manager(lambda *args: None)
        request = {"video_id": "jNQXAC9IVRw", "scope": "full"}
        self.assertEqual(validate_request(request)["quality"], "1080")
        for quality in (None, 1080, [], "1080p", "9999", "best/evil", ""):
            with self.subTest(quality=quality), self.assertRaises(DownloadError):
                manager.submit({**request, "quality": quality})
            with self.assertRaises(DownloadError):
                manager.submit_batch({"downloads": [request, {**request, "quality": quality}], "destination": str(self.root)})
        self.assertEqual(manager.snapshot()["jobs"], [])

    def test_actual_yt_dlp_selection_respects_quality_and_original_audio(self):
        from yt_dlp import YoutubeDL
        from yt_dlp.globals import plugin_dirs
        plugin_dirs.value = []
        formats = [{"format_id": f"v{height}", "url": f"https://example.invalid/v{height}",
                    "ext": "mp4" if height < 1080 else "webm", "vcodec": "h264" if height < 1080 else "vp9",
                    "acodec": "none", "height": height, "width": height * 16 // 9}
                   for height in (360, 720, 1080, 1440, 2160, 4320)]
        formats.extend([
            {"format_id": "original", "url": "https://example.invalid/original", "ext": "webm", "vcodec": "none",
             "acodec": "opus", "language_preference": 10, "quality": 1},
            {"format_id": "dub", "url": "https://example.invalid/dub", "ext": "m4a", "vcodec": "none",
             "acodec": "aac", "language_preference": 5, "quality": 3},
        ])
        for quality, expected_height in (("best", 4320), ("2160", 2160), ("1440", 1440), ("1080", 1080),
                                         ("720", 720), ("480", 360), ("360", 360)):
            with self.subTest(quality=quality), YoutubeDL({"quiet": True, "no_warnings": True, "check_formats": False,
                    "format": format_selector(quality), "cachedir": False,
                    "format_sort": ["lang", "res", "vcodec:h264", "acodec:aac", "vext:mp4", "aext:m4a"]}) as downloader:
                info = downloader.process_ie_result({"id": "synthetic", "title": "Synthetic", "duration": 1,
                                                     "formats": deepcopy(formats)}, download=False)
                self.assertEqual(info["height"], expected_height)
                self.assertEqual(info["format_id"], f"v{expected_height}+original")

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg binaries not installed")
    def test_real_ffmpeg_converts_incompatible_media_to_mp4_without_upscaling(self):
        self.root.mkdir()
        source = self.root / "synthetic.mkv"
        subprocess.run([shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                        "testsrc=size=160x90:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
                        "-t", "0.4", "-c:v", "mpeg4", "-c:a", "mp2", "-shortest", str(source)],
                       check=True, capture_output=True, timeout=30)
        updates = []
        target = _prepare_mp4(source, self.root, shutil.which("ffmpeg"), shutil.which("ffprobe"), "360",
                              lambda **fields: updates.append(fields))
        self.assertEqual(target.suffix, ".mp4")
        self.assertGreater(target.stat().st_size, 0)
        self.assertIn({"width": 160, "height": 90}, updates)

    def test_verification_rejects_media_above_the_quality_cap(self):
        self.root.mkdir()
        source = self.root / "source.mp4"
        source.write_bytes(b"mock")
        with patch("annotation_toolkit.downloads._probe_media", return_value=mp4_probe(1920, 1080)), self.assertRaises(DownloadError):
            _prepare_mp4(source, self.root, "ffmpeg", "ffprobe", "720", lambda **fields: None)

    def test_missing_capabilities_do_not_queue(self):
        manager = self.manager(lambda *args: None)
        manager.capabilities["ready"] = False
        with self.assertRaises(DownloadError) as error:
            manager.submit({"video_id": "jNQXAC9IVRw", "scope": "full"})
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(manager.snapshot()["jobs"], [])

    def test_export_is_utf8_atomic_and_generated_under_output_root(self):
        project = project_fixture()
        result = save_export(project, self.root)
        target = Path(result["path"])
        self.assertTrue(target.is_relative_to(self.root / "annotations"))
        self.assertEqual(target.name, result["filename"])
        self.assertEqual(json.loads(target.read_text(encoding="utf-8")), project)
        self.assertIn("原始备注", target.read_text(encoding="utf-8"))
        self.assertEqual(len(list(target.parent.iterdir())), 1)

    def test_export_rejects_bad_source_and_boundaries_before_creating_folder(self):
        source = project_fixture()
        for key, value in (("url", "file:///etc/passwd"), ("source", "other")):
            project = deepcopy(source)
            project["videos"][0][key] = value
            with self.assertRaises(DownloadError):
                save_export(project, self.root)
        source["videos"][0]["clips"][0]["end_seconds"] = 20
        with self.assertRaises(DownloadError):
            save_export(source, self.root)
        self.assertFalse(self.root.exists())

    def test_export_refuses_symlink_outside_root_and_cleans_failed_temp(self):
        self.root.mkdir()
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (self.root / "annotations").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(DownloadError):
            save_export(project_fixture(), self.root)
        self.assertEqual(list(outside.iterdir()), [])
        (self.root / "annotations").unlink()
        with patch.object(Path, "replace", side_effect=OSError("disk error")), self.assertRaises(OSError):
            save_export(project_fixture(), self.root)
        self.assertEqual(list((self.root / "annotations").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
