"""Bounded local download jobs and atomic annotation exports."""

from __future__ import annotations

from collections import OrderedDict
from datetime import datetime, timezone
import errno
import importlib.util
import json
import math
import os
from pathlib import Path
from queue import Queue
import re
import shutil
import subprocess
import tempfile
from threading import Lock, Thread
from uuid import UUID, uuid4

VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}\Z")
MAX_TIME = 7 * 24 * 3600
MAX_HISTORY = 10000
MAX_PENDING = 10000
MEDIA_EXTENSIONS = {".mp4", ".mkv", ".webm", ".mov", ".m4v"}
QUALITIES = ("best", "2160", "1440", "1080", "720", "480", "360")
DEFAULT_QUALITY = "1080"


def default_download_directory():
    """Resolve this participant's home at runtime, independently of the repo."""
    return (Path.home() / "Downloads").resolve()


class DownloadError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _timestamp():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _seconds(value, label):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not 0 <= value <= MAX_TIME or not math.isfinite(value)):
        raise DownloadError(f"{label} must be a finite number between 0 and {MAX_TIME} seconds.")
    return round(float(value), 3)


def validate_request(data):
    if not isinstance(data, dict):
        raise DownloadError("Download request must be a JSON object.")
    if set(data) - {"video_id", "scope", "start_seconds", "end_seconds", "quality"}:
        raise DownloadError("Download request contains unsupported fields.")
    video_id = data.get("video_id")
    if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id):
        raise DownloadError("video_id must be an 11-character YouTube video ID.")
    scope = data.get("scope")
    if not isinstance(scope, str) or scope not in {"full", "clip"}:
        raise DownloadError("scope must be full or clip.")
    start = end = None
    if scope == "clip":
        start = _seconds(data.get("start_seconds"), "Clip start")
        end = _seconds(data.get("end_seconds"), "Clip end")
        if end <= start:
            raise DownloadError("Clip end must be after its start by at least 1 millisecond.")
    elif data.get("start_seconds") is not None or data.get("end_seconds") is not None:
        raise DownloadError("A full-video download must not specify clip times.")
    quality = data.get("quality", DEFAULT_QUALITY)
    if not isinstance(quality, str) or quality not in QUALITIES:
        raise DownloadError("quality must be best, 2160, 1440, 1080, 720, 480, or 360.")
    return {"video_id": video_id, "scope": scope, "start_seconds": start,
            "end_seconds": end, "quality": quality}


def format_selector(quality):
    limit = "" if quality == "best" else f"[height<={quality}]"
    return f"bv{limit}+ba/b{limit}"


def _runtime():
    for name, minimum in (("deno", (2, 3, 0)), ("node", (22, 0, 0))):
        executable = shutil.which(name)
        if not executable:
            continue
        try:
            result = subprocess.run([executable, "--version"], capture_output=True,
                                    text=True, timeout=3, check=True)
            match = re.search(r"(\d+)\.(\d+)\.(\d+)", result.stdout)
            if match and tuple(map(int, match.groups())) >= minimum:
                return name, executable
        except (OSError, subprocess.SubprocessError):
            continue
    return None, None


def detect_capabilities(download_dir: Path):
    runtime, _ = _runtime()
    installed = (importlib.util.find_spec("yt_dlp") is not None
                 and importlib.util.find_spec("yt_dlp_ejs") is not None)
    ffmpeg = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
    return {"ready": bool(installed and ffmpeg and runtime), "yt_dlp": installed,
            "ffmpeg": ffmpeg, "js_runtime": runtime, "download_dir": str(download_dir),
            "qualities": list(QUALITIES), "default_quality": DEFAULT_QUALITY}


def _check_metadata(info, job):
    if (not isinstance(info, dict) or info.get("_type", "video") != "video"
            or info.get("id") != job["video_id"] or "entries" in info):
        raise DownloadError("Only a single matching YouTube video can be downloaded.")
    if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming", "post_live"}:
        raise DownloadError("Live or upcoming streams are not supported. Choose a finished video.")
    duration = info.get("duration")
    known_duration = (isinstance(duration, (int, float)) and not isinstance(duration, bool)
                      and math.isfinite(duration) and duration > 0)
    if job["scope"] == "full" and not known_duration:
        raise DownloadError("The video has no known finite duration; a full download cannot start.")
    if job["scope"] == "clip" and known_duration and job["end_seconds"] > duration + 0.001:
        raise DownloadError(f"Clip end exceeds the video duration ({duration:g} seconds).")


class _QuietLogger:
    def debug(self, message):
        pass

    def warning(self, message):
        pass

    def error(self, message):
        pass


def _probe_media(path, ffprobe):
    try:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "stream=codec_type,codec_name,height,width:format=format_name",
             "-of", "json", str(path)], capture_output=True, text=True, check=True, timeout=30,
        )
        info = json.loads(result.stdout)
        video = next(stream for stream in info["streams"] if stream.get("codec_type") == "video")
        audio = next(stream for stream in info["streams"] if stream.get("codec_type") == "audio")
        return {"video": video, "audio": audio, "format": info.get("format", {}).get("format_name", "")}
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError, StopIteration) as error:
        raise DownloadError("The downloaded media could not be verified as video with source audio.") from error


def _prepare_mp4(source, folder, ffmpeg, ffprobe, quality, update):
    def dimensions(info):
        result = {key: info["video"].get(key) for key in ("width", "height")}
        if any(type(value) is not int or value <= 0 for value in result.values()):
            raise DownloadError("The video does not report valid positive pixel dimensions.")
        if quality != "best" and result["height"] > int(quality):
            raise DownloadError("The downloaded video exceeds the selected maximum resolution.")
        return result

    info = _probe_media(source, ffprobe)
    source_dimensions = dimensions(info)
    video_compatible = info["video"].get("codec_name") == "h264"
    audio_compatible = info["audio"].get("codec_name") == "aac"
    if source.suffix == ".mp4" and "mp4" in info["format"].split(",") and video_compatible and audio_compatible:
        update(**source_dimensions)
        return source
    target = folder / "final.mp4"
    update(status="processing", progress=None,
           message="Preparing MP4 with source audio; conversion may take some time…")
    command = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-i", str(source),
               "-map", "0:v:0", "-map", "0:a:0"]
    if video_compatible:
        command.extend(["-c:v", "copy"])
    else:
        command.extend(["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"])
    if audio_compatible:
        command.extend(["-c:a", "copy"])
    else:
        command.extend(["-c:a", "aac", "-b:a", "192k"])
    command.extend(["-movflags", "+faststart", str(target)])
    try:
        subprocess.run(command, capture_output=True, text=True, check=True, timeout=12 * 3600)
    except (OSError, subprocess.SubprocessError) as error:
        raise DownloadError("FFmpeg could not prepare the MP4 file. Check that FFmpeg supports H.264/libx264 and AAC.") from error
    finished = _probe_media(target, ffprobe)
    if (finished["video"].get("codec_name") != "h264" or finished["audio"].get("codec_name") != "aac"
            or "mp4" not in finished["format"].split(",") or not target.is_file() or target.stat().st_size == 0):
        raise DownloadError("MP4 conversion did not produce a complete H.264 video with AAC audio.")
    update(**dimensions(finished))
    return target


def _publish_mp4(source, root, stem):
    """Publish one flat filename without replacing any existing destination."""
    if source.is_symlink() or source.suffix != ".mp4" or not source.resolve().is_relative_to(root):
        raise DownloadError("The prepared MP4 must stay inside the selected download folder.")
    for attempt in range(10):
        if root.resolve() != root:
            raise DownloadError("The selected destination changed. Select the folder again.")
        suffix = "" if attempt == 0 else f"_{uuid4().hex[:8]}"
        target = root / f"{stem}{suffix}.mp4"
        try:
            try:
                os.link(source, target, follow_symlinks=False)
            except OSError as error:
                if error.errno not in {errno.EPERM, errno.ENOTSUP, errno.EOPNOTSUPP, errno.ENOSYS, errno.EXDEV}:
                    raise
                # FAT/network volumes may not support hard links. Exclusive
                # creation still prevents replacement; failed copies are removed.
                with target.open("xb") as output:
                    try:
                        with source.open("rb") as input_file:
                            shutil.copyfileobj(input_file, output)
                        output.flush()
                        os.fsync(output.fileno())
                    except BaseException:
                        output.close()
                        target.unlink(missing_ok=True)
                        raise
            return target
        except FileExistsError:
            continue
    raise DownloadError("Could not choose an unused output filename. Try the download again.")


def download_video(job, download_dir, update):
    # API use does not load CLI/user configuration. Disable plugin discovery
    # explicitly before constructing YoutubeDL, which otherwise auto-loads it.
    from yt_dlp import YoutubeDL
    from yt_dlp.globals import plugin_dirs
    from yt_dlp.utils import download_range_func

    plugin_dirs.value = []
    runtime, runtime_path = _runtime()
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise DownloadError("FFmpeg and ffprobe are required. Install them and restart the toolkit.", 503)
    if runtime is None:
        raise DownloadError("Node.js 22+ or Deno 2.3+ is required. Install one and restart the toolkit.", 503)

    root = download_dir.resolve()
    if root != download_dir:
        raise DownloadError("The selected destination changed after this job was queued. Select the folder again.")
    root.mkdir(parents=True, exist_ok=True)
    suffix = "full" if job["scope"] == "full" else f"{job['start_seconds']:.3f}-{job['end_seconds']:.3f}s"
    quality = job.get("quality", DEFAULT_QUALITY)
    quality_label = "best" if quality == "best" else f"{quality}p"
    name = f"{job['video_id']}_{suffix}_{quality_label}_{job['id']}"

    def progress(event):
        if event.get("status") == "finished":
            update(status="processing", progress=None, message="Processing video and original audio…")
        elif event.get("status") == "downloading":
            total = event.get("total_bytes") or event.get("total_bytes_estimate")
            percent = min(100.0, max(0.0, 100 * event.get("downloaded_bytes", 0) / total)) if total else None
            update(status="downloading", progress=percent, message="Downloading video and original audio…")

    with tempfile.TemporaryDirectory(dir=root, prefix=".omnitalk-") as temporary:
        folder = Path(temporary).resolve()
        options = {
            "format": format_selector(quality),
            "format_sort": ["lang", "res", "vcodec:h264", "acodec:aac", "vext:mp4", "aext:m4a"],
            "merge_output_format": "mp4/mkv",  # Staging only; publication is always verified MP4.
            "paths": {"home": str(folder), "temp": str(folder)},
            "outtmpl": "source.%(ext)s",
            "noplaylist": True, "allowed_extractors": ["youtube"],
            "cachedir": False, "cookiefile": None, "cookiesfrombrowser": None,
            "usenetrc": False, "enable_file_urls": False,
            "remote_components": [], "js_runtimes": {runtime: {"path": runtime_path}},
            "ffmpeg_location": str(Path(ffmpeg).parent),
            "quiet": True, "no_warnings": True, "noprogress": True,
            "logger": _QuietLogger(), "progress_hooks": [progress],
            "postprocessor_hooks": [lambda event: update(status="processing", progress=None,
                                                           message="Processing video and original audio…")],
            "socket_timeout": 30, "retries": 3, "fragment_retries": 3,
            "overwrites": False, "restrictfilenames": True,
            "writesubtitles": False, "writeautomaticsub": False,
            "writethumbnail": False, "writeinfojson": False,
        }
        if job["scope"] == "clip":
            options["download_ranges"] = download_range_func(None, [(job["start_seconds"], job["end_seconds"])])
            options["force_keyframes_at_cuts"] = True
        url = f"https://www.youtube.com/watch?v={job['video_id']}"
        with YoutubeDL(options) as downloader:
            info = downloader.extract_info(url, download=False)
            _check_metadata(info, job)
            downloader.process_ie_result(info, download=True)
        files = [path for path in folder.iterdir() if not path.is_symlink() and path.is_file()
                 and path.suffix in MEDIA_EXTENSIONS and path.resolve().parent == folder and path.stat().st_size > 0]
        if len(files) != 1:
            raise DownloadError("The download did not produce one complete media file. Temporary files were removed.")
        ready = _prepare_mp4(files[0], folder, ffmpeg, ffprobe, quality, update)
        return _publish_mp4(ready, root, name)


class DownloadManager:
    """One active download, 10,000 pending jobs, and 10,000 finished records."""

    def __init__(self, download_dir: Path | None = None, *, runner=download_video):
        self.download_dir = (download_dir or default_download_directory()).expanduser().resolve()
        self.capabilities = detect_capabilities(self.download_dir)
        self._runner = runner
        self._jobs = OrderedDict()
        self._lock = Lock()
        self._queue = Queue(maxsize=MAX_PENDING)
        self._worker = None
        self._finished = OrderedDict()

    def snapshot(self):
        with self._lock:
            return {"jobs": [dict(job) for job in reversed(self._jobs.values())],
                    "capabilities": dict(self.capabilities)}

    def submit(self, data):
        from .folders import validate_destination

        if not isinstance(data, dict):
            raise DownloadError("Download request must be a JSON object.")
        fields = validate_request({key: value for key, value in data.items() if key != "destination"})
        destination = validate_destination(data.get("destination", str(self.download_dir)), default=self.download_dir)
        return self._enqueue([fields], destination)[0]

    def submit_batch(self, data):
        from .folders import validate_destination

        if not isinstance(data, dict) or set(data) != {"downloads", "destination"}:
            raise DownloadError("A batch must contain downloads and one destination folder.")
        requests = data["downloads"]
        if not isinstance(requests, list) or not 1 <= len(requests) <= MAX_PENDING:
            raise DownloadError(f"A batch must contain between 1 and {MAX_PENDING} downloads.")
        # Validate the entire request before adding any jobs or writing files.
        fields = [validate_request(request) for request in requests]
        destination = validate_destination(data["destination"], default=self.download_dir)
        return self._enqueue(fields, destination, batch=True)

    def _enqueue(self, requests, destination, *, batch=False):
        if not self.capabilities["ready"]:
            raise DownloadError("Downloads require yt-dlp, FFmpeg/ffprobe, and Node.js 22+ or Deno 2.3+. Install missing components and restart.", 503)
        jobs = [{"id": str(uuid4()), **fields, "destination": str(destination),
                 "status": "queued", "progress": None, "message": "Waiting to download…",
                 "filename": None, "path": None, "width": None, "height": None,
                 "created_at": _timestamp()} for fields in requests]
        with self._lock:
            if self._queue.qsize() + len(jobs) > self._queue.maxsize:
                raise DownloadError(f"The download queue cannot fit this request. At most {MAX_PENDING} downloads may wait at once; wait for current jobs to finish.", 409)
            if batch:
                # Only create the shared folder after all input, capability,
                # and queue-capacity checks have succeeded under this lock.
                destination = self._batch_directory(requests, destination)
                for job in jobs:
                    job["destination"] = str(destination)
            # Every producer holds this lock, so capacity cannot be consumed
            # between this check and the complete batch insertion.
            for job in jobs:
                self._jobs[job["id"]] = job
                self._queue.put_nowait(job["id"])
            if self._worker is None:
                self._worker = Thread(target=self._work, name="annotation-download", daemon=True)
                self._worker.start()
            return [dict(job) for job in jobs]

    def _batch_directory(self, requests, destination):
        from .folders import validate_destination

        if validate_destination(str(destination), default=self.download_dir) != destination:
            raise DownloadError("The selected destination changed. Select the folder again.")
        destination.mkdir(parents=True, exist_ok=True)
        video_ids = {request["video_id"] for request in requests}
        source = next(iter(video_ids)) if len(video_ids) == 1 else "mixed"
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        # mkdtemp creates a fresh directory exclusively, so an existing folder
        # or symlink cannot be reused or overwritten by another batch.
        folder = Path(tempfile.mkdtemp(dir=destination, prefix=f"omnitalk_{source}_clips_{stamp}_"))
        if folder.resolve().parent != destination:
            folder.rmdir()
            raise DownloadError("The batch folder must stay inside the selected download folder.")
        return folder.resolve()

    def _update(self, job_id, **fields):
        with self._lock:
            self._jobs[job_id].update(fields)
            if fields.get("status") in {"completed", "failed"}:
                self._finished[job_id] = None
                while len(self._finished) > MAX_HISTORY:
                    finished, _ = self._finished.popitem(last=False)
                    del self._jobs[finished]

    def _work(self):
        from .folders import validate_destination

        while True:
            job_id = self._queue.get()
            try:
                with self._lock:
                    job = dict(self._jobs[job_id])
                self._update(job_id, status="downloading", message="Reading YouTube video information…")
                destination = Path(job["destination"])
                if validate_destination(str(destination), default=self.download_dir) != destination:
                    raise DownloadError("The selected destination changed after this job was queued. Select the folder again.")
                path = self._runner(job, destination, lambda **fields: self._update(job_id, **fields))
                path = Path(path).resolve()
                if path.parent != destination or path.suffix != ".mp4" or not path.is_file():
                    raise DownloadError("The completed MP4 is missing or outside the selected download folder.")
                self._update(job_id, status="completed", progress=100, message="Saved locally.",
                             filename=path.name, path=str(path))
            except Exception as error:
                message = re.sub(r"\x1b\[[0-9;]*m", "", str(error))
                message = " ".join(message.split())[:800] or "An unexpected download error occurred."
                self._update(job_id, status="failed", progress=None, message=f"Download failed: {message}")
            finally:
                self._queue.task_done()


def validate_export(data):
    """Check core project/source/clip shape; no client-supplied paths are used."""
    def obj(value, label):
        if not isinstance(value, dict):
            raise DownloadError(f"{label} must be an object.")

    def text(value, label, limit):
        if not isinstance(value, str) or len(value) > limit:
            raise DownloadError(f"{label} must be text with at most {limit} characters.")

    ids = set()

    def identifier(value):
        try:
            normalized = str(UUID(value))
        except (ValueError, TypeError, AttributeError) as error:
            raise DownloadError("Record IDs must be valid UUIDs.") from error
        if normalized in ids:
            raise DownloadError("Duplicate record IDs.")
        ids.add(normalized)

    def annotator(value, label):
        obj(value, label)
        text(value.get("id"), f"{label} ID", 200)
        text(value.get("name"), f"{label} name", 200)

    obj(data, "Project")
    version = data.get("schema_version")
    if version not in ("1.0", "1.1", "1.2"):
        raise DownloadError("Unsupported annotation schema; expected version 1.0, 1.1 or 1.2.")
    identifier(data.get("project_id"))
    text(data.get("project_name"), "Project name", 200)
    annotator(data.get("annotator"), "Annotator")
    videos = data.get("videos")
    if not isinstance(videos, list) or len(videos) > 1000:
        raise DownloadError("Project videos must be a list of at most 1000 entries.")
    total = 0
    for video in videos:
        obj(video, "Video")
        identifier(video.get("id"))
        video_id = video.get("video_id")
        if (video.get("source") != "youtube" or not isinstance(video_id, str)
                or not VIDEO_ID.fullmatch(video_id)
                or video.get("url") != f"https://www.youtube.com/watch?v={video_id}"):
            raise DownloadError("Each source must be a canonical YouTube video matching its video ID.")
        clips = video.get("clips")
        if not isinstance(clips, list) or len(clips) > 10000:
            raise DownloadError("Video clips must be a list of at most 10000 entries.")
        total += len(clips)
        if total > 50000:
            raise DownloadError("A project can contain at most 50000 clips.")
        duration = video.get("duration_seconds")
        if duration is not None and (isinstance(duration, bool) or not isinstance(duration, (int, float))
                                     or not 0 < duration <= 9007199254740.99 or not math.isfinite(duration)):
            raise DownloadError("Video duration must be positive or null.")
        for clip in clips:
            obj(clip, "Clip")
            identifier(clip.get("id"))
            # Exports preserve the frontend's wider timestamp range.
            start, end = clip.get("start_seconds"), clip.get("end_seconds")
            if any(isinstance(value, bool) or not isinstance(value, (int, float))
                   or not 0 <= value <= 9007199254740.99 or not math.isfinite(value) for value in (start, end)):
                raise DownloadError("Clip times must be finite nonnegative numbers.")
            if end <= start or (duration is not None and end > duration):
                raise DownloadError("Clip boundaries are outside the video duration or out of order.")
            text(clip.get("note"), "Clip note", 20000)
            tags = clip.get("tags")
            if not isinstance(tags, list) or len(tags) > 50:
                raise DownloadError("Clip tags must be a list with at most 50 entries.")
            for tag in tags:
                text(tag, "Tag", 100)
            if version == "1.2":
                annotator(clip.get("annotator"), "Clip annotator")
            if version in ("1.1", "1.2"):
                if clip.get("subtitle_status") not in ("unknown", "none", "present", "masked"):
                    raise DownloadError("Invalid subtitle status.")
                questions = clip.get("questions")
                if not isinstance(questions, list) or len(questions) > 100:
                    raise DownloadError("A clip supports up to 100 questions.")
                for question in questions:
                    obj(question, "Question")
                    identifier(question.get("id"))
                    if version == "1.2":
                        annotator(question.get("annotator"), "Question annotator")
                    text(question.get("prompt"), "Question", 10000)
                    text(question.get("rationale"), "Rationale", 20000)
                    if question.get("status") not in ("draft", "ready"):
                        raise DownloadError("Invalid question status.")
                    for key in ("created_at", "updated_at"):
                        value = question.get(key)
                        text(value, key, 40)
                        try:
                            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                            if parsed.tzinfo is None:
                                raise ValueError("Timezone required")
                        except ValueError as error:
                            raise DownloadError("Invalid question timestamp.") from error
                    options = question.get("options")
                    if not isinstance(options, list) or len(options) > 26:
                        raise DownloadError("A question supports up to 26 options.")
                    option_ids = []
                    for option in options:
                        obj(option, "Option")
                        identifier(option.get("id"))
                        option_ids.append(option["id"])
                        text(option.get("text"), "Option", 5000)
                    if "correct_option_id" not in question or (question["correct_option_id"] is not None and question["correct_option_id"] not in option_ids):
                        raise DownloadError("Correct answer must reference an existing option.")
                    taxonomy = {
                        "audio": ("speech_content", "prosody", "environmental_sounds"),
                        "visual": ("action_event", "gesture", "facial_expression", "gaze", "person_appearance", "object_scene"),
                        "text": ("subtitles", "scene_text"),
                    }
                    def selection(value, allowed):
                        if (not isinstance(value, list) or len(value) > len(allowed)
                                or any(not isinstance(item, str) or item not in allowed for item in value)
                                or len(set(value)) != len(value)):
                            raise DownloadError("Invalid modality or evidence selection.")
                    modalities = question.get("required_modalities")
                    selection(modalities, taxonomy)
                    selection(question.get("evidence_cues"), [cue for m in modalities for cue in taxonomy[m]])
                    if question["status"] == "ready" and (not question["prompt"].strip() or len(options) < 2
                            or any(not option["text"].strip() for option in options)
                            or question["correct_option_id"] is None or not modalities):
                        raise DownloadError("Ready questions need a prompt, two nonempty options, a correct answer and a modality.")
    return data


def save_export(data, download_dir: Path):
    data = validate_export(data)
    try:
        contents = json.dumps(data, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    except (ValueError, TypeError, RecursionError) as error:
        raise DownloadError("The export must contain valid finite JSON values.") from error
    root = download_dir.expanduser().resolve()
    folder = root / "annotations"
    if not folder.resolve().is_relative_to(root):
        raise DownloadError("The annotation folder must remain inside the configured download folder.")
    filename = f"omnitalk_{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}_{uuid4().hex}.json"
    folder.mkdir(parents=True, exist_ok=True)
    destination = folder / filename
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=folder, prefix=".export-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(contents)
        temporary.replace(destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return {"filename": filename, "path": str(destination)}
