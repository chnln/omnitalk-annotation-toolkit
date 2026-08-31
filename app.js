import {
  STORAGE_KEY, LIMITS, createProject, createVideo, createClip,
  parseYouTubeUrl, parseTime, formatTime, validateProject,
} from "./core.js";
import { initDownloads } from "./downloads.js";

const isStaticMode = document.body.dataset.mode === "static";

const $ = (id) => document.getElementById(id);
const WORKSPACE_KEY = `${STORAGE_KEY}.workspace`;
const SIDEBAR_KEY = "omnitalk.annotation.sidebar.collapsed.v1";
const draftFields = ["clip-start", "clip-end", "clip-note", "clip-tags"];
const clock = (seconds) => formatTime(seconds, { milliseconds: true });
let project = createProject();
let activeId = null;
let drafts = {};
let editingId = null;
let player = null;
let playerReady = false;
let playerGeneration = 0;
let apiPromise = null;
let mediaDuration = 0;
let preview = null;
let playbackBounded = false;
let toastTimer;
let memoryNeedsBackup = false;
let storageBlocked = false;
let recoveryText = null;
let downloadUI = null;
let latestExport = null;
let sidebarCollapsed = false;
const storedValues = new Map();

function setSidebarCollapsed(collapsed, persist = true) {
  sidebarCollapsed = Boolean(collapsed);
  const content = $("sidebar-content");
  const toggle = $("sidebar-toggle");
  if (sidebarCollapsed && content.contains(document.activeElement)) toggle.focus();
  content.hidden = sidebarCollapsed;
  document.body.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  toggle.setAttribute("aria-expanded", String(!sidebarCollapsed));
  const label = sidebarCollapsed ? "Expand video library" : "Collapse video library";
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
  if (persist) {
    // Optional layout preferences must not affect project autosave or backups.
    try { localStorage.setItem(SIDEBAR_KEY, String(sidebarCollapsed)); } catch { /* Keep the layout usable without storage. */ }
  }
}

function restoreSidebarPreference() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(SIDEBAR_KEY) === "true"; } catch { /* Use the expanded layout if storage is unavailable. */ }
  setSidebarCollapsed(collapsed, false);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function actionButton(label, iconName, handler, className = "") {
  const button = el("button", `icon-button ${className}`);
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(iconName));
  button.addEventListener("click", handler);
  return button;
}

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  $("toast-message").textContent = message;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4000);
}

function fieldError(id, message = "") {
  $(id).textContent = message;
  $(id).hidden = !message;
}

function storageWarning(message) {
  $("storage-warning").hidden = false;
  $("storage-warning-text").textContent = message;
  $("save-status").classList.add("error");
  $("save-status").replaceChildren(el("span", "status-dot"), document.createTextNode("Export a backup"));
}

function readStorage(key) {
  const raw = localStorage.getItem(key);
  storedValues.set(key, raw);
  return raw;
}

function writeStorage(key, value) {
  memoryNeedsBackup = true;
  if (storageBlocked) return false;
  try {
    if (localStorage.getItem(key) !== (storedValues.get(key) ?? null)) {
      storageBlocked = true;
      storageWarning("Another tab changed this workspace. Autosave is paused to prevent overwriting it. Export your annotations, then reload.");
      return false;
    }
    const raw = JSON.stringify(value);
    localStorage.setItem(key, raw);
    storedValues.set(key, raw);
    memoryNeedsBackup = false;
    $("save-status").classList.remove("error");
    $("save-status").replaceChildren(el("span", "status-dot"), document.createTextNode("Saved locally"));
    $("storage-warning").hidden = true;
    return true;
  } catch {
    storageBlocked = true;
    storageWarning("Browser storage is unavailable or full. Autosave is paused; your annotations are still on this page. Export JSON to keep them.");
    return false;
  }
}

function persistProject(touch = true) {
  if (touch) project.updated_at = new Date().toISOString();
  return writeStorage(STORAGE_KEY, project);
}

function persistWorkspace() {
  return writeStorage(WORKSPACE_KEY, { project_id: project.project_id, active_video_id: activeId, drafts });
}

function restoreStorage() {
  let raw;
  try {
    raw = readStorage(STORAGE_KEY);
    if (raw) project = validateProject(JSON.parse(raw));
  } catch {
    storageBlocked = true;
    recoveryText = raw || null;
    storageWarning(raw ? "The saved project could not be read. Its original data is untouched. Download the original draft, and export any new annotations as JSON." : "Browser storage is unavailable. Export JSON to keep your annotations.");
    $("recover-storage").hidden = !recoveryText;
  }
  activeId = project.videos[0]?.id ?? null;
  try {
    const workspaceRaw = readStorage(WORKSPACE_KEY);
    if (!workspaceRaw) return;
    const workspace = JSON.parse(workspaceRaw);
    if (workspace.project_id !== project.project_id) return;
    if (project.videos.some((video) => video.id === workspace.active_video_id)) activeId = workspace.active_video_id;
    for (const video of project.videos) {
      const draft = workspace.drafts?.[video.id];
      if (draft && ["start", "end", "note", "tags"].every((key) => typeof draft[key] === "string" && draft[key].length <= 20000)) {
        drafts[video.id] = {
          start: draft.start, end: draft.end, note: draft.note, tags: draft.tags,
          editing_id: video.clips.some((clip) => clip.id === draft.editing_id) ? draft.editing_id : null,
        };
      }
    }
  } catch {
    storageBlocked = true;
    storageWarning("The unfinished clip draft could not be restored. Saved clips are still available. Export a backup; the original browser data has not been overwritten.");
  }
}

const currentVideo = () => project.videos.find((video) => video.id === activeId);
const knownDuration = () => mediaDuration || currentVideo()?.duration_seconds || null;

function currentDraft() {
  return { start: $("clip-start").value, end: $("clip-end").value, note: $("clip-note").value, tags: $("clip-tags").value, editing_id: editingId };
}

function rememberDraft(persist = true) {
  if (!activeId) return;
  const draft = currentDraft();
  if (draft.editing_id || draft.start || draft.end || draft.note || draft.tags) drafts[activeId] = draft;
  else delete drafts[activeId];
  if (persist) persistWorkspace();
}

function restoreDraft() {
  const draft = drafts[activeId] || { start: "", end: "", note: "", tags: "", editing_id: null };
  editingId = draft.editing_id;
  draftFields.forEach((id, index) => { $(id).value = draft[["start", "end", "note", "tags"][index]]; });
  $("editor-title").textContent = editingId ? "Edit clip" : "New clip";
  $("save-clip-label").textContent = editingId ? "Save changes" : "Add clip";
  $("cancel-edit").hidden = !editingId;
  fieldError("clip-error");
  updateSelectionDuration();
}

function resetDraft() {
  delete drafts[activeId];
  restoreDraft();
  persistWorkspace();
}

function splitTags(value) {
  return [...new Set(value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))];
}

function isDirtyDraft(draft, video) {
  if (!draft) return false;
  const clip = video.clips.find((item) => item.id === draft.editing_id);
  if (!clip) return !!(draft.start || draft.end || draft.note || draft.tags);
  try {
    return parseTime(draft.start) !== clip.start_seconds || parseTime(draft.end) !== clip.end_seconds || draft.note !== clip.note || JSON.stringify(splitTags(draft.tags)) !== JSON.stringify(clip.tags);
  } catch { return true; }
}

function renderVideos() {
  $("video-count").textContent = project.videos.length;
  $("library-empty").hidden = !!project.videos.length;
  $("export-button").disabled = !project.videos.length;
  $("video-list").replaceChildren(...project.videos.map((video) => {
    const row = el("div", "video-library-row");
    row.dataset.videoId = video.id;
    const button = el("button", `video-item${video.id === activeId ? " active" : ""}`);
    button.type = "button";
    button.dataset.videoId = video.id;
    button.title = video.title;
    button.setAttribute("aria-label", `Select video: ${video.title}`);
    if (video.id === activeId) button.setAttribute("aria-current", "true");
    const thumbnail = el("span", "video-item-thumbnail");
    thumbnail.append(icon("video"));
    const info = el("span", "video-item-info");
    info.append(el("span", "video-item-title", video.title || video.video_id), el("span", "video-item-detail", `${video.clips.length} ${video.clips.length === 1 ? "clip" : "clips"} · ${video.duration_seconds ? formatTime(video.duration_seconds) : "Unknown duration"}`));
    button.append(thumbnail, info);
    if (video.id === activeId) button.append(el("span", "video-item-indicator"));
    button.addEventListener("click", () => selectVideo(video.id));
    row.append(button, actionButton(`Delete video: ${video.title}`, "trash", () => deleteVideo(video.id), "delete-video-button"));
    return row;
  }));
}

function updateVideoMetadata(video) {
  // Player callbacks must not replace a button between pointer-down and click.
  const row = [...$("video-list").children].find((item) => item.dataset.videoId === video.id);
  const button = row?.querySelector(".video-item");
  if (button) {
    button.title = video.title;
    button.setAttribute("aria-label", `Select video: ${video.title}`);
    button.querySelector(".video-item-title").textContent = video.title || video.video_id;
    button.querySelector(".video-item-detail").textContent = `${video.clips.length} ${video.clips.length === 1 ? "clip" : "clips"} · ${video.duration_seconds ? formatTime(video.duration_seconds) : "Unknown duration"}`;
    const remove = row.querySelector(".delete-video-button");
    remove.title = `Delete video: ${video.title}`;
    remove.setAttribute("aria-label", remove.title);
  }
  if (video.id === activeId) $("clips-description").textContent = `Clips for ${video.title || video.video_id}, sorted by start time.`;
}

function renderStats() {
  let count = 0;
  let duration = 0;
  for (const video of project.videos) {
    count += video.clips.length;
    duration += video.clips.reduce((sum, clip) => sum + clip.end_seconds - clip.start_seconds, 0);
  }
  $("total-clips").textContent = String(count).padStart(2, "0");
  $("total-duration").textContent = formatTime(duration);
}

function sortedClips() {
  return [...(currentVideo()?.clips || [])].sort((a, b) => a.start_seconds - b.start_seconds || a.end_seconds - b.end_seconds);
}

function renderClips() {
  const allClips = sortedClips();
  const video = currentVideo();
  $("clips-description").textContent = video
    ? `Clips for ${video.title || video.video_id}, sorted by start time.`
    : "Load a video, then add clips to this list.";
  const query = $("clips-search").value.trim().toLocaleLowerCase();
  const clips = allClips.filter((clip) => `${clip.note} ${clip.tags.join(" ")}`.toLocaleLowerCase().includes(query));
  $("clip-count").textContent = allClips.length;
  $("clips-empty").hidden = allClips.length > 0;
  $("clips-table-container").hidden = !clips.length;
  $("no-results").hidden = !allClips.length || !!clips.length;
  $("clips-body").replaceChildren(...clips.map((clip) => {
    const number = String(allClips.indexOf(clip) + 1).padStart(3, "0");
    const row = el("tr", clip.id === editingId ? "editing" : "");
    row.dataset.clipId = clip.id;
    const numberCell = el("td");
    const numberLabel = el("div", "clip-number");
    const play = actionButton(`Play clip ${number}`, "play", () => previewInterval(clip.start_seconds, clip.end_seconds));
    play.dataset.action = "play-clip";
    play.disabled = !playerReady;
    numberLabel.append(play, document.createTextNode(number));
    numberCell.append(numberLabel);
    const timeCell = el("td");
    timeCell.append(el("div", "clip-time", `${clock(clip.start_seconds)} → ${clock(clip.end_seconds)}`), el("div", "clip-length", `${(clip.end_seconds - clip.start_seconds).toFixed(3)} s`));
    const noteCell = el("td");
    const note = el("div", `clip-note-text${clip.note ? "" : " empty"}`, clip.note || "No note");
    note.title = clip.note;
    noteCell.append(note);
    const tagCell = el("td");
    const tags = el("div", "tag-list");
    tags.append(...clip.tags.map((tag) => { const item = el("span", "clip-tag", tag); item.title = tag; return item; }));
    tagCell.append(tags);
    const actionsCell = el("td");
    const actions = el("div", "row-actions");
    actions.append(actionButton(`Download clip ${number}`, "download", () => downloadUI?.open(clip)), actionButton(`Edit clip ${number}`, "edit", () => editClip(clip)), actionButton(`Delete clip ${number}`, "trash", () => deleteClip(clip), "delete-clip"));
    actionsCell.append(actions);
    row.append(numberCell, timeCell, noteCell, tagCell, actionsCell);
    return row;
  }));
  renderTimeline();
  downloadUI?.refresh();
}

function renderTimeline() {
  const duration = knownDuration();
  $("timeline-middle").textContent = duration ? formatTime(duration / 2) : "--:--";
  $("timeline-end").textContent = duration ? formatTime(duration) : "--:--";
  $("clip-timeline").replaceChildren();
  if (!duration) return;
  for (const [index, clip] of sortedClips().entries()) {
    const band = el("button", "timeline-clip");
    const label = `Clip ${index + 1}: ${clock(clip.start_seconds)} to ${clock(clip.end_seconds)}`;
    band.title = label;
    band.setAttribute("aria-label", label);
    band.style.left = `${Math.min(100, clip.start_seconds / duration * 100)}%`;
    band.style.width = `${Math.max(0, Math.min(clip.end_seconds, duration) - clip.start_seconds) / duration * 100}%`;
    band.disabled = !playerReady;
    band.addEventListener("click", () => previewInterval(clip.start_seconds, clip.end_seconds));
    $("clip-timeline").append(band);
  }
}

function renderCurrentVideo() {
  const video = currentVideo();
  $("clip-fields").disabled = !video;
  $("video-title").disabled = !video;
  $("video-title").value = video?.title ?? "";
  $("source-link").hidden = !video;
  if (video) $("source-link").href = video.url;
  $("video-empty").hidden = !!video;
  $("youtube-mount").hidden = !video;
  renderVideos();
  restoreDraft();
  renderClips();
  renderStats();
  downloadUI?.refresh();
}

function selectVideo(id, start = null) {
  const selected = project.videos.find((video) => video.id === id);
  if (!selected) return showToast("This video is no longer in the library.", true);
  if (id === activeId) {
    if (playerReady) {
      if (start !== null) seek(start);
      showToast(`Current video: ${selected.title || selected.video_id}`);
    } else {
      loadPlayer(selected, start ?? 0);
      showToast("Reconnecting to this video. Your clips and draft are unchanged.");
    }
    return;
  }
  rememberDraft(false);
  activeId = id;
  mediaDuration = 0;
  $("clips-search").value = "";
  renderCurrentVideo();
  persistWorkspace();
  loadPlayer(selected, start ?? 0);
  showToast(`Switched to ${selected.title || selected.video_id}`);
}

function addVideo(input) {
  try {
    const parsed = parseYouTubeUrl(input);
    let video = project.videos.find((item) => item.video_id === parsed.video_id);
    const existing = !!video;
    if (!video) {
      if (project.videos.length >= LIMITS.videos) throw new Error(`A project can contain up to ${LIMITS.videos} videos. Export this batch before starting another.`);
      video = createVideo(parsed);
      project.videos.push(video);
      persistProject();
    }
    selectVideo(video.id, parsed.start_seconds);
    $("source-url").value = "";
    fieldError("source-error");
    showToast(existing ? "Opened the existing video. Your annotations are unchanged." : "Video added to your workspace");
  } catch (error) { fieldError("source-error", error.message); }
}

async function deleteVideo(id) {
  const video = project.videos.find((item) => item.id === id);
  if (!video) return;
  const count = video.clips.length;
  if (!await confirmAction("Delete this video?", `Remove “${video.title || video.video_id}” from this workspace?\nThis removes the video, its ${count} saved ${count === 1 ? "clip" : "clips"}, and its unfinished draft.\nDownloaded files, existing JSON exports, and running downloads will not be changed.`, "Delete video")) return;
  const index = project.videos.findIndex((item) => item.id === id);
  if (index < 0) return;
  rememberDraft(false);
  const wasActive = activeId === id;
  project.videos.splice(index, 1);
  delete drafts[id];
  if (wasActive) {
    activeId = project.videos[Math.min(index, project.videos.length - 1)]?.id ?? null;
    $("clips-search").value = "";
    mediaDuration = 0;
    if (!activeId) clearPlayer();
    renderCurrentVideo();
    if (activeId) loadPlayer(currentVideo());
  } else {
    renderVideos();
    renderStats();
    downloadUI?.refresh();
  }
  persistProject();
  persistWorkspace();
  showToast("Video and its annotations removed from this workspace");
}

function playerNotice(message = "", retry = false) {
  $("player-notice-text").textContent = message;
  $("player-notice").hidden = !message;
  $("retry-player").hidden = !retry;
}

function setPlayerReady(ready) {
  playerReady = ready;
  for (const id of ["play-toggle", "seek-back", "seek-forward", "playback-rate", "capture-start", "capture-end"]) $(id).disabled = !ready;
  $("seek-range").disabled = !ready || !knownDuration();
  updateSelectionDuration();
  // Keep annotation/download controls stable as the asynchronous player loads.
  for (const button of $("clips-body").querySelectorAll('[data-action="play-clip"]')) button.disabled = !ready;
  renderTimeline();
}

function ensureYouTubeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    const timer = setTimeout(() => { script.remove(); reject(new Error("The YouTube connection timed out. Check your network; you can still enter times and save clips manually.")); }, 15000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(window.YT); };
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error("Could not load YouTube. Check your network or browser blockers. Manual annotation is still available.")); };
    document.head.append(script);
  }).catch((error) => { apiPromise = null; throw error; });
  return apiPromise;
}

function clearPlayer() {
  playerGeneration += 1;
  preview = null;
  playbackBounded = false;
  mediaDuration = 0;
  lastDurationSave = 0;
  if (player) { try { player.destroy(); } catch { /* A disconnected iframe may already be gone. */ } }
  player = null;
  $("youtube-mount").replaceChildren();
  setPlayerReady(false);
  updatePlayButton(false);
  playerNotice();
  $("current-time").textContent = "00:00.000";
  $("video-duration").textContent = "--:--";
  $("seek-range").value = "0";
  $("seek-range").max = "1";
  $("seek-range").style.background = "";
  $("playback-rate").value = "1";
  $("player-footnote").textContent = "Playback needs internet · Times can also be entered manually";
}

async function loadPlayer(video, start = 0) {
  const generation = ++playerGeneration;
  preview = null;
  playbackBounded = false;
  lastDurationSave = 0;
  mediaDuration = 0;
  if (player) { try { player.destroy(); } catch { /* A disconnected iframe may already be gone. */ } }
  player = null;
  setPlayerReady(false);
  $("current-time").textContent = clock(start);
  $("video-duration").textContent = video.duration_seconds ? formatTime(video.duration_seconds) : "--:--";
  $("seek-range").value = "0";
  $("seek-range").style.background = "";
  $("playback-rate").value = "1";
  updatePlayButton(false);
  playerNotice("Connecting to YouTube… You can enter annotation times manually while waiting.");
  const iframe = document.createElement("iframe");
  iframe.id = "youtube-player";
  iframe.title = `YouTube player: ${video.title}`;
  iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  const source = new URL(`https://www.youtube.com/embed/${video.video_id}`);
  source.search = new URLSearchParams({ enablejsapi: "1", origin: location.origin, playsinline: "1", rel: "0", hl: "en", start: String(Math.floor(start)) });
  iframe.src = source.href;
  $("youtube-mount").replaceChildren(iframe);
  let readyTimer;
  try {
    const YT = await ensureYouTubeAPI();
    if (generation !== playerGeneration) return;
    readyTimer = setTimeout(() => {
      if (generation === playerGeneration && !playerReady) playerNotice("The player is not responding. Open the original video and enter times manually, or retry the connection.", true);
    }, 18000);
    player = new YT.Player(iframe, {
      events: {
        onReady(event) {
          if (generation !== playerGeneration) return;
          clearTimeout(readyTimer);
          player = event.target;
          setPlayerReady(true);
          playerNotice();
          updatePlayer();
          const title = player.getVideoData?.()?.title;
          if (typeof title === "string" && title && video.title === `YouTube · ${video.video_id}`) {
            video.title = title.slice(0, 500);
            $("video-title").value = video.title;
            updateVideoMetadata(video);
            persistProject();
          }
        },
        onStateChange(event) {
          if (generation !== playerGeneration) return;
          updatePlayButton(event.data === YT.PlayerState.PLAYING);
          if (preview && (event.data === YT.PlayerState.ENDED || (event.data === YT.PlayerState.PAUSED && player.getCurrentTime() >= preview.end - 0.1))) {
            preview = null;
            $("player-footnote").textContent = "Clip preview finished · Ready for your next annotation";
          }
          updatePlayer();
        },
        onPlaybackRateChange(event) { if (generation === playerGeneration) $("playback-rate").value = String(event.data); },
        onAutoplayBlocked() {
          if (generation === playerGeneration) playerNotice("Your browser blocked autoplay. Click Play inside the video before previewing a clip.");
        },
        onError(event) {
          if (generation !== playerGeneration) return;
          clearTimeout(readyTimer);
          preview = null;
          setPlayerReady(false);
          const errors = {
            2: "YouTube could not recognize this video link.",
            5: "This browser could not play the video. Try another browser.",
            100: "This video is unavailable, deleted, or private.",
            101: "The owner does not allow embedded playback. Use Original video to watch it.",
            150: "The owner does not allow embedded playback. Use Original video to watch it.",
            153: "YouTube could not verify the player origin. Check Referer blockers or try another browser.",
          };
          playerNotice(`${errors[event.data] || `YouTube playback error (${event.data}).`} You can still enter times and export annotations.`, true);
        },
      },
    });
  } catch (error) {
    clearTimeout(readyTimer);
    if (generation === playerGeneration) playerNotice(error.message, true);
  }
}

function updatePlayButton(playing) {
  $("play-toggle").classList.toggle("playing", playing);
  $("play-toggle").setAttribute("aria-label", playing ? "Pause" : "Play");
  $("play-toggle").replaceChildren(icon(playing ? "pause" : "play"));
}

let lastDurationSave = 0;
function reconcileDuration(video) {
  if (!video || !mediaDuration) return false;
  // An external duration must never make existing annotations invalid on reload.
  const inBounds = video.clips.every((clip) => clip.end_seconds <= mediaDuration);
  const duration = inBounds ? mediaDuration : null;
  if (!inBounds) playerNotice("Some saved clips exceed the duration reported by YouTube. Please review them; their annotations have been preserved.");
  if (video.duration_seconds === duration) return false;
  video.duration_seconds = duration;
  return true;
}

function updatePlayer() {
  if (!playerReady || !player) return;
  const current = player.getCurrentTime?.();
  const duration = player.getDuration?.();
  if (!Number.isFinite(current) || current < 0) return;
  const video = currentVideo();
  if (Number.isFinite(duration) && duration > 0 && Math.abs(duration - mediaDuration) > 0.001) {
    mediaDuration = Math.round(duration * 1000) / 1000;
    $("video-duration").textContent = formatTime(mediaDuration);
    $("seek-range").max = String(mediaDuration);
    $("seek-range").disabled = false;
    renderTimeline();
    updateSelectionDuration();
  }
  // Retry independently of display updates, including after a rapid video switch.
  if (Date.now() - lastDurationSave > 3000) {
    lastDurationSave = Date.now();
    if (reconcileDuration(video)) { persistProject(); updateVideoMetadata(video); }
  }
  $("current-time").textContent = clock(current);
  if (document.activeElement !== $("seek-range")) $("seek-range").value = String(current);
  if (mediaDuration) $("seek-range").style.background = `linear-gradient(to right, #6da995 ${Math.min(100, current / mediaDuration * 100)}%, #e9eeed 0)`;
}

function seek(time) {
  if (!playerReady) return;
  preview = null;
  playbackBounded = false;
  const bounded = Math.max(0, Math.min(knownDuration() ?? Infinity, time));
  player.seekTo(bounded, true);
  $("current-time").textContent = clock(bounded);
  $("player-footnote").textContent = "Playback needs internet · Times refer to the original video";
}

function togglePlay() {
  if (!playerReady) return;
  preview = null;
  const playing = player.getPlayerState() === 1;
  // seekTo clears a previous endSeconds bound before normal playback resumes.
  if (playbackBounded) { player.seekTo(player.getCurrentTime(), true); playbackBounded = false; }
  if (playing) player.pauseVideo();
  else player.playVideo();
}

function previewInterval(start, end) {
  if (!playerReady) return showToast("The player is not ready. Manual annotation is still available.", true);
  preview = { start, end };
  playbackBounded = true;
  // Let YouTube enforce the endpoint even when background timers are throttled.
  player.loadVideoById({ videoId: currentVideo().video_id, startSeconds: start, endSeconds: end });
  $("player-footnote").textContent = `Previewing ${clock(start)} – ${clock(end)}`;
}

function captureTime(id) {
  if (!playerReady) return;
  const value = player.getCurrentTime();
  if (!Number.isFinite(value) || value < 0) return;
  $(id).value = clock(value);
  rememberDraft();
  updateSelectionDuration();
  fieldError("clip-error");
}

function draftClip() {
  return createClip({
    start_seconds: parseTime($("clip-start").value), end_seconds: parseTime($("clip-end").value),
    note: $("clip-note").value, tags: splitTags($("clip-tags").value),
  }, knownDuration());
}

function updateSelectionDuration() {
  try {
    const start = parseTime($("clip-start").value);
    const end = parseTime($("clip-end").value);
    if (end <= start || (knownDuration() && end > knownDuration())) throw new Error("invalid interval");
    $("selection-duration").textContent = `${(end - start).toFixed(3)} s`;
    $("preview-draft").disabled = !playerReady;
  } catch {
    $("selection-duration").textContent = $("clip-start").value && $("clip-end").value ? "Check the range" : "Select a range";
    $("preview-draft").disabled = true;
  }
}

function saveClip(event) {
  event?.preventDefault();
  const video = currentVideo();
  if (!video) return;
  try {
    const clip = draftClip();
    const existing = video.clips.findIndex((item) => item.id === editingId);
    if (existing < 0 && (video.clips.length >= LIMITS.clipsPerVideo || project.videos.reduce((sum, item) => sum + item.clips.length, 0) >= LIMITS.totalClips)) {
      throw new Error("This batch has reached the clip limit. Export it before starting another batch.");
    }
    if (existing >= 0) video.clips[existing] = { ...clip, id: editingId, created_at: video.clips[existing].created_at };
    else video.clips.push(clip);
    reconcileDuration(video);
    persistProject();
    resetDraft();
    $("clips-search").value = "";
    renderVideos();
    renderClips();
    renderStats();
    const savedId = existing >= 0 ? video.clips[existing].id : clip.id;
    $("clips-body").querySelector(`[data-clip-id="${savedId}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    showToast(existing >= 0 ? "Clip changes saved" : "Clip added to the list");
  } catch (error) { fieldError("clip-error", error.message); }
}

function confirmAction(title, message, acceptLabel) {
  const dialog = $("confirm-dialog");
  if (dialog.open) return Promise.resolve(false);
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
  $("confirm-accept").textContent = acceptLabel;
  return new Promise((resolve) => {
    let accepted = false;
    $("confirm-accept").onclick = () => { accepted = true; dialog.close(); };
    $("confirm-cancel").onclick = () => dialog.close();
    dialog.addEventListener("close", () => resolve(accepted), { once: true });
    dialog.showModal();
    $("confirm-cancel").focus();
  });
}

async function editClip(clip) {
  if (clip.id === editingId) return;
  const video = currentVideo();
  if (isDirtyDraft(currentDraft(), video) && !await confirmAction("Edit this clip?", "This will replace the unfinished draft in the editor. Your saved clips will not change.", "Start editing")) return;
  drafts[activeId] = { start: clock(clip.start_seconds), end: clock(clip.end_seconds), note: clip.note, tags: clip.tags.join(", "), editing_id: clip.id };
  restoreDraft();
  persistWorkspace();
  renderClips();
  $("clip-start").focus();
}

async function deleteClip(clip) {
  const video = currentVideo();
  if (!await confirmAction("Delete this annotation?", `${clock(clip.start_seconds)} → ${clock(clip.end_seconds)}\nOnly this annotation will be deleted. The original video and previously exported files will not change.`, "Delete clip")) return;
  video.clips = video.clips.filter((item) => item.id !== clip.id);
  if (editingId === clip.id) resetDraft();
  persistProject();
  renderVideos();
  renderClips();
  renderStats();
  showToast("Clip deleted");
}

function downloadJson(content, filename) {
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportProject() {
  rememberDraft();
  const pending = project.videos.some((video) => isDirtyDraft(drafts[video.id], video));
  if (pending && !await confirmAction("You have unfinished clip drafts", "Exports contain saved clips only. Cancel to save your draft first, or continue with the annotations already saved.", "Export saved clips")) return;
  try {
    const data = { ...validateProject(project), exported_at: new Date().toISOString() };
    const clean = (value) => value.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    const filename = [clean(project.project_name) || "omnitalk", clean(project.annotator.id), new Date().toISOString().slice(0, 10)].filter(Boolean).join("_");
    latestExport = { content: `${JSON.stringify(data, null, 2)}\n`, filename: `${filename}.json`, path: null };
    $("export-button").disabled = true;
    $("export-path-container").hidden = true;
    $("export-feedback").textContent = isStaticMode
      ? "JSON prepared. Your browser handles the download location. If no file appears, use Download a copy or Copy JSON."
      : "Saving annotations through the local server…";
    $("export-feedback").classList.remove("error");
    $("export-dialog").showModal();
    try {
      if (isStaticMode) {
        downloadJson(latestExport.content, latestExport.filename);
        return;
      }
      const response = await fetch("/api/exports", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: latestExport.content,
        signal: AbortSignal.timeout(30000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The local server could not save the file.");
      latestExport.path = result.path;
      $("export-path").value = result.path;
      $("export-path-container").hidden = false;
      $("export-feedback").textContent = "JSON saved on your computer. The file is ready to share.";
      memoryNeedsBackup = pending;
    } catch (error) {
      $("export-feedback").classList.add("error");
      $("export-feedback").textContent = `Local save failed: ${error.message}. Your data is still here. Copy JSON, or download a copy in a browser that allows file downloads.`;
    } finally { $("export-button").disabled = !project.videos.length; }
  } catch (error) { showToast(`Export failed: ${error.message}`, true); }
}

async function importProject(file) {
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024 && !await confirmAction("Import a large JSON file?", "This file is larger than 20 MB and may take a while to read. Your current workspace will not change until validation succeeds and you confirm replacement.", "Read file")) return;
    const imported = validateProject(JSON.parse((await file.text()).replace(/^\uFEFF/, "")));
    rememberDraft(false);
    if ((project.videos.length || Object.keys(drafts).length) && !await confirmAction("Replace the current workspace?", `Import “${imported.project_name || "Untitled project"}” with ${imported.videos.length} videos?\nThis replaces the current workspace and its unfinished drafts. Cancel and export first if you need to keep them.`, "Import and replace")) return;
    project = imported;
    activeId = imported.videos[0]?.id ?? null;
    drafts = {};
    mediaDuration = 0;
    $("clips-search").value = "";
    renderProfile();
    renderCurrentVideo();
    persistProject(false);
    persistWorkspace();
    if (currentVideo()) loadPlayer(currentVideo());
    else clearPlayer();
    showToast("JSON imported. Ready to continue annotating.");
  } catch (error) { showToast(`Import failed: ${error.message}`, true); }
  finally { $("import-file").value = ""; }
}

function renderProfile() {
  $("project-name").value = project.project_name;
  $("annotator-id").value = project.annotator.id;
  $("annotator-name").value = project.annotator.name;
  $("participant-avatar").textContent = [...(project.annotator.name || project.annotator.id || "A")][0].toLocaleUpperCase();
}

$("sidebar-toggle").addEventListener("click", () => setSidebarCollapsed(!sidebarCollapsed));
$("source-form").addEventListener("submit", (event) => { event.preventDefault(); addVideo($("source-url").value); });
$("load-example").addEventListener("click", () => addVideo("https://www.youtube.com/watch?v=M7lc1UVf-VE"));
$("add-video-focus").addEventListener("click", () => $("source-url").focus());
$("retry-player").addEventListener("click", () => { if (currentVideo()) loadPlayer(currentVideo()); });
$("play-toggle").addEventListener("click", togglePlay);
$("seek-back").addEventListener("click", () => seek(player.getCurrentTime() - 5));
$("seek-forward").addEventListener("click", () => seek(player.getCurrentTime() + 5));
$("seek-range").addEventListener("input", () => seek(Number($("seek-range").value)));
$("playback-rate").addEventListener("change", () => { if (playerReady) player.setPlaybackRate(Number($("playback-rate").value)); });
$("capture-start").addEventListener("click", () => captureTime("clip-start"));
$("capture-end").addEventListener("click", () => captureTime("clip-end"));
$("preview-draft").addEventListener("click", () => {
  try { const clip = draftClip(); previewInterval(clip.start_seconds, clip.end_seconds); }
  catch (error) { fieldError("clip-error", error.message); }
});
$("clip-form").addEventListener("submit", saveClip);
for (const id of draftFields) $(id).addEventListener("input", () => { rememberDraft(); updateSelectionDuration(); fieldError("clip-error"); });
$("cancel-edit").addEventListener("click", async () => {
  if (isDirtyDraft(currentDraft(), currentVideo()) && !await confirmAction("Discard these changes?", "Your saved clip will be kept. Only the unfinished edits will be discarded.", "Discard changes")) return;
  resetDraft(); renderClips();
});
$("clips-search").addEventListener("input", renderClips);
$("download-all-clips").addEventListener("click", () => downloadUI?.openAll());
$("project-name").addEventListener("input", () => { project.project_name = $("project-name").value; persistProject(); });
for (const field of ["id", "name"]) $("annotator-" + field).addEventListener("input", () => {
  project.annotator[field] = $("annotator-" + field).value;
  $("participant-avatar").textContent = [...(project.annotator.name || project.annotator.id || "A")][0].toLocaleUpperCase();
  persistProject();
});
$("video-title").addEventListener("input", () => {
  if (!currentVideo()) return;
  currentVideo().title = $("video-title").value;
  persistProject(); renderVideos();
});
$("export-button").addEventListener("click", exportProject);
$("import-button").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", () => importProject($("import-file").files[0]));
$("recover-storage").addEventListener("click", () => downloadJson(recoveryText, "omnitalk-recovered-draft.json"));
for (const id of ["close-export", "done-export"]) $(id).addEventListener("click", () => $("export-dialog").close());
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); showToast("Copied to clipboard"); }
  catch { showToast("Clipboard access is unavailable. Select and copy the saved path manually.", true); }
}
$("copy-export-path").addEventListener("click", () => { if (latestExport?.path) copyText(latestExport.path); });
$("copy-export-json").addEventListener("click", () => { if (latestExport) copyText(latestExport.content); });
$("download-export-copy").addEventListener("click", () => { if (latestExport) downloadJson(latestExport.content, latestExport.filename); });
for (const id of ["help-button", "keyboard-help"]) $(id).addEventListener("click", () => $("help-dialog").showModal());
$("close-help").addEventListener("click", () => $("help-dialog").close());

document.addEventListener("keydown", (event) => {
  if (event.isComposing || event.repeat || document.querySelector("dialog[open]")) return;
  const typing = event.target.matches("input, textarea, select, [contenteditable=true]");
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    if (!typing || $("clip-form").contains(event.target)) { event.preventDefault(); saveClip(); }
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key.toLowerCase() === "i") { event.preventDefault(); captureTime("clip-start"); }
  if (event.key.toLowerCase() === "o") { event.preventDefault(); captureTime("clip-end"); }
  if (event.code === "Space" && !event.target.closest("button,a")) { event.preventDefault(); togglePlay(); }
  if (event.key === "?") $("help-dialog").showModal();
});

window.addEventListener("storage", (event) => {
  if ((event.key === STORAGE_KEY || event.key === WORKSPACE_KEY || event.key === null) && !storageBlocked) {
    storageBlocked = true;
    memoryNeedsBackup = true;
    storageWarning("Another tab changed the local data. Autosave is paused. Export your annotations, then reload to avoid overwriting each other.");
  }
});
window.addEventListener("beforeunload", (event) => {
  if (memoryNeedsBackup) { event.preventDefault(); event.returnValue = ""; }
});

restoreSidebarPreference();
restoreStorage();
if (isStaticMode) {
  $("browser-demo-notice").hidden = false;
  const modeLabel = document.querySelector(".local-pill");
  if (modeLabel) modeLabel.textContent = "BROWSER";
  const exportHelp = document.querySelector(".help-steps li:last-child p");
  if (exportHelp) exportHelp.textContent = "Export JSON downloads your saved annotations through the browser. Import the file to continue here or in the local app. Browser and local workspaces have separate storage.";
}
renderProfile();
downloadUI = initDownloads({
  getVideo: currentVideo,
  getClips: sortedClips,
  getRange: () => {
    try { const clip = draftClip(); return { start_seconds: clip.start_seconds, end_seconds: clip.end_seconds }; }
    catch { return null; }
  },
});
renderCurrentVideo();
if (currentVideo()) loadPlayer(currentVideo());
setInterval(updatePlayer, 100);
