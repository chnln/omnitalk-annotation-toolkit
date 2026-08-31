# OmniTalk Annotation Toolkit

A frontend toolkit for video clip annotation: load YouTube videos, mark time ranges, add notes and tags, and export portable JSON. Each participant can run it locally without renting a server or creating an account.

**[Try the browser demo](https://chnln.github.io/omnitalk-annotation-toolkit/)** · **[Source code](https://github.com/chnln/omnitalk-annotation-toolkit)**

The GitHub Pages demo supports annotation, browser storage, and JSON import/export. It has no Python backend: **video downloads and native folder selection require the local app**. Projects are not shared automatically between the demo and the local app; transfer them with JSON.

<a id="run-locally"></a>

## Install with a coding agent

Copy this prompt into your coding agent:

```text
Install and launch https://github.com/chnln/omnitalk-annotation-toolkit on my computer.

1. Clone the repository into a suitable local folder. If it already exists,
   inspect it without overwriting my changes.
2. Use uv for Python and project-local dependencies. Run uv sync from the
   repository root. Do not install packages into global or system Python.
3. For video downloads, ensure FFmpeg and ffprobe plus Node.js 22+ or Deno 2.3+
   are available on PATH. Reuse existing installations where possible.
   These external tools are not Python packages and are not installed by uv.
4. Launch uv run annotation-toolkit, verify the local server responds, and
   open http://127.0.0.1:8765. If the port is occupied, choose another with --port.
5. Tell me where the repository is and how to start and stop the app next time.
   Do not download media until I select a video and destination in the UI.
```

## Manual local installation

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) and Git, then run:

```bash
git clone https://github.com/chnln/omnitalk-annotation-toolkit.git
cd omnitalk-annotation-toolkit
uv sync
uv run annotation-toolkit
```

The app opens at **http://127.0.0.1:8765** and listens only on this computer. Keep the terminal running; press `Ctrl+C` to stop it. Python 3.11+ is supported; `.python-version` selects 3.12. `uv` manages the isolated environment and Python dependencies, including yt-dlp.

For video downloads, also install [FFmpeg](https://ffmpeg.org/download.html), including `ffprobe`, and either [Node.js 22+](https://nodejs.org/en/download) or [Deno 2.3+](https://docs.deno.com/runtime/getting_started/installation/). Restart the app after making these available on `PATH`. Annotation and JSON export work without these download tools.

```bash
uv run annotation-toolkit --no-browser
uv run annotation-toolkit --port 9000
uv run annotation-toolkit --download-dir "/absolute/path/to/output"
```

## Annotate

1. Set a project name. **Annotator ID** and **Display name** are optional; they identify the author in exported JSON, not a login. One annotator identity applies to the whole project.
2. Paste a YouTube link or video ID and click **Load video**. Switch between videos in **Video library**; each keeps its clips and unfinished draft.
3. Set **Start time** and **End time**, or click **Use current** while playing. Add **Note** and **Tags**, then click **Add clip**.
4. Preview, edit, or delete clips from the list. **Download all** applies to every saved clip of the selected video, including clips hidden by search, but excludes unfinished drafts and other videos.
5. Use **Export JSON** to keep a backup or share annotations. **Import JSON** validates the file and asks before replacing an existing workspace with videos or drafts.

| Shortcut | Action |
| --- | --- |
| `I` / `O` | Mark start / end |
| `Space` | Play / pause |
| `Ctrl+Enter` / `⌘+Enter` | Add clip or save changes |

Playback shortcuts do not activate while typing. The save shortcut works inside clip fields. If the YouTube player has keyboard focus, click outside it first.

Deleting a library video requires confirmation and removes its clips and draft from the workspace. Downloaded files, previous JSON exports, and running downloads are unaffected.

## Download videos locally

Use **Download video** for a full video or a selected range, a clip row’s download button for one saved clip, or **Download all** for a batch. Each request requires a destination: **Choose folder**, enter an existing absolute folder path, or explicitly select **Use default folder**. A batch chooses one folder and resolution, then queues all clips in time order.

- The default folder is `Downloads` inside the current computer account’s home directory, resolved separately on each participant’s computer. `--download-dir` overrides it.
- A full video or single clip is saved as an **MP4 file with source audio, directly in the selected folder**. **Download all** creates one new batch folder inside the selected folder and saves all clip MP4s directly inside it. Conversion and clip cutting can take extra time.
- **Resolution** defaults to a 1080p maximum. Choose **Best available**, 2160p, 1440p, 1080p, 720p, 480p, or 360p. Source availability limits actual quality; lower-resolution sources are never upscaled. Completed jobs show **Actual resolution** when valid file dimensions are available.
- Progress updates automatically every 1.5 seconds while jobs are active. **Refresh downloads** only checks progress; it does not restart or retry downloads. Keep the local server running until jobs finish. Restarting it clears task history, but completed files remain.

Download only content you have permission to use. The toolkit does not import login cookies or bypass access restrictions. YouTube or network restrictions can prevent playback or downloads.

## Annotation JSON schema

The current format is **schema `1.0`**, shared by the local app and browser edition. It describes one project containing videos, each with its saved clip annotations. The schema version is separate from the app's release version, such as `v0.1.0`. The English interface accepts Unicode text in names, notes, and tags.

### Project fields

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | string | Must be `"1.0"`. |
| `project_id` | UUID string | Identifies this project. |
| `project_name` | string | User-entered project name. |
| `annotator` | object | Contains `id` and `name`, both strings. Either may be empty (`""`); neither creates an account. |
| `created_at`, `updated_at` | timestamp strings | Project creation and last recorded modification. |
| `exported_at` | timestamp string | When this file was exported. Included in exports, optional on import, and regenerated on the next export. |
| `videos` | array | All video records in the project, including videos with no saved clips. |

### Video fields (`videos[]`)

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | UUID string | Internal video record ID, distinct from the YouTube ID. |
| `source` | string | Currently always `"youtube"`. |
| `video_id` | string | YouTube's 11-character video ID. |
| `url` | string | Exported as the canonical `https://www.youtube.com/watch?v=VIDEO_ID` URL, matching `video_id`. |
| `title` | string | Video title; it can be edited in the workspace. |
| `duration_seconds` | number or `null` | Original video duration in seconds, or `null` when unknown. |
| `created_at` | timestamp string | When the video record was added to the project, not its YouTube upload date. |
| `clips` | array | Saved clip annotations for this video. |

### Clip fields (`videos[].clips[]`)

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | UUID string | Annotation record ID, preserved when editing the clip. It is not a download job ID. |
| `start_seconds`, `end_seconds` | numbers | Boundaries measured from the beginning of the **original video**, not from a downloaded clip. |
| `note` | string | Free-text observation; may be empty (`""`). |
| `tags` | array of strings | Labels such as `"conversation"`; may be empty (`[]`). |
| `created_at`, `updated_at` | timestamp strings | Clip creation and last recorded modification. These are not an edit history. |

All fields above are required on import except `exported_at`; optional user input is represented by empty strings or arrays, rather than missing fields. Project, video record, and clip UUIDs must be unique across the file. Timestamps are ISO 8601 strings and are exported in UTC (`Z`). Clip boundaries are numeric seconds rounded to milliseconds: `0 <= start_seconds < end_seconds`, with the end no later than the video duration when known. Clip duration is calculated as `end_seconds - start_seconds`; it is not a separate field. Millisecond storage does not guarantee frame-accurate playback or cutting.

### Complete example

This example can be saved as a UTF-8 `.json` file and imported. It describes one saved clip from 10 to 14.25 seconds; the IDs and annotation text are illustrative.

```json
{
  "schema_version": "1.0",
  "project_id": "11111111-1111-4111-8111-111111111111",
  "project_name": "Conversation pilot",
  "annotator": {
    "id": "P001",
    "name": ""
  },
  "created_at": "2026-08-31T09:00:00.000Z",
  "updated_at": "2026-08-31T09:05:00.000Z",
  "exported_at": "2026-08-31T09:06:00.000Z",
  "videos": [
    {
      "id": "22222222-2222-4222-8222-222222222222",
      "source": "youtube",
      "video_id": "M7lc1UVf-VE",
      "url": "https://www.youtube.com/watch?v=M7lc1UVf-VE",
      "title": "Example video",
      "duration_seconds": null,
      "created_at": "2026-08-31T09:01:00.000Z",
      "clips": [
        {
          "id": "33333333-3333-4333-8333-333333333333",
          "start_seconds": 10,
          "end_seconds": 14.25,
          "note": "Review the opening exchange.",
          "tags": ["conversation", "pilot"],
          "created_at": "2026-08-31T09:05:00.000Z",
          "updated_at": "2026-08-31T09:05:00.000Z"
        }
      ]
    }
  ]
}
```

**What is not included:** unfinished clip drafts, the selected video, playback position, search/sidebar preferences, video/audio files, subtitles/transcripts, download status, resolution settings, or local file paths. Downloading a video does not itself create an annotation; use **Add clip** first to record a range.

`annotator` applies to the **whole project**. Changing it changes the label in subsequent exports, including for older clips; individual clips do not store separate authors. Downloaded MP4 filenames contain the YouTube ID and time range for clip downloads, but JSON does not yet provide a direct clip-ID-to-file mapping.

## Export and import annotations

### Export JSON

1. Click **Add clip** for new annotations, or save changes to an existing clip. Unfinished drafts are not exported; the app warns before continuing if any remain.
2. Click **Export JSON**. This exports **every video and every saved clip in the project**, regardless of the selected video or search filter. In contrast, **Download all** applies only to clips of the selected video.
3. Save or locate the file according to the edition:

| Edition | Where the JSON goes |
| --- | --- |
| Local app | The Python server writes a new file under `annotations/` in its configured output directory. By default this is your account's `Downloads/annotations/`; `--download-dir` changes the output root. The export dialog shows the actual saved path. The video download dialog's chosen folder does not change this export destination. |
| Browser edition (Pages) | The browser handles the file download and destination according to its settings. The app cannot confirm whether the browser saved it. |

The export dialog also offers **Download a copy** and **Copy JSON**. If the browser blocks downloads or local saving fails, copy the JSON into a plain-text file and save it with a `.json` extension in UTF-8. Confirm that you have a saved file before closing the workspace or clearing browser data.

### Import JSON

1. Export any existing annotations you need to keep, and save unfinished drafts as clips first if you want them included in that backup.
2. Click **Import JSON** and choose one project `.json` file, such as an export from another computer or edition. Files larger than 20 MB require confirmation before reading.
3. The app validates the file before replacing the workspace: supported schema version, required fields/types, unique record UUIDs, matching YouTube links/IDs, timestamps, and valid clip boundaries. Invalid files leave the current project intact.
4. If the current workspace has videos or drafts, confirm **Import and replace**. **Import replaces the project and clears its unfinished drafts; it does not merge projects or append clips.** Cancel leaves the workspace intact. Importing into an empty workspace needs no replacement confirmation.
5. The imported videos and saved clips become available in the library, with the first video selected. Existing media files and running download jobs are unaffected; importing does not download videos automatically.

Imports currently allow up to 1,000 videos, 10,000 clips per video, 50,000 clips per project, and 50 tags per clip. Unsupported extra fields are discarded rather than preserved, so keep a separate original if another tool adds metadata. Exact validation rules, including text-length limits, are implemented in [`core.js`](src/annotation_toolkit/static/core.js).

Both editions use the same format. A participant can annotate on Pages, export JSON, and send it to a project lead who imports it into the local app to download clips. Export each project before importing another; there is no automatic multi-file merge or shared project synchronization.

## Data and limitations

Projects and drafts autosave to browser `localStorage`, separately for each browser, host, and port. Clearing browser data removes them. Autosave is not a JSON file backup: export regularly, and avoid editing the same project in multiple tabs. Annotations are not uploaded to a project server.

YouTube playback still connects to YouTube/Google and requires internet access and an embeddable video. The [official embedded player](https://developers.google.com/youtube/iframe_api_reference) avoids the website’s comments and recommendation sidebar, but YouTube controls its branding, ads, and end recommendations. These cannot all be hidden through [player parameters](https://developers.google.com/youtube/player_parameters).

Audio-only extraction, subtitle import/alignment, local media playback, and collaborative synchronization are not implemented.

## Development

```bash
uv run python -m unittest discover -s tests
node --test tests/*.test.mjs
uv build
uv run python scripts/build_pages.py
```

Node.js is needed for the frontend tests, not for annotation itself. The frontend uses plain HTML, CSS, and JavaScript without a JavaScript bundler. `scripts/build_pages.py` prepares the static demo in `dist/pages`.

To publish the demo, run:

```bash
uv run python scripts/publish_pages.py
```

This rebuilds the static assets and pushes them to the repository’s `gh-pages` branch. It requires repository push rights and normal Git authentication. In GitHub **Settings → Pages**, choose **Deploy from a branch**, then **gh-pages** and **/ (root)**. Publishing is explicit; pushing changes to `main` does not automatically update the demo.
