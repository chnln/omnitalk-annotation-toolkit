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

## Data and limitations

Annotations are the saved clip times, notes, and tags. The English interface accepts Unicode text in user-entered fields. JSON schema `1.0` records the project, participant, video sources, clips, and UTC timestamps; clip times are seconds from the original video, stored to milliseconds without a guarantee of frame accuracy. Unfinished drafts and downloaded media are not embedded in JSON.

Projects and drafts autosave to browser `localStorage`, separately for each browser, host, and port. Clearing browser data removes them. Export regularly. In the **local app**, JSON exports are written to `annotations/` inside the configured output directory, with the saved path shown in the dialog. The **Pages demo** exports through the browser; **Copy JSON** is available if the browser blocks file downloads. Annotations are not uploaded to a project server.

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
