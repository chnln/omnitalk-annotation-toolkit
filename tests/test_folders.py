from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from annotation_toolkit.downloads import DownloadError
from annotation_toolkit.folders import (
    _PICKER_LOCK, choose_download_folder, validate_destination,
)


class FolderTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name).resolve() / "chosen folder 中文 "
        self.folder.mkdir()

    def test_manual_folder_validation_and_lazy_default(self):
        self.assertEqual(validate_destination(str(self.folder)), self.folder)
        missing = self.folder / "not-created"
        self.assertEqual(validate_destination(str(missing), default=missing), missing)
        self.assertFalse(missing.exists())
        regular = self.folder / "file.txt"
        regular.write_text("keep")
        for value in (None, 5, [], "", "relative", "~", "file:///tmp", "/tmp\x00bad", str(missing), str(regular)):
            with self.subTest(value=value), self.assertRaises(DownloadError):
                validate_destination(value)
        with patch("annotation_toolkit.folders.os.access", return_value=False), self.assertRaises(DownloadError):
            validate_destination(str(self.folder))

    def test_mac_picker_uses_only_fixed_script_and_preserves_unicode_spaces(self):
        result = subprocess.CompletedProcess([], 0, str(self.folder) + "\n", "")
        with patch("annotation_toolkit.folders.sys.platform", "darwin"), patch("annotation_toolkit.folders.shutil.which", return_value="/usr/bin/osascript"), patch("annotation_toolkit.folders.subprocess.run", return_value=result) as run:
            self.assertEqual(choose_download_folder(), str(self.folder))
        command = run.call_args.args[0]
        self.assertEqual(command[:2], ["/usr/bin/osascript", "-e"])
        self.assertIn("choose folder", command[2])
        self.assertNotIn(str(self.folder), command[2])
        self.assertFalse(run.call_args.kwargs.get("shell", False))
        self.assertEqual(run.call_args.kwargs["timeout"], 120)

    def test_picker_cancel_failure_and_timeout_release_dialog_lock(self):
        results = [subprocess.CompletedProcess([], 0, "", ""),
                   subprocess.CompletedProcess([], 1, "", ""),
                   subprocess.CompletedProcess([], 1, "", "Cannot open display")]
        with patch("annotation_toolkit.folders.sys.platform", "darwin"), patch("annotation_toolkit.folders.shutil.which", return_value="/usr/bin/osascript"), patch("annotation_toolkit.folders.subprocess.run", side_effect=results):
            self.assertIsNone(choose_download_folder())
            self.assertIsNone(choose_download_folder())
            with self.assertRaises(DownloadError) as error:
                choose_download_folder()
            self.assertEqual(error.exception.status, 503)
            self.assertIn("manually", str(error.exception))
        with patch("annotation_toolkit.folders.sys.platform", "darwin"), patch("annotation_toolkit.folders.shutil.which", return_value="/usr/bin/osascript"), patch("annotation_toolkit.folders.subprocess.run", side_effect=subprocess.TimeoutExpired("osascript", 120)):
            with self.assertRaises(DownloadError) as error:
                choose_download_folder()
            self.assertIn("timed out", str(error.exception))
        self.assertFalse(_PICKER_LOCK.locked())

    def test_only_one_native_picker_can_open(self):
        _PICKER_LOCK.acquire()
        try:
            with self.assertRaises(DownloadError) as error:
                choose_download_folder()
            self.assertEqual(error.exception.status, 409)
        finally:
            _PICKER_LOCK.release()

    def test_windows_and_linux_helpers_are_fixed_subprocess_arguments(self):
        result = subprocess.CompletedProcess([], 0, str(self.folder) + "\n", "")
        for platform, executable, expected in (("win32", "powershell.exe", "-NoProfile"),
                                                ("linux", "zenity", "--directory"),
                                                ("linux", None, "-c")):
            with self.subTest(platform=platform, executable=executable), patch("annotation_toolkit.folders.sys.platform", platform), patch("annotation_toolkit.folders.shutil.which", return_value=executable), patch("annotation_toolkit.folders.subprocess.run", return_value=result) as run:
                self.assertEqual(choose_download_folder(), str(self.folder))
                self.assertIn(expected, run.call_args.args[0])
                self.assertFalse(run.call_args.kwargs.get("shell", False))


if __name__ == "__main__":
    unittest.main()
