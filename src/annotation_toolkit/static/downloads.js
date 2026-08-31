import { parseTime, formatTime } from "./core.js";

const activeStatuses = new Set(["queued", "downloading", "processing"]);
const labels = { queued: "Queued", downloading: "Downloading", processing: "Processing", completed: "Completed", failed: "Failed" };
const qualities = new Set(["best", "2160", "1440", "1080", "720", "480", "360"]);
const qualityLabel = (quality) => quality === "best" ? "Best available" : `Up to ${quality || "1080"}p`;
const clock = (value) => formatTime(value, { milliseconds: true });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Download controls are independent of annotation storage and the player. */
export function initDownloads({ getVideo, getRange, getClips }) {
  if (document.body.dataset.mode === "static") return initBrowserDownloads(getVideo, getClips);
  if (!document.getElementById("downloads-styles")) {
    const stylesheet = element("link");
    stylesheet.id = "downloads-styles";
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("./downloads.css", import.meta.url).href;
    document.head.append(stylesheet);
  }

  let jobs = [];
  let capabilities = null;
  let sourceVideo = null;
  let batchClips = null;
  let busy = false;
  let choosingFolder = false;
  let dialogSession = 0;
  let visibleJobCount = 50;
  let serverError = "";
  let pollTimer;
  let pendingRefresh = null;
  let lastCheckedAt = null;
  const trigger = element("button", "button secondary download-video-button", "Download video");
  trigger.id = "download-video-button";
  trigger.type = "button";
  trigger.disabled = true;
  document.querySelector(".video-card-heading").append(trigger);

  const dialog = element("dialog", "download-dialog");
  dialog.id = "download-dialog";
  dialog.setAttribute("aria-labelledby", "download-heading");
  dialog.setAttribute("aria-describedby", "download-permission-note");
  // Only this fixed template uses HTML; all source metadata and server messages use textContent.
  dialog.innerHTML = `
    <div class="download-dialog-heading">
      <div><div class="eyebrow">SAVE TO YOUR COMPUTER</div><h2 id="download-heading">Download video</h2></div>
      <button type="button" class="icon-button" id="download-close" aria-label="Close download dialog">×</button>
    </div>
    <p class="download-source-title" id="download-source-title"></p>
    <form id="download-form" novalidate>
      <p class="download-batch-summary" id="download-batch-summary" hidden></p>
      <fieldset class="download-scope" id="download-options">
        <legend>Download range</legend>
        <label><input type="radio" name="download-scope" value="full" checked><span><strong>Full video</strong><small>Save the complete video with audio</small></span></label>
        <label><input type="radio" name="download-scope" value="clip"><span><strong>Clip</strong><small>Save a selected time range with audio</small></span></label>
      </fieldset>
      <fieldset class="download-range" id="download-range" hidden disabled>
        <div><label for="download-start">Start time</label><input id="download-start" placeholder="00:00.000" autocomplete="off" spellcheck="false" required></div>
        <div><label for="download-end">End time</label><input id="download-end" placeholder="00:00.000" autocomplete="off" spellcheck="false" required></div>
        <p>Enter seconds or mm:ss.sss. Clip cutting may take longer than a full download.</p>
      </fieldset>
      <div class="download-quality">
        <label for="download-quality">Resolution</label>
        <select id="download-quality" aria-describedby="download-quality-help">
          <option value="best">Best available</option>
          <option value="2160">Up to 2160p (4K)</option>
          <option value="1440">Up to 1440p</option>
          <option value="1080" selected>Up to 1080p</option>
          <option value="720">Up to 720p</option>
          <option value="480">Up to 480p</option>
          <option value="360">Up to 360p</option>
        </select>
        <p id="download-quality-help">Uses a lower resolution if the selected one is unavailable. No upscaling.</p>
      </div>
      <p class="download-format-note" id="download-format-note"></p>
      <div class="download-setup" id="download-setup">
        <div class="download-setup-heading"><strong>Local download setup</strong><button type="button" class="text-button" id="download-check">Check again</button></div>
        <p id="download-capabilities" role="status">Checking download tools…</p>
        <div id="download-setup-help" hidden>
          <p>Run <code>uv sync</code> in annotation-toolkit to install yt-dlp in the project environment.</p>
          <p>Install <a href="https://ffmpeg.org/download.html" target="_blank" rel="noopener noreferrer">FFmpeg</a> (including ffprobe), plus <a href="https://nodejs.org/en/download" target="_blank" rel="noopener noreferrer">Node.js 22+</a> or <a href="https://docs.deno.com/runtime/getting_started/installation/" target="_blank" rel="noopener noreferrer">Deno 2.3+</a>. Make them available on PATH, then restart the local server.</p>
        </div>
        <label for="download-folder">Save folder <span class="download-required">Required</span></label>
        <input id="download-folder" aria-label="Save folder" placeholder="Absolute path to an existing folder" autocomplete="off" spellcheck="false" required>
        <div class="download-folder-actions"><button type="button" class="button secondary" id="download-choose-folder">Choose folder</button><button type="button" class="text-button" id="download-use-default">Use default folder</button></div>
        <p>Choose a folder in the system dialog or enter its full path. Confirm this destination before starting.</p>
        <p class="download-default-explanation">The default is Downloads in this computer account’s home folder, unless changed when starting the server. Use default folder fills in the path for you to review.</p>
        <p id="download-folder-status" role="status" hidden></p>
      </div>
      <p class="download-permission-note" id="download-permission-note">Download only content you have permission to use.</p>
      <p class="field-error" id="download-error" role="alert" hidden></p>
      <div class="download-dialog-actions"><button class="button secondary" type="button" id="download-cancel">Cancel</button><button class="button primary" type="submit" id="download-submit" disabled>Download full video</button></div>
    </form>`;
  document.body.append(dialog);
  const find = (id) => dialog.querySelector(`#${id}`);
  const form = find("download-form");
  const submit = find("download-submit");
  const rangeFields = find("download-range");
  const options = find("download-options");
  const fullOption = dialog.querySelector('input[value="full"]');
  const clipOption = dialog.querySelector('input[value="clip"]');

  const panel = element("section", "downloads-card");
  panel.id = "downloads-panel";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", "downloads-heading");
  const panelHeading = element("div", "downloads-heading");
  const headingText = element("div");
  const heading = element("h2", "", "Video downloads");
  heading.id = "downloads-heading";
  const panelDescription = element("p", "", "Keep the local server running until downloads finish.");
  headingText.append(heading, panelDescription);
  const refreshControls = element("div", "downloads-refresh-controls");
  const checkStatus = element("button", "text-button", "Refresh downloads");
  checkStatus.type = "button";
  checkStatus.title = "Check current progress without restarting any downloads";
  const lastChecked = element("span", "downloads-last-checked", "Not checked yet");
  refreshControls.append(checkStatus, lastChecked);
  panelHeading.append(headingText, refreshControls);
  const refreshFeedback = element("p", "downloads-refresh-feedback");
  refreshFeedback.setAttribute("role", "status");
  refreshFeedback.hidden = true;
  const connectionNotice = element("p", "downloads-connection-notice");
  connectionNotice.setAttribute("role", "status");
  connectionNotice.hidden = true;
  const jobList = element("div", "download-jobs");
  const showMore = element("button", "text-button downloads-show-more", "Show more downloads");
  showMore.type = "button";
  showMore.hidden = true;
  const panelFooter = element("p", "downloads-footer", "Progress updates automatically every 1.5 seconds while downloads are active. Refresh downloads checks the latest progress; it does not restart or retry downloads. History lasts while this local server is running.");
  panel.append(panelHeading, refreshFeedback, connectionNotice, jobList, showMore, panelFooter);
  const clipsCard = document.querySelector(".clips-card");
  clipsCard.after(panel);

  function error(message = "") {
    find("download-error").textContent = message;
    find("download-error").hidden = !message;
  }

  function updateControls() {
    const batch = batchClips !== null;
    const clip = !batch && clipOption.checked;
    rangeFields.hidden = !clip;
    rangeFields.disabled = !clip || busy;
    options.hidden = batch;
    options.disabled = batch || busy;
    find("download-batch-summary").hidden = !batch;
    submit.disabled = busy || choosingFolder || !sourceVideo || (batch && !batchClips.length) || capabilities?.ready !== true || Boolean(serverError);
    submit.textContent = busy ? "Queueing downloads…" : batch ? `Download ${batchClips.length} ${batchClips.length === 1 ? "clip" : "clips"}` : clip ? "Download clip" : "Download full video";
    find("download-cancel").disabled = busy;
    find("download-close").disabled = busy;
    find("download-folder").disabled = busy || choosingFolder;
    find("download-choose-folder").disabled = busy || choosingFolder;
    find("download-choose-folder").textContent = choosingFolder ? "Choosing folder…" : "Choose folder";
    find("download-use-default").disabled = busy || choosingFolder || !capabilities?.download_dir;
    find("download-quality").disabled = busy;
    const quality = find("download-quality").value;
    find("download-quality-help").textContent = `${quality === "best" ? "Uses the highest available source resolution. No upscaling." : "Uses a lower resolution if the selected one is unavailable. No upscaling."}${batch ? " This choice applies to every clip in this batch." : ""}`;
    refresh();
  }

  function refresh() {
    trigger.disabled = busy || !getVideo();
    const downloadAll = document.getElementById("download-all-clips");
    if (downloadAll) downloadAll.disabled = busy || !getVideo() || !(getClips?.()?.length);
  }

  function renderSetup() {
    let message = "Checking download tools…";
    if (serverError) message = serverError;
    else if (capabilities?.ready) message = `Ready · yt-dlp, FFmpeg, and ${capabilities.js_runtime || "JavaScript runtime"}`;
    else if (capabilities) {
      const missing = [];
      if (!capabilities.yt_dlp) missing.push("yt-dlp");
      if (!capabilities.ffmpeg) missing.push("FFmpeg / ffprobe");
      if (!capabilities.js_runtime) missing.push("Node.js 22+ or Deno 2.3+");
      message = `Setup required${missing.length ? `: ${missing.join(", ")}` : ". Check the local server."}`;
    }
    find("download-capabilities").textContent = message;
    find("download-setup-help").hidden = !capabilities || capabilities.ready;
    updateControls();
  }

  function renderJobs() {
    const focused = document.activeElement;
    const focusedRow = jobList.contains(focused) ? focused.closest(".download-job") : null;
    const restoreFocus = focusedRow ? {
      id: focusedRow.dataset.jobId, tag: focused.tagName.toLowerCase(),
      start: focused.selectionStart, end: focused.selectionEnd, label: focused.textContent,
    } : null;
    panel.hidden = jobs.length === 0;
    connectionNotice.textContent = serverError;
    connectionNotice.hidden = !serverError;
    const totals = jobs.reduce((counts, job) => { counts[job.status] = (counts[job.status] || 0) + 1; return counts; }, {});
    panelDescription.textContent = `${totals.queued || 0} queued · ${(totals.downloading || 0) + (totals.processing || 0)} active · ${totals.completed || 0} completed · ${totals.failed || 0} failed. Keep the local server running.`;
    // Large batches remain usable: show active jobs first and expand history on demand.
    const priority = { downloading: 0, processing: 0, queued: 1, failed: 2, completed: 3 };
    const visibleJobs = [...jobs].sort((a, b) => (priority[a.status] ?? 4) - (priority[b.status] ?? 4)).slice(0, visibleJobCount);
    showMore.hidden = jobs.length <= visibleJobCount;
    showMore.textContent = `Show more downloads (${Math.min(visibleJobCount, jobs.length)} of ${jobs.length})`;
    jobList.replaceChildren(...visibleJobs.map((job) => {
      const row = element("article", "download-job");
      row.dataset.jobId = job.id;
      const titleRow = element("div", "download-job-heading");
      const title = element("h3", "", job.filename || `${job.scope === "clip" ? "Clip" : "Full video"} · ${job.video_id}`);
      const statusName = labels[job.status] || "Unknown status";
      const status = element("span", `download-status ${Object.hasOwn(labels, job.status) ? job.status : ""}`, statusName);
      titleRow.append(title, status);
      const description = job.scope === "clip" && Number.isFinite(job.start_seconds) && Number.isFinite(job.end_seconds)
        ? `${clock(job.start_seconds)} → ${clock(job.end_seconds)} · ${job.video_id}`
        : `Full video · ${job.video_id}`;
      row.append(titleRow, element("p", "download-job-detail", `${description} · ${qualityLabel(job.quality)} · MP4`));
      if (job.status === "completed" && Number.isSafeInteger(job.width) && job.width > 0 && Number.isSafeInteger(job.height) && job.height > 0) {
        row.append(element("p", "download-job-resolution", `Actual resolution: ${job.width} × ${job.height}`));
      }
      if (activeStatuses.has(job.status)) {
        const progressRow = element("div", "download-progress-row");
        const progress = element("progress", "download-progress");
        progress.max = 100;
        progress.setAttribute("aria-label", `${statusName}: ${job.video_id}`);
        const known = typeof job.progress === "number" && Number.isFinite(job.progress);
        if (known) progress.value = Math.min(100, Math.max(0, job.progress));
        progressRow.append(progress, element("span", "", known ? `${Math.round(progress.value)}%` : statusName));
        row.append(progressRow);
      }
      if (job.message) row.append(element("p", `download-job-message${job.status === "failed" ? " failed" : ""}`, job.message));
      if (job.destination && job.status !== "completed") row.append(element("p", "download-job-destination", `Save folder: ${job.destination}`));
      if (job.path && job.status === "completed") {
        const savedPath = element("div", "download-saved-path");
        const path = element("input");
        path.readOnly = true;
        path.value = job.path;
        path.setAttribute("aria-label", `Saved file path: ${job.filename || job.video_id}`);
        path.addEventListener("click", () => path.select());
        const copy = element("button", "button secondary", "Copy path");
        copy.type = "button";
        copy.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(job.path);
            copy.textContent = "Copied";
          } catch {
            path.focus();
            path.select();
            copy.textContent = "Press Ctrl/⌘+C";
          }
        });
        savedPath.append(path, copy);
        row.append(savedPath);
      }
      return row;
    }));
    // Polling must not interrupt copying a completed file path while other jobs run.
    if (restoreFocus && ["input", "button"].includes(restoreFocus.tag)) {
      const row = [...jobList.children].find((item) => item.dataset.jobId === restoreFocus.id);
      const replacement = row?.querySelector(restoreFocus.tag);
      if (replacement) {
        replacement.focus({ preventScroll: true });
        if (restoreFocus.tag === "input") replacement.setSelectionRange(restoreFocus.start, restoreFocus.end);
        else replacement.textContent = restoreFocus.label;
      }
    }
  }

  async function request(method, body, endpoint = "/api/downloads", timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method,
        signal: controller.signal,
        cache: "no-store",
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || `Download request failed (${response.status}).`);
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (jobs.some((job) => activeStatuses.has(job.status))) pollTimer = setTimeout(fetchJobs, 1500);
  }

  async function fetchJobs() {
    if (pendingRefresh) return pendingRefresh;
    clearTimeout(pollTimer);
    checkStatus.disabled = true;
    checkStatus.textContent = "Refreshing…";
    find("download-check").disabled = true;
    pendingRefresh = (async () => {
      try {
        const data = await request("GET");
        if (!Array.isArray(data.jobs) || !data.capabilities) throw new Error("Invalid server response.");
        jobs = data.jobs;
        capabilities = data.capabilities;
        serverError = "";
        lastCheckedAt = new Date();
      } catch {
        // Keep the last known job states; a lost connection does not mean jobs failed.
        serverError = "Local server unavailable. Keep it running, then use Refresh downloads. Last known download states are shown.";
      } finally {
        pendingRefresh = null;
        checkStatus.disabled = false;
        checkStatus.textContent = "Refresh downloads";
        find("download-check").disabled = false;
        lastChecked.textContent = lastCheckedAt ? `Last checked ${lastCheckedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "Not checked yet";
        renderSetup();
        renderJobs();
        schedulePoll();
      }
    })();
    return pendingRefresh;
  }

  async function startDownload(event) {
    event.preventDefault();
    if (busy) { error("A download request is already being sent. Please wait for confirmation."); return; }
    if (choosingFolder) { error("Finish choosing a folder before starting the download."); return; }
    if (!sourceVideo) { error("Load a video before downloading."); return; }
    if (serverError) { error("Cannot reach the local server. Check that it is running, then click Check again."); return; }
    if (capabilities?.ready !== true) { error("Download tools are not ready. Check Local download setup above."); return; }
    error();
    const batch = batchClips !== null;
    let body;
    try {
      const destination = find("download-folder").value.trim();
      if (!destination) throw new Error("Choose a save folder or enter its absolute path before downloading.");
      if (destination.length > 4096 || /[\u0000-\u001f]/.test(destination) || !/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(destination)) {
        throw new Error("Enter an absolute folder path, such as /Users/name/Videos or C:\\Users\\name\\Videos.");
      }
      const quality = find("download-quality").value;
      if (!qualities.has(quality)) throw new Error("Select a supported resolution before downloading.");
      if (batch) {
        if (!batchClips.length) throw new Error("This video has no saved clips to download. Add a clip first.");
        if (batchClips.length > 10000) throw new Error("A batch can contain at most 10,000 clips.");
        body = { downloads: batchClips.map((clip, index) => {
          try { return clipRequest(clip.start_seconds, clip.end_seconds, quality); }
          catch (failure) { throw new Error(`Clip ${index + 1}: ${failure.message}`); }
        }), destination };
      } else {
        body = clipOption.checked
          ? { ...clipRequest(find("download-start").value, find("download-end").value, quality), destination }
          : { video_id: sourceVideo.video_id, scope: "full", quality, destination };
      }
    } catch (failure) {
      error(failure.message);
      return;
    }
    busy = true;
    updateControls();
    try {
      const data = await request("POST", body, batch ? "/api/downloads/batch" : "/api/downloads");
      const added = batch ? data.jobs : [data.job || (data.id ? data : null)];
      if (!Array.isArray(added) || !added.length || added.some((job) => !job?.id)) {
        throw new Error("The server did not confirm the queued downloads. Click Check again before retrying.");
      }
      // An earlier status request may have started before this job was queued.
      if (pendingRefresh) await pendingRefresh;
      const addedIds = new Set(added.map((job) => job.id));
      jobs = [...added, ...jobs.filter((entry) => !addedIds.has(entry.id))];
      renderJobs();
      dialog.close();
      if (!panel.hidden) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      fetchJobs();
    } catch (failure) {
      if (failure.name === "AbortError" || failure instanceof TypeError) {
        error("The server response was interrupted. Click Check again before retrying: the download may already have started.");
        await fetchJobs();
      } else error(failure.message);
    } finally {
      busy = false;
      updateControls();
    }
  }

  function clipRequest(start, end, quality) {
    const start_seconds = parseTime(start);
    const end_seconds = parseTime(end);
    if (end_seconds <= start_seconds) throw new Error("End time must be later than start time.");
    if (Number.isFinite(sourceVideo.duration_seconds) && sourceVideo.duration_seconds > 0 && end_seconds > sourceVideo.duration_seconds) {
      throw new Error("End time cannot exceed the video duration.");
    }
    return { video_id: sourceVideo.video_id, scope: "clip", start_seconds, end_seconds, quality };
  }

  function prepareDialog(active, clips, range = null, useClip = false) {
    if (busy) { error("Wait for the current download request to finish."); return false; }
    if (dialog.open) { error("Finish or close this download dialog before starting another."); return false; }
    dialogSession += 1;
    sourceVideo = active ? { ...active } : null;
    batchClips = clips;
    find("download-heading").textContent = clips !== null ? "Download all clips" : "Download video";
    find("download-source-title").textContent = active?.title || active?.video_id || "No video selected";
    const count = clips?.length || 0;
    find("download-batch-summary").textContent = `${count} saved ${count === 1 ? "clip" : "clips"} from this video will be saved as MP4 ${count === 1 ? "file" : "files"} in one new batch folder, in time order. This includes all saved clips, regardless of search filters. Unsaved edits are not included.`;
    find("download-format-note").textContent = clips !== null
      ? "A new batch folder will be created inside your chosen folder. All clips go directly into that batch folder as MP4 files with source audio. Format conversion may take additional time."
      : "Saved as MP4 with source audio, directly in your chosen folder. No extra video folder is created. Format conversion may take additional time.";
    fullOption.checked = !useClip;
    clipOption.checked = useClip;
    find("download-start").value = Number.isFinite(range?.start_seconds) && range.start_seconds >= 0 ? clock(range.start_seconds) : "";
    find("download-end").value = Number.isFinite(range?.end_seconds) && range.end_seconds >= 0 ? clock(range.end_seconds) : "";
    // Every new request needs an explicit destination choice; never reuse it silently.
    find("download-folder").value = "";
    find("download-quality").value = qualities.has(capabilities?.default_quality) ? capabilities.default_quality : "1080";
    folderStatus();
    error();
    renderSetup();
    dialog.showModal();
    (clips !== null ? find("download-folder") : useClip ? find("download-start") : fullOption).focus();
    if (!active) error("Load a video before downloading.");
    else if (clips !== null && !clips.length) error("This video has no saved clips to download. Add a clip first.");
    fetchJobs();
    return true;
  }

  function open(clip = null) {
    let range = clip;
    if (!range) {
      try { range = getRange?.() || null; } catch { range = null; }
    }
    prepareDialog(getVideo(), null, range, Boolean(clip));
  }

  function openAll() {
    let clips;
    try {
      const saved = getClips?.() || [];
      if (!Array.isArray(saved)) throw new Error("Saved clips could not be read.");
      clips = saved.map((clip) => ({ ...clip })).sort((a, b) => a.start_seconds - b.start_seconds);
    } catch {
      if (prepareDialog(getVideo(), [])) error("Saved clips could not be read. Reload the workspace and try again.");
      return;
    }
    prepareDialog(getVideo(), clips);
  }

  function folderStatus(message = "") {
    find("download-folder-status").textContent = message;
    find("download-folder-status").hidden = !message;
  }

  async function chooseFolder() {
    if (busy || choosingFolder) return;
    const session = dialogSession;
    choosingFolder = true;
    error();
    folderStatus("Select a folder in the system dialog. You can cancel and enter a full path instead.");
    updateControls();
    try {
      const data = await request("POST", {}, "/api/downloads/choose-folder", 300000);
      if (session !== dialogSession || !dialog.open) return;
      if (typeof data.path === "string" && data.path) {
        find("download-folder").value = data.path;
        folderStatus("Folder selected. Review the destination, then start the download.");
      } else if (data.path === null) folderStatus("Folder selection canceled. Choose again or enter an absolute path.");
      else throw new Error("The folder picker returned no valid path. Enter the folder’s absolute path instead.");
    } catch (failure) {
      if (session !== dialogSession || !dialog.open) return;
      folderStatus();
      error(`${failure.name === "AbortError" ? "Folder selection timed out." : failure.message} You can enter an absolute folder path manually.`);
    } finally {
      if (session === dialogSession) {
        choosingFolder = false;
        updateControls();
      }
    }
  }

  trigger.addEventListener("click", () => open());
  form.addEventListener("submit", startDownload);
  options.addEventListener("change", () => { error(); updateControls(); });
  find("download-quality").addEventListener("change", () => { error(); updateControls(); });
  rangeFields.addEventListener("input", () => error());
  find("download-folder").addEventListener("input", () => { error(); folderStatus(); });
  find("download-choose-folder").addEventListener("click", chooseFolder);
  find("download-use-default").addEventListener("click", () => {
    if (!capabilities?.download_dir) { error("The default folder is unavailable. Enter an absolute folder path."); return; }
    find("download-folder").value = capabilities.download_dir;
    error();
    folderStatus("Default folder for this computer selected. Review the path above, then start the download.");
  });
  for (const id of ["download-close", "download-cancel"]) find(id).addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { dialogSession += 1; choosingFolder = false; updateControls(); });
  find("download-check").addEventListener("click", fetchJobs);
  checkStatus.addEventListener("click", async () => {
    refreshFeedback.hidden = false;
    refreshFeedback.textContent = "Checking the latest download progress…";
    await fetchJobs();
    refreshFeedback.textContent = serverError ? "Could not refresh. The last known states are still shown; no downloads were restarted." : "Download progress refreshed. No downloads were restarted.";
  });
  showMore.addEventListener("click", () => { visibleJobCount += 50; renderJobs(); });
  refresh();
  fetchJobs();
  return { open, openAll, refresh };
}

/** GitHub Pages has no Python service: keep annotations usable without API calls. */
function initBrowserDownloads(getVideo, getClips) {
  const trigger = element("button", "button secondary download-video-button", "Download video");
  trigger.id = "download-video-button";
  trigger.type = "button";
  trigger.title = "Video downloads require the local app";
  document.querySelector(".video-card-heading").append(trigger);
  const dialog = element("dialog", "download-dialog");
  dialog.id = "download-dialog";
  dialog.setAttribute("aria-labelledby", "download-heading");
  dialog.innerHTML = `
    <div class="download-dialog-heading"><div><div class="eyebrow">LOCAL APP REQUIRED</div><h2 id="download-heading">Download videos locally</h2></div><button type="button" class="icon-button" id="download-close" aria-label="Close download dialog">×</button></div>
    <p class="download-source-title">This browser edition supports annotation and JSON export. GitHub Pages cannot run the Python service that downloads and cuts videos.</p>
    <ol class="browser-download-steps"><li>Export your annotations as JSON.</li><li>Install and start the local app using the README instructions.</li><li>Import your JSON there, then download a video, a single clip, or all saved clips.</li></ol>
    <p class="download-format-note">Nothing is uploaded to the repository. Downloads in the local app ask you to choose a destination on your own computer.</p>
    <div class="download-dialog-actions"><button type="button" class="button secondary" id="download-cancel">Close</button><a class="button primary" href="https://github.com/chnln/omnitalk-annotation-toolkit#run-locally" target="_blank" rel="noopener noreferrer">Local setup ↗</a></div>`;
  document.body.append(dialog);
  const open = () => { if (!dialog.open) dialog.showModal(); };
  const refresh = () => {
    trigger.disabled = !getVideo();
    const downloadAll = document.getElementById("download-all-clips");
    if (downloadAll) downloadAll.disabled = !getVideo() || !getClips?.()?.length;
  };
  trigger.addEventListener("click", open);
  for (const id of ["download-close", "download-cancel"]) dialog.querySelector(`#${id}`).addEventListener("click", () => dialog.close());
  refresh();
  return { open, openAll: open, refresh };
}
