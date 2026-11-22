/**
 * OmniTalk QA submission files (JSONL): the format specification, parser, validator and exporter used by the
 * Browse view. Pure helpers: no network, storage, or DOM access. FIELDS, RULES and CHANGELOG are the single
 * source of truth: the Format tab renders them, the validator cites them, and a test checks JSONL_FORMAT.md
 * against them.
 */
import { SCENARIOS, parseYouTubeUrl } from "./core.js";

export const FORMAT_VERSION = "1.0";
export const CHANGELOG = [
  { version: "1.0", date: "2026-11-22", changes: ["First documented version: ten required fields, one question per line, the 12 scenario categories."] },
];

/** The team's scenario category names, as written in the JSONL `scenario` field (core.js keeps their IDs). */
export const SCENARIO_NAMES = Object.values(SCENARIOS);

export const FIELDS = [
  { name: "video_clip_id", type: "string", constraint: "Non-empty, one line. Names the clip; the clip file is <video_clip_id>.mp4.", example: "Demo-001" },
  { name: "url", type: "string", constraint: "YouTube watch URL of the original video: https://www.youtube.com/watch?v=VIDEO_ID.", example: "https://www.youtube.com/watch?v=M7lc1UVf-VE" },
  { name: "start_time", type: "string", constraint: "HH:MM:SS.mmm, time in the original video where the clip starts.", example: "00:01:58.000" },
  { name: "end_time", type: "string", constraint: "HH:MM:SS.mmm, later than start_time.", example: "00:02:32.000" },
  { name: "duration", type: "number", constraint: "Seconds, equal to end_time − start_time to the millisecond, e.g. 34.0.", example: "34.0" },
  { name: "question_id", type: "string", constraint: "Unique in the file; usually <video_clip_id>_Q<n>.", example: "Demo-001_Q1" },
  { name: "scenario", type: "array of strings", constraint: "1 or 2 distinct scenario category names (list below).", example: "[\"Food & Dining\"]" },
  { name: "question", type: "string", constraint: "Non-empty question text.", example: "What does the man point at?" },
  { name: "choices", type: "object", constraint: "Letters A, B, C… in order mapped to non-empty text; usually 4, sometimes 3 or 5 (2 to 26).", example: "{\"A\": \"…\", \"B\": \"…\", \"C\": \"…\", \"D\": \"…\"}" },
  { name: "correct_answer", type: "string", constraint: "One letter that is a key of choices.", example: "B" },
];
export const FIELD_NAMES = FIELDS.map((field) => field.name);

/** Validation rules in the order the Format tab lists them. `level` is "error" or "warning". */
export const RULES = [
  { id: "json", level: "error", text: "Each non-blank line is one JSON object." },
  { id: "required", level: "error", text: "All ten fields are present with the listed types." },
  { id: "clip_id", level: "error", text: "video_clip_id is non-empty text on one line." },
  { id: "url", level: "error", text: "url is a YouTube link with a valid video ID." },
  { id: "url_form", level: "warning", text: "url uses the watch form https://www.youtube.com/watch?v=VIDEO_ID, without extra parameters." },
  { id: "time_format", level: "error", text: "start_time and end_time use HH:MM:SS.mmm, with minutes and seconds below 60." },
  { id: "time_order", level: "error", text: "end_time is later than start_time." },
  { id: "duration", level: "error", text: "duration is a number equal to end_time − start_time, to the millisecond." },
  { id: "question_id", level: "error", text: "question_id is non-empty and unique in the file." },
  { id: "question_id_form", level: "warning", text: "question_id has the form <video_clip_id>_Q<n>." },
  { id: "scenario", level: "error", text: "scenario lists 1 or 2 distinct names from the scenario categories." },
  { id: "question", level: "error", text: "question is non-empty text." },
  { id: "choices", level: "error", text: "choices has 2 to 26 keys A, B, C… in order, each with non-empty text." },
  { id: "choices_distinct", level: "warning", text: "No two choices have the same text." },
  { id: "answer", level: "error", text: "correct_answer is one of the letters in choices." },
  { id: "clip_consistent", level: "warning", text: "Lines with the same video_clip_id have the same url, start_time, end_time and duration." },
];
const RULE = Object.fromEntries(RULES.map((rule) => [rule.id, rule]));

/** Other notes the Format tab shows beside the rules; they describe how files are read and written. */
export const FILE_NOTES = [
  "UTF-8 text, one JSON object per line. A byte order mark is ignored; blank lines are skipped and reported.",
  "Keys keep their order. Keys not listed above are allowed and kept unchanged.",
  "Times are in the original YouTube video, not in the cut clip.",
  "Several questions about one clip are separate lines with the same video_clip_id and different question_id.",
];

export const EXAMPLE_LINE = "{\"video_clip_id\": \"Demo-001\", \"url\": \"https://www.youtube.com/watch?v=M7lc1UVf-VE\", \"start_time\": \"00:00:10.000\", \"end_time\": \"00:00:44.000\", \"duration\": 34.0, \"question_id\": \"Demo-001_Q1\", \"scenario\": [\"Food & Dining\"], \"question\": \"Which person orders the soup?\", \"choices\": {\"A\": \"The man in the grey coat\", \"B\": \"The woman by the window\", \"C\": \"The waiter\", \"D\": \"Nobody orders soup\"}, \"correct_answer\": \"B\"}";

const CLOCK = /^(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})$/;

/** "HH:MM:SS.mmm" to integer milliseconds, or null when the text does not follow the format. */
export function parseClock(value) {
  const match = typeof value === "string" ? CLOCK.exec(value) : null;
  if (!match) return null;
  const [h, m, s, ms] = match.slice(1).map(Number);
  return ((h * 60 + m) * 60 + s) * 1000 + ms;
}

export function formatClock(milliseconds) {
  const ms = Math.max(0, Math.round(milliseconds));
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
const letter = (index) => String.fromCharCode(65 + index);

/** Milliseconds of `duration` (seconds), or null when it is not a finite number. */
const durationMs = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) : null);

/** end − start in seconds when both times follow the format, else null. */
export function expectedDuration(data) {
  const start = parseClock(data?.start_time);
  const end = parseClock(data?.end_time);
  return start === null || end === null ? null : (end - start) / 1000;
}

function problem(id, field, message) {
  return { rule: id, level: RULE[id].level, field, message };
}

/** Problems of one parsed line on its own (no cross-line checks). */
export function validateRecord(data) {
  if (!isObject(data)) return [problem("json", null, "The line is not a JSON object.")];
  const problems = [];
  const types = { video_clip_id: "string", url: "string", start_time: "string", end_time: "string", duration: "number", question_id: "string", scenario: "array", question: "string", choices: "object", correct_answer: "string" };
  const typeOf = (value) => (Array.isArray(value) ? "array" : value === null ? "null" : typeof value);
  const ok = {};
  for (const [field, type] of Object.entries(types)) {
    if (!Object.hasOwn(data, field)) problems.push(problem("required", field, `Missing field ${field}.`));
    else if (typeOf(data[field]) !== type) problems.push(problem("required", field, `${field} must be ${type === "array" ? "an array" : type === "object" ? "an object" : `a ${type}`}, not ${typeOf(data[field])}.`));
    else ok[field] = true;
  }
  if (ok.video_clip_id && (!nonEmpty(data.video_clip_id) || /[\r\n]/.test(data.video_clip_id))) problems.push(problem("clip_id", "video_clip_id", "video_clip_id is empty or spans several lines."));
  if (ok.url) {
    try {
      const parsed = parseYouTubeUrl(data.url);
      if (data.url !== parsed.url) problems.push(problem("url_form", "url", `Expected ${parsed.url}.`));
    } catch (error) { problems.push(problem("url", "url", error.message)); }
  }
  let start = null;
  let end = null;
  for (const field of ["start_time", "end_time"]) {
    if (!ok[field]) continue;
    const value = parseClock(data[field]);
    if (value === null) problems.push(problem("time_format", field, `${field} “${data[field]}” is not HH:MM:SS.mmm.`));
    if (field === "start_time") start = value; else end = value;
  }
  if (start !== null && end !== null && end <= start) problems.push(problem("time_order", "end_time", "end_time must be later than start_time."));
  if (ok.duration && start !== null && end !== null && end > start) {
    const ms = durationMs(data.duration);
    if (ms !== end - start) problems.push(problem("duration", "duration", `duration is ${data.duration}; end_time − start_time is ${(end - start) / 1000}.`));
  } else if (ok.duration && !Number.isFinite(data.duration)) problems.push(problem("duration", "duration", "duration must be a finite number."));
  if (ok.question_id) {
    if (!nonEmpty(data.question_id)) problems.push(problem("question_id", "question_id", "question_id is empty."));
    else if (ok.video_clip_id && !new RegExp(`^${data.video_clip_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_Q\\d+$`).test(data.question_id)) {
      problems.push(problem("question_id_form", "question_id", `Expected ${data.video_clip_id}_Q1, ${data.video_clip_id}_Q2…`));
    }
  }
  if (ok.scenario) {
    const list = data.scenario;
    const unknown = list.filter((name) => !SCENARIO_NAMES.includes(name));
    if (list.length < 1 || list.length > 2) problems.push(problem("scenario", "scenario", `scenario has ${list.length} names; use 1 or 2.`));
    if (unknown.length) problems.push(problem("scenario", "scenario", `Unknown scenario ${unknown.map((name) => JSON.stringify(name)).join(", ")}.`));
    if (new Set(list).size !== list.length) problems.push(problem("scenario", "scenario", "scenario lists the same name twice."));
  }
  if (ok.question && !nonEmpty(data.question)) problems.push(problem("question", "question", "question is empty."));
  if (ok.choices) {
    const keys = Object.keys(data.choices);
    if (keys.length < 2 || keys.length > 26) problems.push(problem("choices", "choices", `choices has ${keys.length} ${keys.length === 1 ? "entry" : "entries"}; use 2 to 26.`));
    const expected = keys.map((_, index) => letter(index));
    if (keys.join() !== expected.join()) problems.push(problem("choices", "choices", `choices keys are ${keys.join(", ") || "none"}; expected ${expected.join(", ")}.`));
    const blank = keys.filter((key) => !nonEmpty(data.choices[key]));
    if (blank.length) problems.push(problem("choices", "choices", `Choice ${blank.join(", ")} ${blank.length === 1 ? "is" : "are"} empty or not text.`));
    const texts = keys.map((key) => (typeof data.choices[key] === "string" ? data.choices[key].trim().toLowerCase() : null)).filter(Boolean);
    if (new Set(texts).size !== texts.length) problems.push(problem("choices_distinct", "choices", "Two choices have the same text."));
    if (ok.correct_answer && !keys.includes(data.correct_answer)) problems.push(problem("answer", "correct_answer", `correct_answer “${data.correct_answer}” is not one of ${keys.join(", ")}.`));
  }
  return problems;
}

/** Per-line problems including the cross-line rules, plus a file-level summary. */
export function validateDataset(lines) {
  const problems = lines.map((line) => (line.data === undefined ? [problem("json", null, line.error || "The line is not valid JSON.")] : validateRecord(line.data)));
  const byId = new Map();
  const byClip = new Map();
  lines.forEach((line, index) => {
    const data = line.data;
    if (!isObject(data)) return;
    if (nonEmpty(data.question_id)) byId.set(data.question_id, [...(byId.get(data.question_id) || []), index]);
    if (nonEmpty(data.video_clip_id)) byClip.set(data.video_clip_id, [...(byClip.get(data.video_clip_id) || []), index]);
  });
  for (const [id, indexes] of byId) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      const others = indexes.filter((other) => other !== index).map((other) => lines[other].number);
      problems[index].push(problem("question_id", "question_id", `question_id ${id} is also used on line ${others.join(", ")}.`));
    }
  }
  const clipKey = (data) => JSON.stringify(["url", "start_time", "end_time", "duration"].map((field) => data[field]));
  for (const [clip, indexes] of byClip) {
    if (indexes.length < 2) continue;
    const first = clipKey(lines[indexes[0]].data);
    if (indexes.every((index) => clipKey(lines[index].data) === first)) continue;
    for (const index of indexes) {
      problems[index].push(problem("clip_consistent", null, `Lines ${indexes.map((other) => lines[other].number).join(", ")} use ${clip} with different url, times or duration.`));
    }
  }
  const summary = { lines: lines.length, errorLines: 0, warningLines: 0, byRule: {} };
  for (const list of problems) {
    if (list.some((item) => item.level === "error")) summary.errorLines += 1;
    else if (list.length) summary.warningLines += 1;
    for (const rule of new Set(list.map((item) => item.rule))) summary.byRule[rule] = (summary.byRule[rule] || 0) + 1;
  }
  return { problems, summary };
}

/* ---------- Reading and writing lines ---------- */

/** One parsed line: `data` when it is valid JSON, otherwise `error`. */
export function parseLine(raw) {
  try {
    const data = JSON.parse(raw);
    return isObject(data) ? { data } : { data: undefined, error: "The line is JSON but not an object." };
  } catch (error) {
    return { data: undefined, error: `Not valid JSON: ${error.message}` };
  }
}

/** Read a JSONL text: every non-blank line becomes a record that keeps its original text. */
export function parseJsonl(text) {
  const bom = text.startsWith("﻿");
  const body = bom ? text.slice(1) : text;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const pieces = body.split(/\r?\n/);
  if (pieces.length && pieces.at(-1) === "") pieces.pop(); // the final newline
  const lines = [];
  const blank = [];
  const malformed = [];
  pieces.forEach((raw, index) => {
    const number = index + 1;
    if (!raw.trim()) { blank.push(number); return; }
    const parsed = parseLine(raw);
    if (parsed.data === undefined) malformed.push({ number, error: parsed.error });
    lines.push({ number, original: raw, raw, ...parsed });
  });
  return { lines, eol, bom, blank, malformed };
}

/**
 * Split a JSON object's text into its top-level members, keeping each key's and value's original text, and the
 * separator style. Returns null when the text is not a JSON object.
 */
export function scanMembers(raw) {
  let i = 0;
  const ws = () => { while (i < raw.length && " \t\r\n".includes(raw[i])) i += 1; };
  const string = () => {
    const begin = i;
    i += 1;
    while (i < raw.length && raw[i] !== "\"") i += raw[i] === "\\" ? 2 : 1;
    i += 1;
    return raw.slice(begin, i);
  };
  const value = () => {
    const begin = i;
    if (raw[i] === "\"") { string(); return raw.slice(begin, i); }
    let depth = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === "\"") { string(); continue; }
      if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") { if (depth === 0) break; depth -= 1; }
      else if (ch === "," && depth === 0) break;
      i += 1;
    }
    return raw.slice(begin, i).trimEnd();
  };
  try {
    if (!isObject(JSON.parse(raw))) return null;
  } catch { return null; }
  const members = [];
  let colon = null;
  let comma = null;
  ws();
  i += 1; // {
  ws();
  while (i < raw.length && raw[i] !== "}") {
    const rawKey = string();
    const colonStart = i;
    ws(); i += 1; ws();
    colon ??= raw.slice(colonStart, i);
    const rawValue = value();
    members.push({ key: JSON.parse(rawKey), rawKey, rawValue });
    ws();
    if (raw[i] === ",") {
      const commaStart = i;
      i += 1;
      ws();
      comma ??= raw.slice(commaStart, i);
    }
  }
  return { members, style: { colon: colon ?? ": ", comma: comma ?? ", " } };
}

/** The separator style of a dataset: that of its first readable line, else Python's json.dumps default. */
export function detectStyle(lines) {
  for (const line of lines) {
    const scanned = scanMembers(line.original);
    if (scanned && scanned.members.length > 1) return scanned.style;
  }
  return { colon: ": ", comma: ", " };
}

function stringify(value, style, floatLike = false) {
  if (typeof value === "number") return floatLike && Number.isInteger(value) ? `${value}.0` : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stringify(item, style)).join(style.comma)}]`;
  if (isObject(value)) return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}${style.colon}${stringify(item, style)}`).join(style.comma)}}`;
  return JSON.stringify(value);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Text for an edited line. An unchanged line keeps its original text exactly; otherwise members whose value did
 * not change keep their original text, and changed ones are written in the line's separator style. A number that
 * replaces a number written with a decimal point (such as duration 34.0) keeps one.
 */
export function serializeRecord(data, original, style = { colon: ": ", comma: ", " }) {
  const before = original === undefined ? { data: undefined } : parseLine(original);
  if (before.data !== undefined && same(before.data, data)) return original;
  const scanned = before.data !== undefined ? scanMembers(original) : null;
  const lineStyle = scanned?.style ?? style;
  const old = new Map((scanned?.members ?? []).map((member) => [member.key, member]));
  const parts = Object.entries(data).map(([key, value]) => {
    const member = old.get(key);
    if (member && same(JSON.parse(member.rawValue), value)) return `${member.rawKey}${lineStyle.colon}${member.rawValue}`;
    const floatLike = (member && /^-?\d+\.\d/.test(member.rawValue)) || (!member && key === "duration");
    return `${JSON.stringify(key)}${lineStyle.colon}${stringify(value, lineStyle, floatLike)}`;
  });
  return `{${parts.join(lineStyle.comma)}}`;
}

/** The dataset as JSONL text: every line's current text, the file's line ending, and a final newline. */
export function exportJsonl(dataset) {
  const eol = dataset.eol || "\n";
  return dataset.lines.map((line) => `${line.raw}${eol}`).join("");
}

/* ---------- Editing ---------- */

/** Replace a line's text (after a field edit or a raw edit) and re-parse it. Returns the updated line. */
export function setLineRaw(line, raw) {
  Object.assign(line, { raw }, parseLine(raw));
  if (line.data !== undefined) delete line.error;
  return line;
}

/** Apply `change(data)` to a copy of the line's object and store the result in the dataset's style. */
export function editLine(line, change, style) {
  if (line.data === undefined) throw new Error("This line is not valid JSON. Edit its text instead.");
  const data = structuredClone(line.data);
  change(data);
  return setLineRaw(line, serializeRecord(data, line.original, style));
}

export const isEdited = (line) => line.raw !== line.original;

/** Choices after removing one letter: later letters move up, and the answer follows its choice. */
export function removeChoice(data, key) {
  const entries = Object.entries(data.choices).filter(([letterKey]) => letterKey !== key);
  const answerIndex = Object.keys(data.choices).indexOf(data.correct_answer);
  const removedIndex = Object.keys(data.choices).indexOf(key);
  data.choices = Object.fromEntries(entries.map(([, text], index) => [letter(index), text]));
  if (data.correct_answer === key) data.correct_answer = "";
  else if (answerIndex > removedIndex) data.correct_answer = letter(answerIndex - 1);
}

export function addChoice(data) {
  const keys = Object.keys(data.choices);
  data.choices = { ...data.choices, [letter(keys.length)]: "" };
}

/* ---------- Search ---------- */

export const STATUS_FILTERS = { "": "All lines", errors: "With errors", warnings: "With warnings only", ok: "No problems", edited: "Edited" };

/** Indexes of lines matching the Browse filters. `problems` is validateDataset(...).problems. */
export function filterLines(lines, problems, { query = "", scenario = "", status = "" } = {}) {
  const needle = query.trim().toLowerCase();
  return lines.flatMap((line, index) => {
    const data = isObject(line.data) ? line.data : {};
    if (needle) {
      const haystack = [data.video_clip_id, data.question_id, data.question, ...(isObject(data.choices) ? Object.values(data.choices) : []), line.data === undefined ? line.raw : ""]
        .filter((item) => typeof item === "string").join("\n").toLowerCase();
      if (!haystack.includes(needle)) return [];
    }
    if (scenario && !(Array.isArray(data.scenario) && data.scenario.includes(scenario))) return [];
    const list = problems[index] || [];
    const errors = list.some((item) => item.level === "error");
    if (status === "errors" && !errors) return [];
    if (status === "warnings" && (errors || !list.length)) return [];
    if (status === "ok" && list.length) return [];
    if (status === "edited" && !isEdited(line)) return [];
    return [index];
  });
}

/* ---------- Video sources ---------- */

const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const clipName = (title) => title.replace(/\.mp4$/i, "");

/**
 * Read a Drive mapping: either { "Nan-001": "<fileId>" } or a Drive listing [{ title: "Nan-001.mp4", id }].
 * Listing entries that are not .mp4 files (folders, documents) are skipped.
 */
export function parseDriveMapping(value) {
  const map = {};
  const skipped = [];
  const duplicates = [];
  const add = (name, id, label) => {
    if (typeof name !== "string" || !name.trim() || typeof id !== "string" || !DRIVE_ID.test(id)) { skipped.push(label); return; }
    const clip = clipName(name.trim());
    if (Object.hasOwn(map, clip) && map[clip] !== id) duplicates.push(clip);
    map[clip] = id;
  };
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (!isObject(item) || typeof item.title !== "string" || !/\.mp4$/i.test(item.title)) { skipped.push(isObject(item) && typeof item.title === "string" ? item.title : `entry ${index + 1}`); return; }
      add(item.title, item.id, item.title);
    });
  } else if (isObject(value)) {
    for (const [name, id] of Object.entries(value)) add(name, id, name);
  } else {
    throw new Error("Expected an object { \"clip id\": \"Drive file ID\" } or a list of { title, id } entries.");
  }
  return { map, skipped, duplicates };
}

export const drivePreviewUrl = (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/preview`;
export const driveViewUrl = (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;

/** YouTube links for a line: the watch link at the start time and an embed limited to whole seconds. */
export function youtubeLinks(data) {
  let parsed;
  try { parsed = parseYouTubeUrl(data?.url); } catch { return null; }
  const start = parseClock(data.start_time);
  const end = parseClock(data.end_time);
  const startSeconds = start === null ? 0 : Math.floor(start / 1000);
  const watch = `https://www.youtube.com/watch?v=${parsed.video_id}${startSeconds ? `&t=${startSeconds}s` : ""}`;
  const params = new URLSearchParams({ start: String(startSeconds), playsinline: "1", rel: "0", hl: "en" });
  if (end !== null && end > (start ?? 0)) params.set("end", String(Math.ceil(end / 1000)));
  return { videoId: parsed.video_id, watch, embed: `https://www.youtube.com/embed/${parsed.video_id}?${params}` };
}
