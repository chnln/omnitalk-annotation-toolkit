/** Pure annotation data helpers. No network, storage, or DOM access. */
export const SCHEMA_VERSION = "1.2";
const LEGACY_VERSIONS = ["1.0", "1.1"];
export const STORAGE_KEY = "omnitalk.annotation.project.v1";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YOUTUBE_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
  "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com",
]);
export const LIMITS = { videos: 1000, clipsPerVideo: 10000, totalClips: 50000, tags: 50 };
const now = () => new Date().toISOString();
const uuid = () => globalThis.crypto.randomUUID();

function seconds(value, label = "Time") {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 1000) {
    throw new Error(`${label} must be a finite number of seconds greater than or equal to 0.`);
  }
  return Math.round(value * 1000) / 1000;
}

/** Accept seconds, mm:ss[.mmm], or hh:mm:ss[.mmm]. */
export function parseTime(input) {
  if (typeof input === "number") return seconds(input);
  if (typeof input !== "string" || !input.trim()) throw new Error("Enter a time, such as 72.5, 01:12.500, or 01:02:03.");
  const value = input.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) return seconds(Number(value));
  if (!/^\d+:\d{2}(?::\d{2})?(?:\.\d{1,3})?$/.test(value)) {
    throw new Error("Use seconds, mm:ss, or hh:mm:ss, with up to three decimal places in clock notation.");
  }
  const parts = value.split(":").map(Number);
  if (parts.at(-1) >= 60 || (parts.length === 3 && parts[1] >= 60)) {
    throw new Error("Seconds must be below 60; minutes in hh:mm:ss must also be below 60.");
  }
  return seconds(parts.reduce((total, part) => total * 60 + part, 0));
}

export function formatTime(value, { milliseconds = false } = {}) {
  const ticks = Math.round(seconds(value) * 1000);
  const whole = Math.floor(ticks / 1000);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const secs = whole % 60;
  const pad = (n) => String(n).padStart(2, "0");
  const clock = hours ? `${pad(hours)}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
  return milliseconds ? `${clock}.${String(ticks % 1000).padStart(3, "0")}` : clock;
}

function parseLinkTime(value) {
  if (value === null) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value)) return seconds(Number(value), "Link start time");
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i.exec(value);
  if (!match || !match.slice(1).some((part) => part !== undefined)) {
    throw new Error("Invalid start time in the YouTube link. Use t=90 or t=1m30s, for example.");
  }
  return seconds(Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0), "Link start time");
}

export function parseYouTubeUrl(input) {
  if (typeof input !== "string" || input.length > 2048) throw new Error("Enter a valid YouTube link or an 11-character video ID.");
  let value = input.trim();
  if (VIDEO_ID.test(value)) return { video_id: value, url: `https://www.youtube.com/watch?v=${value}`, start_seconds: 0 };
  if (/^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(value)) value = `https://${value}`;
  let link;
  try { link = new URL(value); } catch { throw new Error("Invalid link. Paste a YouTube video URL."); }
  if (!YOUTUBE_HOSTS.has(link.hostname) || !["http:", "https:"].includes(link.protocol) || link.username || link.password || link.port) {
    throw new Error("Only HTTP or HTTPS video links on official YouTube domains are supported.");
  }
  const path = link.pathname.split("/").filter(Boolean);
  const shortHost = link.hostname === "youtu.be" || link.hostname === "www.youtu.be";
  let videoId;
  if (shortHost && path.length === 1) videoId = path[0];
  else if (!shortHost && path.length === 1 && path[0] === "watch") videoId = link.searchParams.get("v");
  else if (!shortHost && path.length === 2 && ["shorts", "embed", "live"].includes(path[0])) videoId = path[1];
  if (!VIDEO_ID.test(videoId || "")) throw new Error("No valid YouTube video ID found. Use a video link, not a channel or playlist link.");
  const fragment = new URLSearchParams(link.hash.slice(1));
  const time = link.searchParams.get("t") ?? link.searchParams.get("start") ?? fragment.get("t") ?? fragment.get("start");
  return { video_id: videoId, url: `https://www.youtube.com/watch?v=${videoId}`, start_seconds: parseLinkTime(time) };
}

export function createProject() {
  const timestamp = now();
  return {
    schema_version: SCHEMA_VERSION,
    project_id: uuid(),
    project_name: "OmniTalk corpus",
    annotator: { id: "", name: "" },
    created_at: timestamp,
    updated_at: timestamp,
    videos: [],
  };
}

export function createVideo(parsed) {
  object(parsed, "Video source");
  const source = parseYouTubeUrl(parsed.url);
  if (source.video_id !== parsed.video_id) throw new Error("The video ID does not match the link.");
  return {
    id: uuid(), source: "youtube", video_id: source.video_id, url: source.url,
    title: `YouTube · ${source.video_id}`, duration_seconds: null, created_at: now(), clips: [],
  };
}

function text(value, label, max, allowEmpty = true) {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} must be ${allowEmpty ? "text" : "nonempty text"} with at most ${max} characters.`);
  }
  return value;
}

function tags(value) {
  if (!Array.isArray(value) || value.length > LIMITS.tags) throw new Error(`Tags must be an array with at most ${LIMITS.tags} entries.`);
  return value.map((tag) => text(tag, "Tag", 100, false));
}

function clipFields({ start_seconds, end_seconds, note = "", tags: clipTags = [] }, duration) {
  const start = seconds(start_seconds, "Clip start");
  const end = seconds(end_seconds, "Clip end");
  if (end <= start) throw new Error("The clip must end at least 1 millisecond after its start.");
  if (duration !== null && end > seconds(duration, "Video duration")) throw new Error("The clip end cannot exceed the video duration.");
  return { start_seconds: start, end_seconds: end, note: text(note, "Note", 20000), tags: tags(clipTags) };
}

/** Clips keep a copy of the annotator who created them; later profile edits do not rewrite authorship. */
const annotatorCopy = (annotator = {}) => ({ id: annotator.id ?? "", name: annotator.name ?? "" });

function annotatorRecord(value, label) {
  object(value, label);
  return { id: text(value.id, `${label} ID`, 200), name: text(value.name, `${label} name`, 200) };
}

/** Display label: "Name (ID)", either part alone, or "" when unattributed. */
export function annotatorLabel(annotator) {
  const name = annotator?.name?.trim() ?? "";
  const id = annotator?.id?.trim() ?? "";
  return name && id ? `${name} (${id})` : name || id;
}

export function createClip(input, duration_seconds = null, annotator = {}) {
  object(input, "Clip");
  const fields = clipFields(input, duration_seconds);
  const timestamp = now();
  return { id: uuid(), ...fields, annotator: annotatorCopy(annotator), subtitle_status: "unknown", questions: [], created_at: timestamp, updated_at: timestamp };
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
}

function timestamp(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a valid ISO date and time.`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error(`${label} must be a valid ISO date and time.`);
  const [, year, month, day, hour, minute, second, zone] = match;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const invalidZone = zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59);
  if (+month < 1 || +month > 12 || +day < 1 || +day > days[+month - 1] || +hour > 23 || +minute > 59 || +second > 59 || invalidZone || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} contains an invalid date or time.`);
  }
  return new Date(value).toISOString();
}

/** Validate untrusted JSON and return only the supported schema, with fresh objects. */
export function validateProject(data) {
  object(data, "Project");
  if (![...LEGACY_VERSIONS, SCHEMA_VERSION].includes(data.schema_version)) throw new Error(`Unsupported file version. Expected schema_version: "${SCHEMA_VERSION}".`);
  const ids = new Set();
  function recordId(value, label) {
    if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${label} must be a valid UUID.`);
    const normalized = value.toLowerCase();
    if (ids.has(normalized)) throw new Error("The file contains duplicate project, video, or clip IDs.");
    ids.add(normalized);
    return normalized;
  }
  object(data.annotator, "Annotator");
  if (!Array.isArray(data.videos) || data.videos.length > LIMITS.videos) throw new Error(`videos must be an array with at most ${LIMITS.videos} videos.`);
  const project = {
    schema_version: SCHEMA_VERSION,
    project_id: recordId(data.project_id, "Project ID"),
    project_name: text(data.project_name, "Project name", 200),
    annotator: { id: text(data.annotator.id, "Annotator ID", 200), name: text(data.annotator.name, "Annotator name", 200) },
    created_at: timestamp(data.created_at, "Project creation time"),
    updated_at: timestamp(data.updated_at, "Project update time"),
    videos: [],
  };
  if (data.exported_at !== undefined) timestamp(data.exported_at, "Export time");
  // Before 1.2 only the project had an annotator, so it is the best available author for older clips.
  const legacyAuthor = data.schema_version === SCHEMA_VERSION ? null : project.annotator;
  let totalClips = 0;
  project.videos = data.videos.map((video) => {
    object(video, "Video");
    if (video.source !== "youtube") throw new Error("Video source must be youtube.");
    if (typeof video.url !== "string" || !/^https?:\/\//i.test(video.url)) throw new Error("The video URL must be a full YouTube HTTP or HTTPS link.");
    const parsed = parseYouTubeUrl(video.url);
    if (typeof video.video_id !== "string" || !VIDEO_ID.test(video.video_id) || video.video_id !== parsed.video_id) throw new Error("The video ID is invalid or does not match the link.");
    if (video.duration_seconds !== null && (typeof video.duration_seconds !== "number" || !Number.isFinite(video.duration_seconds) || video.duration_seconds <= 0)) throw new Error("Video duration must be greater than 0 seconds, or null if unknown.");
    const duration = video.duration_seconds === null ? null : seconds(video.duration_seconds, "Video duration");
    if (duration === 0) throw new Error("Video duration must be at least 1 millisecond.");
    if (!Array.isArray(video.clips) || video.clips.length > LIMITS.clipsPerVideo) throw new Error(`clips must be an array with at most ${LIMITS.clipsPerVideo} clips per video.`);
    totalClips += video.clips.length;
    if (totalClips > LIMITS.totalClips) throw new Error(`A project can contain at most ${LIMITS.totalClips} clips.`);
    return {
      id: recordId(video.id, "Video record ID"),
      source: "youtube", video_id: parsed.video_id, url: parsed.url,
      title: text(video.title, "Video title", 500),
      duration_seconds: duration,
      created_at: timestamp(video.created_at, "Video creation time"),
      clips: video.clips.map((clip) => {
        object(clip, "Clip");
        if (clip.note === undefined || clip.tags === undefined) throw new Error("Each clip must contain note text and a tags array.");
        return {
          id: recordId(clip.id, "Clip ID"),
          ...clipFields(clip, duration),
          annotator: legacyAuthor ? annotatorCopy(legacyAuthor) : annotatorRecord(clip.annotator, "Clip annotator"),
          ...validateClipQA(clip, data.schema_version, recordId),
          created_at: timestamp(clip.created_at, "Clip creation time"),
          updated_at: timestamp(clip.updated_at, "Clip update time"),
        };
      }),
    };
  });
  return project;
}


/** Evidence taxonomy: broad sources first, optional specific cues second. */
export const MODALITIES = {
  audio: { label: "Audio", cues: { speech_content: "Speech content", prosody: "Prosody", environmental_sounds: "Environmental sounds" } },
  visual: { label: "Visual", cues: { action_event: "Action / Event", gesture: "Gesture", facial_expression: "Facial expression", gaze: "Gaze", person_appearance: "Person / Appearance", object_scene: "Object / Scene" } },
  text: { label: "Text", cues: { subtitles: "Subtitles", scene_text: "Scene text" } },
};
export const SUBTITLE_STATUSES = { unknown: "Not reviewed", none: "No subtitles", present: "With subtitles", masked: "Subtitle masked" };
export function createQuestion() {
  const time = now();
  return { id: uuid(), prompt: "", options: [0, 1, 2].map(() => ({ id: uuid(), text: "" })), correct_option_id: null,
    required_modalities: [], evidence_cues: [], rationale: "", status: "draft", created_at: time, updated_at: time };
}
export function questionReadyError(q) {
  if (!q.prompt.trim()) return "Enter a question before marking it Ready.";
  if (q.options.length < 2 || q.options.some(o => !o.text.trim())) return "Ready questions need at least two nonempty answer options.";
  if (!q.options.some(o => o.id === q.correct_option_id)) return "Select the correct answer.";
  if (!q.required_modalities.length) return "Select at least one required modality. Audio-only integration is allowed.";
  return "";
}
export function validateQuestion(q, recordId = (value) => {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Question and option IDs must be UUIDs.");
  return value.toLowerCase();
}) {
  object(q, "Question");
  if (!["draft", "ready"].includes(q.status)) throw new Error("Question status must be draft or ready.");
  if (!Array.isArray(q.options) || q.options.length > 26) throw new Error("A question supports up to 26 options.");
  const id = recordId(q.id, "Question ID");
  const options = q.options.map(o => { object(o, "Option"); return { id: recordId(o.id, "Option ID"), text: text(o.text, "Option", 5000) }; });
  if (new Set(options.map(o => o.id)).size !== options.length) throw new Error("Duplicate option IDs.");
  const correct = q.correct_option_id === null ? null : typeof q.correct_option_id === "string" ? q.correct_option_id.toLowerCase() : undefined;
  if (correct !== null && !options.some(o => o.id === correct)) throw new Error("Correct answer must reference an existing option.");
  const selection = (value, allowed, label) => {
    if (!Array.isArray(value) || value.length > allowed.length || new Set(value).size !== value.length || value.some(v => !allowed.includes(v))) throw new Error(`Invalid ${label}.`);
    return [...value];
  };
  const modalities = selection(q.required_modalities, Object.keys(MODALITIES), "required modalities");
  const cues = selection(q.evidence_cues, modalities.flatMap(m => Object.keys(MODALITIES[m].cues)), "evidence cues or parent modality");
  const result = { id, prompt: text(q.prompt, "Question", 10000), options, correct_option_id: correct,
    required_modalities: modalities, evidence_cues: cues, rationale: text(q.rationale, "Rationale", 20000), status: q.status,
    created_at: timestamp(q.created_at, "Question creation time"), updated_at: timestamp(q.updated_at, "Question update time") };
  const error = questionReadyError(result);
  if (result.status === "ready" && error) throw new Error(error);
  return result;
}
function validateClipQA(clip, version, recordId) {
  if (version === "1.0") return { subtitle_status: "unknown", questions: [] };
  if (!Object.hasOwn(SUBTITLE_STATUSES, clip.subtitle_status)) throw new Error("Invalid clip subtitle status.");
  if (!Array.isArray(clip.questions) || clip.questions.length > 100) throw new Error("A clip supports up to 100 questions.");
  return { subtitle_status: clip.subtitle_status, questions: clip.questions.map(q => validateQuestion(q, recordId)) };
}

/* Library filters: pure helpers so the sidebar and tests share one definition. */
const annotatorKey = (annotator) => JSON.stringify([annotator?.id ?? "", annotator?.name ?? ""]);

/** Distinct clip annotators (video collectors), sorted by label; unattributed clips get label "". */
export function projectAnnotators(videos) {
  const found = new Map();
  for (const video of videos) {
    for (const clip of video.clips) found.set(annotatorKey(clip.annotator), annotatorLabel(clip.annotator));
  }
  return [...found].map(([key, label]) => ({ key, label }))
    .sort((a, b) => (a.label === "") - (b.label === "") || a.label.localeCompare(b.label));
}

export function projectTags(videos) {
  return [...new Set(videos.flatMap((video) => video.clips.flatMap((clip) => clip.tags)))].sort((a, b) => a.localeCompare(b));
}

export const QUESTION_STATUS_FILTERS = {
  "has-drafts": "Has Draft questions",
  "all-ready": "All questions Ready",
  "missing-questions": "Clips without questions",
  "no-clips": "No clips yet",
};

/** Keep videos matching every active filter: text, annotator key, clip tag, and question status. */
export function filterVideos(videos, { query = "", annotator = "", tag = "", status = "" } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return videos.filter((video) => {
    if (needle && !`${video.title} ${video.video_id}`.toLocaleLowerCase().includes(needle)) return false;
    if (annotator && !video.clips.some((clip) => annotatorKey(clip.annotator) === annotator)) return false;
    if (tag && !video.clips.some((clip) => clip.tags.includes(tag))) return false;
    const questions = video.clips.flatMap((clip) => clip.questions);
    if (status === "has-drafts") return questions.some((q) => q.status === "draft");
    if (status === "all-ready") return questions.length > 0 && questions.every((q) => q.status === "ready");
    if (status === "missing-questions") return video.clips.some((clip) => !clip.questions.length);
    if (status === "no-clips") return !video.clips.length;
    return true;
  });
}
