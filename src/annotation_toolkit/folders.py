"""Native folder selection with a manual absolute-path fallback."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
from threading import Lock

from .downloads import DownloadError

_PICKER_LOCK = Lock()
_PICKER_ERROR = "The native folder picker is unavailable. Enter an absolute folder path manually."

_MAC_SCRIPT = '''try
    set selectedFolder to choose folder with prompt "Choose a folder for downloaded videos"
    return POSIX path of selectedFolder
on error number -128
    return ""
end try'''

_WINDOWS_SCRIPT = '''[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a folder for downloaded videos'
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::WriteLine($dialog.SelectedPath)
}
$dialog.Dispose()'''

_TK_SCRIPT = '''import tkinter as tk
from tkinter import filedialog
root = tk.Tk()
root.withdraw()
try:
    selected = filedialog.askdirectory(title="Choose a folder for downloaded videos", mustexist=True)
    print(selected or "")
finally:
    root.destroy()
'''


def validate_destination(value, *, default: Path | None = None):
    if not isinstance(value, str) or not value or len(value) > 32768 or "\x00" in value:
        raise DownloadError("Download destination must be an absolute folder path.")
    selected = Path(value)
    if not selected.is_absolute():
        raise DownloadError("Use an absolute folder path, not a relative path or a URL.")
    try:
        resolved = selected.resolve()
        if default is not None and resolved == default and not resolved.exists():
            return resolved  # The configured default is created only when writing.
        resolved = selected.resolve(strict=True)
        if not resolved.is_dir():
            raise DownloadError("The selected destination is not a folder.")
    except (OSError, RuntimeError, ValueError) as error:
        if isinstance(error, DownloadError):
            raise
        raise DownloadError("The selected folder does not exist or cannot be accessed. Choose an existing folder.") from error
    if not os.access(resolved, os.W_OK | os.X_OK):
        raise DownloadError("The selected folder is not writable. Choose a folder you can write to.")
    return resolved


def choose_download_folder():
    """The fixed commands accept no request text and never invoke a shell."""
    if not _PICKER_LOCK.acquire(blocking=False):
        raise DownloadError("A folder picker is already open. Complete or cancel it first.", 409)
    try:
        if sys.platform == "darwin":
            executable = shutil.which("osascript")
            if not executable:
                raise DownloadError(_PICKER_ERROR, 503)
            command = [executable, "-e", _MAC_SCRIPT]
        elif sys.platform == "win32":
            executable = shutil.which("powershell.exe") or shutil.which("powershell")
            if not executable:
                raise DownloadError(_PICKER_ERROR, 503)
            command = [executable, "-NoProfile", "-NonInteractive", "-STA", "-Command", _WINDOWS_SCRIPT]
        elif shutil.which("zenity"):
            command = [shutil.which("zenity"), "--file-selection", "--directory",
                       "--title=Choose a folder for downloaded videos"]
        elif shutil.which("kdialog"):
            command = [shutil.which("kdialog"), "--getexistingdirectory", str(Path.cwd()),
                       "--title", "Choose a folder for downloaded videos"]
        else:
            command = [sys.executable, "-c", _TK_SCRIPT]
        try:
            result = subprocess.run(command, capture_output=True, encoding="utf-8",
                                    errors="replace", timeout=120, check=False)
        except subprocess.TimeoutExpired as error:
            raise DownloadError("The folder picker timed out. Try again or enter an absolute folder path manually.", 503) from error
        except OSError as error:
            raise DownloadError(_PICKER_ERROR, 503) from error
        if result.returncode == 1 and not result.stdout and not result.stderr.strip():
            return None  # Zenity and KDialog use exit status 1 for Cancel.
        if result.returncode != 0:
            raise DownloadError(_PICKER_ERROR, 503)
        value = result.stdout.rstrip("\r\n")
        return str(validate_destination(value)) if value else None
    finally:
        _PICKER_LOCK.release()
