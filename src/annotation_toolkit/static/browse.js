/**
 * Browse view: OmniTalk QA submission files (JSONL). It keeps its own state and its own localStorage keys and never
 * reads or writes the Annotate view's project storage. Format rules live in jsonl.js.
 */
import * as J from "./jsonl.js";

const $ = (id) => document.getElementById(id);
export const BROWSE_KEYS = { datasets: "omnitalk.browse.datasets.v1", prefs: "omnitalk.browse.prefs.v1", drive: "omnitalk.browse.drive.v1" };
/** Characters the Browse keys may use together, so the Annotate view keeps most of the browser's ~5 MB quota. */
export const STORAGE_BUDGET = 1_500_000;
const SOURCES = { drive: "Drive", youtube: "YouTube", local: "Local file" };
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|webm|mkv)$/i;

let datasets = [];
let activeId = null;
let prefs = { view: "annotate", tab: "questions", hide_answers: false, active_id: null, sources: {} };
let drive = { map: {}, name: "", imported_at: null };
const localClips = new Map(); // video_clip_id -> { name, url }; object URLs only live as long as this page
const history = new Map(); // dataset ID -> [{ index, raw }], most recent last; not saved
const selection = new Map(); // dataset ID -> selected line index
const filters = { query: "", scenario: "", status: "" };
let validation = { problems: [], summary: { lines: 0, errorLines: 0, warningLines: 0, byRule: {} } };
let storageBlocked = false;
const stored = new Map();
let rawEditing = false;
let videoKey = null;
let toastTimer;

/* ---------- Small DOM helpers (same patterns as app.js) ---------- */

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function button(label, handler, className = "button secondary") {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", handler);
  return node;
}
function link(label, href) {
  const node = el("a", "subtle-link", label);
  node.href = href;
  node.target = "_blank";
  node.rel = "noopener noreferrer";
  return node;
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $("browse-toast-message").textContent = message;
  $("browse-toast").classList.toggle("error", error);
  $("browse-toast").hidden = false;
  toastTimer = setTimeout(() => { $("browse-toast").hidden = true; }, 5000);
}
function confirmAction(title, message, acceptLabel) {
  const dialog = $("browse-confirm");
  if (dialog.open) return Promise.resolve(false);
  $("browse-confirm-title").textContent = title;
  $("browse-confirm-message").textContent = message;
  $("browse-confirm-accept").textContent = acceptLabel;
  return new Promise((resolve) => {
    let accepted = false;
    $("browse-confirm-accept").onclick = () => { accepted = true; dialog.close(); };
    $("browse-confirm-cancel").onclick = () => dialog.close();
    dialog.addEventListener("close", () => resolve(accepted), { once: true });
    dialog.showModal();
  });
}
const pad2 = (n) => String(n).padStart(2, "0");
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/* ---------- Storage: only the Browse keys ---------- */

function warn(message) {
  $("browse-storage-warning").hidden = !message;
  $("browse-storage-warning-text").textContent = message || "";
}
function readKey(key) {
  const raw = localStorage.getItem(key);
  stored.set(key, raw);
  return raw;
}
const browseSize = (key, raw) => Object.values(BROWSE_KEYS).reduce((total, name) => total + ((name === key ? raw : stored.get(name)) ?? "").length, 0);

/** Save one Browse key. With `soft`, a full quota or budget just returns false so the caller can refuse the change. */
function writeKey(key, value, { soft = false } = {}) {
  if (storageBlocked) return false;
  const raw = JSON.stringify(value);
  try {
    if (localStorage.getItem(key) !== (stored.get(key) ?? null)) {
      storageBlocked = true;
      warn("Another tab changed the Browse data. Saving is paused here so neither overwrites the other. Export your QA files, then reload.");
      return false;
    }
    if (key !== BROWSE_KEYS.prefs && browseSize(key, raw) > STORAGE_BUDGET) {
      if (!soft) warn("QA files use all the browser space set aside for Browse. This change is kept on this page only: export the file, then remove a QA file you no longer need.");
      return false;
    }
    localStorage.setItem(key, raw);
    stored.set(key, raw);
    if (!storageBlocked) warn("");
    return true;
  } catch {
    if (!soft) warn("Browser storage is unavailable or full. Browse changes are kept on this page only; export your QA files.");
    return false;
  }
}

const storedLine = (line) => (line.raw === line.original ? { n: line.number, o: line.original } : { n: line.number, o: line.original, c: line.raw });
const datasetsPayload = (list = datasets) => ({ version: 1, datasets: list.map((item) => ({ id: item.id, name: item.name, imported_at: item.imported_at, eol: item.eol, lines: item.lines.map(storedLine) })) });
const persist = (options) => writeKey(BROWSE_KEYS.datasets, datasetsPayload(), options);
function savePrefs() {
  prefs.active_id = activeId;
  writeKey(BROWSE_KEYS.prefs, prefs, { soft: true }); // a view preference; losing it is harmless
}

function restoreDataset(item) {
  if (typeof item?.id !== "string" || typeof item.name !== "string" || !Array.isArray(item.lines)) throw new Error("Unreadable QA file entry.");
  const lines = item.lines.map(({ n, o, c }) => {
    if (!Number.isInteger(n) || typeof o !== "string" || (c !== undefined && typeof c !== "string")) throw new Error("Unreadable QA line.");
    const raw = c ?? o;
    return { number: n, original: o, raw, ...J.parseLine(raw) };
  });
  return { id: item.id, name: item.name, imported_at: item.imported_at ?? null, eol: item.eol === "\r\n" ? "\r\n" : "\n", lines, style: J.detectStyle(lines) };
}

function restore() {
  try {
    const raw = readKey(BROWSE_KEYS.prefs);
    if (raw) prefs = { ...prefs, ...JSON.parse(raw) };
    if (typeof prefs.sources !== "object" || !prefs.sources) prefs.sources = {};
  } catch { /* Preferences are optional. */ }
  try {
    const raw = readKey(BROWSE_KEYS.drive);
    if (raw) {
      const value = JSON.parse(raw);
      drive = { map: J.parseDriveMapping(value.map ?? {}).map, name: String(value.name ?? ""), imported_at: value.imported_at ?? null };
    }
  } catch { /* An unreadable mapping is left untouched; import it again. */ }
  try {
    const raw = readKey(BROWSE_KEYS.datasets);
    if (raw) {
      const value = JSON.parse(raw);
      if (value?.version !== 1 || !Array.isArray(value.datasets)) throw new Error("Unsupported Browse storage.");
      datasets = value.datasets.map(restoreDataset);
    }
  } catch {
    storageBlocked = true;
    warn("The saved QA files could not be read. Their browser data is untouched and saving is paused; import the original files again in another browser profile, or export what is on this page.");
  }
  activeId = datasets.some((item) => item.id === prefs.active_id) ? prefs.active_id : datasets[0]?.id ?? null;
}

/* ---------- State helpers ---------- */

const current = () => datasets.find((item) => item.id === activeId) ?? null;
const currentIndex = () => {
  const dataset = current();
  if (!dataset) return null;
  const index = selection.get(dataset.id);
  return Number.isInteger(index) && dataset.lines[index] ? index : null;
};
const currentLine = () => { const index = currentIndex(); return index === null ? null : current().lines[index]; };
const sourceKey = (dataset, line) => `${dataset.id}:${line.number}`;
const revalidate = () => { validation = J.validateDataset(current()?.lines ?? []); };

/* ---------- Import, export, remove ---------- */

function uniqueName(name) {
  const names = new Set(datasets.map((item) => item.name));
  if (!names.has(name)) return name;
  const [, stem, ext] = /^(.*?)(\.[^.]*)?$/.exec(name);
  let n = 2;
  while (names.has(`${stem} (${n})${ext ?? ""}`)) n += 1;
  return `${stem} (${n})${ext ?? ""}`;
}

function fileReport(name, parsed) {
  const parts = [`${name}: ${plural(parsed.lines.length, "line")}`];
  if (parsed.malformed.length) parts.push(`not readable as a JSON object: ${parsed.malformed.map((item) => `line ${item.number} (${item.error})`).join("; ")}`);
  if (parsed.blank.length) parts.push(`blank ${parsed.blank.length === 1 ? "line" : "lines"} ${parsed.blank.join(", ")} skipped`);
  if (parsed.bom) parts.push("byte order mark removed");
  return parts.join(" · ");
}

function showReport(lines, error = false) {
  $("browse-import-report").hidden = !lines.length;
  $("browse-import-report").classList.toggle("error", error);
  $("browse-import-report-text").replaceChildren(...lines.map((line) => el("p", "", line)));
}

async function importFiles(fileList, { localFallback = null } = {}) {
  const files = [...fileList || []];
  if (!files.length) return;
  const videos = files.filter((file) => VIDEO_EXTENSIONS.test(file.name) || file.type.startsWith("video/"));
  const mappings = files.filter((file) => !videos.includes(file) && /\.json$/i.test(file.name));
  const jsonl = files.filter((file) => !videos.includes(file) && !mappings.includes(file));
  const report = [];
  let error = false;
  if (jsonl.length) {
    if (jsonl.some((file) => file.size > 20 * 1024 * 1024) && !await confirmAction("Import a large file?", "A selected file is larger than 20 MB. Browse keeps QA files in browser storage, which usually holds only a few MB.", "Read files")) return;
    const fresh = [];
    for (const file of jsonl) {
      const parsed = J.parseJsonl(await file.text());
      if (!parsed.lines.length) { report.push(`${file.name}: no lines to import; skipped.`); error = true; continue; }
      fresh.push({ id: globalThis.crypto.randomUUID(), name: uniqueName(file.name), imported_at: new Date().toISOString(), eol: parsed.eol, lines: parsed.lines, style: J.detectStyle(parsed.lines) });
      report.push(fileReport(fresh.at(-1).name, parsed));
      if (parsed.malformed.length) error = true;
    }
    if (fresh.length) {
      if (!writeKey(BROWSE_KEYS.datasets, datasetsPayload([...datasets, ...fresh]), { soft: true })) {
        toast(storageBlocked ? "Import failed: saving is paused (see the warning above)." : "Import failed: the file does not fit in the browser space set aside for Browse. Remove a QA file first.", true);
        return;
      }
      datasets.push(...fresh);
      activeId = fresh[0].id;
      rawEditing = false;
      clearFilters();
      savePrefs();
      if (fresh.length > 1) report.push(`Loaded ${fresh.length} files; use the file selector to switch between them.`);
    }
  }
  for (const file of mappings) {
    try { report.push(await importDrive(file)); } catch (problem) { report.push(`${file.name}: ${problem.message}`); error = true; }
  }
  if (videos.length) report.push(addLocalClips(videos, localFallback));
  showReport(report, error);
  renderAll();
}

async function importDrive(file) {
  let value;
  try { value = JSON.parse((await file.text()).replace(/^﻿/, "")); } catch { throw new Error("not valid JSON."); }
  const result = J.parseDriveMapping(value);
  const count = Object.keys(result.map).length;
  if (!count) throw new Error("no clip with a Drive file ID found. Expected { \"Nan-001\": \"<file ID>\" } or a Drive listing with Nan-001.mp4 titles.");
  const next = { map: { ...drive.map, ...result.map }, name: file.name, imported_at: new Date().toISOString() };
  if (!writeKey(BROWSE_KEYS.drive, next, { soft: true })) throw new Error("could not be saved in browser storage.");
  drive = next;
  const parts = [`Drive mapping ${file.name}: ${plural(count, "clip")}`];
  if (result.skipped.length) parts.push(`skipped ${result.skipped.length} ${result.skipped.length === 1 ? "entry" : "entries"} that are not .mp4 files or have no valid ID (${result.skipped.slice(0, 5).join(", ")}${result.skipped.length > 5 ? ", …" : ""})`);
  if (result.duplicates.length) parts.push(`listed more than once, last ID used: ${result.duplicates.join(", ")}`);
  return parts.join(" · ");
}

function addLocalClips(files, fallbackClip) {
  const clips = new Set(datasets.flatMap((item) => item.lines.map((line) => line.data?.video_clip_id).filter((id) => typeof id === "string")));
  const matched = [];
  const unmatched = [];
  for (const file of files) {
    const base = file.name.replace(/\.[^.]+$/, "");
    const clip = clips.has(base) ? base : files.length === 1 && fallbackClip ? fallbackClip : null;
    if (!clip) { unmatched.push(file.name); continue; }
    if (localClips.has(clip)) URL.revokeObjectURL(localClips.get(clip).url);
    localClips.set(clip, { name: file.name, url: URL.createObjectURL(file) });
    matched.push(clip === base ? clip : `${file.name} → ${clip}`);
  }
  videoKey = null;
  const parts = [`Local clips: ${matched.length ? matched.join(", ") : "none matched"}`];
  if (unmatched.length) parts.push(`no question uses ${unmatched.join(", ")} (name files <video_clip_id>.mp4)`);
  return parts.join(" · ");
}

async function exportCurrent() {
  const dataset = current();
  if (!dataset) return;
  const { errorLines } = validation.summary;
  if (errorLines && !await confirmAction("Export a file with errors?", `${plural(errorLines, "line")} still ${errorLines === 1 ? "has" : "have"} errors. The export keeps them as they are.`, "Export anyway")) return;
  const blob = new Blob([J.exportJsonl(dataset)], { type: "application/x-ndjson;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = /\.jsonl$/i.test(dataset.name) ? dataset.name : `${dataset.name.replace(/\.[^.]*$/, "")}.jsonl`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("JSONL prepared. Your browser handles the download location.");
}

async function removeCurrent() {
  const dataset = current();
  if (!dataset) return;
  const edited = dataset.lines.filter(J.isEdited).length;
  if (!await confirmAction("Remove this QA file?", `Remove “${dataset.name}” (${plural(dataset.lines.length, "line")}) from browser storage?${edited ? ` Its ${plural(edited, "edited line")} will be lost unless you export first.` : ""} The Annotate view and files on your computer are not changed.`, "Remove file")) return;
  const rest = datasets.filter((item) => item !== dataset);
  if (!writeKey(BROWSE_KEYS.datasets, datasetsPayload(rest)) && !storageBlocked) return;
  datasets = rest;
  history.delete(dataset.id);
  selection.delete(dataset.id);
  for (const key of Object.keys(prefs.sources)) if (key.startsWith(`${dataset.id}:`)) delete prefs.sources[key];
  activeId = datasets[0]?.id ?? null;
  rawEditing = false;
  clearFilters();
  savePrefs();
  renderAll();
  toast("QA file removed from browser storage");
}

/* ---------- Editing ---------- */

function commit(change, { rebuild = false } = {}) {
  const dataset = current();
  const index = currentIndex();
  if (!dataset || index === null) return;
  const line = dataset.lines[index];
  const before = line.raw;
  try { J.editLine(line, change, dataset.style); } catch (problem) { toast(problem.message, true); return; }
  if (line.raw === before) return;
  remember(dataset, index, before);
  afterEdit(rebuild);
}

function remember(dataset, index, raw) {
  const list = history.get(dataset.id) ?? [];
  list.push({ index, raw });
  if (list.length > 200) list.shift();
  history.set(dataset.id, list);
}

function afterEdit(rebuild) {
  persist();
  revalidate();
  renderSummary();
  renderList();
  renderStats();
  if (rebuild) renderDetail(); else refreshDetail();
  renderVideo();
}

function undo() {
  const dataset = current();
  const entry = history.get(dataset?.id)?.pop();
  if (!entry) return;
  J.setLineRaw(dataset.lines[entry.index], entry.raw);
  selection.set(dataset.id, entry.index);
  rawEditing = false;
  afterEdit(true);
  toast(`Undid the last edit on line ${dataset.lines[entry.index].number}`);
}

function revertLine() {
  const dataset = current();
  const index = currentIndex();
  const line = currentLine();
  if (!line || !J.isEdited(line)) return;
  remember(dataset, index, line.raw);
  J.setLineRaw(line, line.original);
  rawEditing = false;
  afterEdit(true);
  toast(`Line ${line.number} reverted to the imported text`);
}

function saveRaw(text) {
  const dataset = current();
  const index = currentIndex();
  const line = currentLine();
  const value = text.replace(/\r?\n/g, " ").trim();
  if (!value) { toast("A line cannot be empty. Revert it instead.", true); return; }
  if (value !== line.raw) {
    remember(dataset, index, line.raw);
    J.setLineRaw(line, value);
  }
  rawEditing = line.data === undefined;
  afterEdit(true);
}

/* ---------- Rendering ---------- */

function renderStats() {
  $("browse-total").textContent = pad2(validation.summary.lines);
  $("browse-error-total").textContent = pad2(validation.summary.errorLines);
  $("browse-export").disabled = !current();
  $("browse-undo").disabled = !(history.get(activeId)?.length);
}

function renderPicker() {
  $("browse-dataset").hidden = !datasets.length;
  $("browse-remove-dataset").hidden = !current();
  $("browse-dataset").replaceChildren(...datasets.map((item) => {
    const option = el("option", "", `${item.name} · ${plural(item.lines.length, "line")}`);
    option.value = item.id;
    return option;
  }));
  if (activeId) $("browse-dataset").value = activeId;
}

function renderSources() {
  const count = Object.keys(drive.map).length;
  const dataset = current();
  const clips = dataset ? [...new Set(dataset.lines.map((line) => line.data?.video_clip_id).filter((id) => typeof id === "string"))] : [];
  const matched = clips.filter((clip) => Object.hasOwn(drive.map, clip)).length;
  $("browse-drive-status").textContent = count ? `Drive: ${plural(count, "clip")}${dataset ? ` · ${matched} of ${plural(clips.length, "clip")} in this file` : ""}` : "No Drive mapping";
  $("browse-drive-status").title = drive.name ? `From ${drive.name}` : "";
  $("browse-drive-clear").hidden = !count;
  $("browse-local-status").textContent = localClips.size ? `${plural(localClips.size, "local clip")} (until reload)` : "No local clips";
}

function renderFilters() {
  $("browse-scenario").replaceChildren(...[["", "All scenarios"], ...J.SCENARIO_NAMES.map((name) => [name, name])].map(([value, label]) => {
    const option = el("option", "", label);
    option.value = value;
    return option;
  }));
  $("browse-status").replaceChildren(...Object.entries(J.STATUS_FILTERS).map(([value, label]) => {
    const option = el("option", "", label);
    option.value = value;
    return option;
  }));
  $("browse-search").value = filters.query;
  $("browse-scenario").value = filters.scenario;
  $("browse-status").value = filters.status;
  $("browse-hide-answers").checked = !!prefs.hide_answers;
  $("browse-view").classList.toggle("answers-hidden", !!prefs.hide_answers);
}

function clearFilters() { Object.assign(filters, { query: "", scenario: "", status: "" }); }

function renderSummary() {
  const { summary } = validation;
  const dataset = current();
  const edited = dataset ? dataset.lines.filter(J.isEdited).length : 0;
  const parts = [
    el("strong", "", plural(summary.lines, "line")),
    el("span", summary.errorLines ? "summary-error" : "summary-ok", `${summary.errorLines} with errors`),
    el("span", summary.warningLines ? "summary-warning" : "summary-ok", `${summary.warningLines} with warnings only`),
    el("span", edited ? "summary-edited" : "", plural(edited, "edited line")),
  ];
  const rules = J.RULES.filter((rule) => summary.byRule[rule.id]).map((rule) => {
    const chip = button(`${rule.id} × ${summary.byRule[rule.id]}`, () => { filters.status = rule.level === "error" ? "errors" : "warnings"; renderFilters(); renderList(); }, `rule-chip ${rule.level}`);
    chip.title = `${rule.level === "error" ? "Error" : "Warning"}: ${rule.text}`;
    return chip;
  });
  $("browse-summary").replaceChildren(el("div", "summary-counts"), ...(rules.length ? [el("div", "summary-rules")] : []));
  $("browse-summary").children[0].append(...parts);
  if (rules.length) $("browse-summary").children[1].append(...rules);
}

function lineBadges(line, problems) {
  const errors = problems.filter((item) => item.level === "error").length;
  const warnings = problems.length - errors;
  const badges = [];
  if (errors) badges.push(el("span", "line-badge error", plural(errors, "error")));
  if (warnings) badges.push(el("span", "line-badge warning", plural(warnings, "warning")));
  if (J.isEdited(line)) badges.push(el("span", "line-badge edited", "Edited"));
  return badges;
}

function renderList() {
  const dataset = current();
  if (!dataset) { $("browse-list").replaceChildren(); return; }
  const shown = J.filterLines(dataset.lines, validation.problems, filters);
  let index = currentIndex();
  if (index === null || (!shown.includes(index) && shown.length)) {
    index = shown[0] ?? null;
    if (index === null) selection.delete(dataset.id); else selection.set(dataset.id, index);
  }
  const total = dataset.lines.length;
  $("browse-count").textContent = shown.length === total ? plural(total, "question") : `${shown.length} of ${plural(total, "question")}`;
  $("browse-list").replaceChildren(...shown.map((lineIndex) => {
    const line = dataset.lines[lineIndex];
    const data = line.data ?? {};
    const item = el("button", "browse-item");
    item.type = "button";
    item.dataset.index = String(lineIndex);
    if (lineIndex === index) item.setAttribute("aria-current", "true");
    const title = el("span", "browse-item-title", typeof data.question_id === "string" && data.question_id ? data.question_id : `Line ${line.number}`);
    const meta = el("span", "browse-item-meta", line.data === undefined ? `Line ${line.number} · not readable` : [`Line ${line.number}`, Array.isArray(data.scenario) ? data.scenario.join(" + ") : ""].filter(Boolean).join(" · "));
    const text = el("span", "browse-item-text", line.data === undefined ? line.raw.slice(0, 120) : String(data.question ?? "").slice(0, 160));
    const badges = el("span", "browse-item-badges");
    badges.append(...lineBadges(line, validation.problems[lineIndex] ?? []));
    item.append(title, meta, text, badges);
    item.addEventListener("click", () => select(lineIndex));
    return item;
  }));
  if (!shown.length) $("browse-list").append(el("p", "browse-list-empty", "No matching questions. Try another search or filter."));
}

function select(index) {
  const dataset = current();
  if (!dataset) return;
  selection.set(dataset.id, index);
  rawEditing = false;
  for (const item of $("browse-list").querySelectorAll(".browse-item")) {
    if (item.dataset.index === String(index)) item.setAttribute("aria-current", "true"); else item.removeAttribute?.("aria-current");
  }
  renderDetail();
  renderVideo();
}

const fieldProblems = (field) => (validation.problems[currentIndex()] ?? []).filter((item) => item.field === field);

function errorsFor(field) {
  const box = el("div", "field-problems");
  box.dataset.errorsFor = field;
  return box;
}

function fillProblems(box, list) {
  box.replaceChildren(...list.map((item) => el("p", `problem ${item.level}`, item.message)));
  box.hidden = !list.length;
}

function textField(label, key, { multiline = false, mono = false, hint = "" } = {}) {
  const line = currentLine();
  const value = line.data[key];
  const wrapper = el("div", `browse-field field-${key}`);
  const id = `browse-field-${key}`;
  const labelNode = el("label", "form-label", label);
  labelNode.htmlFor = id;
  if (hint) labelNode.append(el("span", "optional", hint));
  const input = el(multiline ? "textarea" : "input", mono ? "mono" : "");
  input.id = id;
  input.dataset.key = key;
  // Numbers show their text in the file (34.0 rather than 34).
  const written = typeof value === "number" ? J.scanMembers(line.raw)?.members.find((member) => member.key === key)?.rawValue : null;
  input.value = typeof value === "string" ? value : value === undefined ? "" : written ?? JSON.stringify(value);
  if (multiline) input.rows = 3;
  input.autocomplete = "off";
  input.spellcheck = !mono;
  input.addEventListener("change", () => {
    const text = multiline ? input.value : input.value.trim();
    commit((data) => {
      if (key === "duration") data[key] = /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : text;
      else data[key] = text;
    });
  });
  wrapper.append(labelNode, input, errorsFor(key));
  return wrapper;
}

function renderDetail() {
  const dataset = current();
  const line = currentLine();
  const detail = $("browse-detail");
  if (!dataset || !line) { detail.replaceChildren(el("p", "browse-list-empty", dataset ? "Select a question in the list." : "")); return; }
  const data = line.data;
  const header = el("div", "browse-detail-heading");
  const titles = el("div");
  titles.append(el("span", "section-kicker", `LINE ${line.number} OF ${dataset.name.toUpperCase()}`), el("h2", "", data && typeof data.question_id === "string" && data.question_id ? data.question_id : `Line ${line.number}`));
  const badges = el("div", "browse-item-badges");
  badges.id = "browse-detail-badges";
  const actions = el("div", "browse-detail-actions");
  const revert = button("Revert line", revertLine);
  revert.id = "browse-revert";
  revert.title = "Go back to the text this line had when the file was imported";
  actions.append(revert);
  if (data !== undefined) actions.append(button(rawEditing ? "Edit fields" : "Edit line text", () => { rawEditing = !rawEditing; renderDetail(); }));
  header.append(titles, badges, actions);
  const lineProblems = el("div", "line-problems");
  lineProblems.id = "browse-line-problems";
  const video = el("div", "browse-video");
  video.id = "browse-video";
  const body = el("div", "browse-fields");
  if (data === undefined || rawEditing) body.append(rawEditor(line));
  else body.append(...fieldEditors(data));
  const focusKey = document.activeElement?.dataset?.key;
  detail.replaceChildren(header, lineProblems, video, body);
  videoKey = null;
  refreshDetail();
  if (focusKey) detail.querySelector(`[data-key="${focusKey}"]`)?.focus();
}

function rawEditor(line) {
  const wrapper = el("div", "browse-raw");
  const label = el("label", "form-label", "Line text");
  label.htmlFor = "browse-raw-text";
  label.append(el("span", "optional", "One JSON object; saved as one line"));
  const input = el("textarea", "mono");
  input.id = "browse-raw-text";
  input.value = line.raw;
  input.rows = 8;
  input.spellcheck = false;
  const row = el("div", "browse-raw-actions");
  row.append(button("Save line text", () => saveRaw(input.value), "button primary"));
  if (line.data !== undefined) row.append(button("Cancel", () => { rawEditing = false; renderDetail(); }));
  wrapper.append(label, input, row);
  return wrapper;
}

function fieldEditors(data) {
  const ids = el("div", "browse-row");
  ids.append(textField("Clip ID", "video_clip_id", { mono: true, hint: "video_clip_id" }), textField("Question ID", "question_id", { mono: true, hint: "question_id" }));
  const times = el("div", "browse-row three");
  const duration = textField("Duration", "duration", { mono: true, hint: "seconds" });
  const recompute = button("Recompute from times", () => {
    const value = J.expectedDuration(currentLine().data);
    if (value === null) return;
    commit((next) => { next.duration = value; });
    const input = $("browse-field-duration");
    if (input) input.value = J.scanMembers(currentLine().raw)?.members.find((member) => member.key === "duration")?.rawValue ?? String(currentLine().data.duration);
  }, "text-button recompute");
  recompute.id = "browse-recompute";
  duration.append(recompute);
  times.append(textField("Start time", "start_time", { mono: true, hint: "HH:MM:SS.mmm" }), textField("End time", "end_time", { mono: true, hint: "HH:MM:SS.mmm" }), duration);
  const scenario = el("div", "browse-field field-scenario");
  const scenarioLabel = el("span", "form-label", "Scenario");
  scenarioLabel.id = "browse-scenario-label";
  scenarioLabel.append(el("span", "optional", "1, at most 2"));
  const chips = el("div", "scenario-chips");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-labelledby", "browse-scenario-label");
  const known = Array.isArray(data.scenario) ? data.scenario : [];
  for (const name of [...J.SCENARIO_NAMES, ...known.filter((item) => !J.SCENARIO_NAMES.includes(item))]) {
    const chip = button(String(name), () => {
      commit((next) => {
        const list = Array.isArray(next.scenario) ? next.scenario : [];
        next.scenario = list.includes(name) ? list.filter((item) => item !== name) : [...list, name];
      });
      for (const other of chips.children) other.setAttribute("aria-pressed", String((currentLine().data.scenario ?? []).includes(other.dataset.scenario)));
    }, `scenario-chip${J.SCENARIO_NAMES.includes(name) ? "" : " unknown"}`);
    chip.dataset.scenario = name;
    chip.dataset.key = `scenario:${name}`;
    chip.setAttribute("aria-pressed", String(known.includes(name)));
    chips.append(chip);
  }
  scenario.append(scenarioLabel, chips, errorsFor("scenario"));
  return [ids, textField("YouTube URL", "url", { mono: true, hint: "url" }), times, scenario, textField("Question", "question", { multiline: true }), choicesEditor(data), errorsFor("correct_answer"), extraKeys(data)];
}

function choicesEditor(data) {
  const wrapper = el("div", "browse-field field-choices");
  const label = el("span", "form-label", "Choices");
  label.append(el("span", "optional answer-hint", "Select the correct answer"), el("span", "optional answer-hidden-note", "Answers hidden"));
  const list = el("div", "browse-choices");
  list.setAttribute("role", "radiogroup");
  list.setAttribute("aria-label", "Correct answer");
  const choices = data.choices !== null && typeof data.choices === "object" && !Array.isArray(data.choices) ? data.choices : null;
  if (!choices) {
    wrapper.append(label, el("p", "problem error", "choices is not an object. Use Edit line text to fix it."), errorsFor("choices"));
    return wrapper;
  }
  for (const [key, text] of Object.entries(choices)) {
    const row = el("div", "browse-choice");
    row.dataset.choice = key;
    if (key === data.correct_answer) row.classList.add("is-correct");
    const radio = el("input", "browse-answer");
    radio.type = "radio";
    radio.name = "browse-correct";
    radio.checked = key === data.correct_answer;
    radio.setAttribute("aria-label", `Choice ${key} is correct`);
    radio.dataset.key = `answer:${key}`;
    radio.addEventListener("change", () => {
      commit((next) => { next.correct_answer = key; });
      for (const other of list.children) other.classList.toggle("is-correct", other.dataset.choice === key);
    });
    const letter = el("span", "choice-letter", key);
    const input = el("input");
    input.value = typeof text === "string" ? text : JSON.stringify(text);
    input.dataset.key = `choice:${key}`;
    input.setAttribute("aria-label", `Choice ${key}`);
    input.addEventListener("change", () => commit((next) => { next.choices[key] = input.value; }));
    const remove = button("", () => commit((next) => J.removeChoice(next, key), { rebuild: true }), "icon-button");
    remove.setAttribute("aria-label", `Remove choice ${key}`);
    remove.title = `Remove choice ${key}; later letters move up`;
    remove.innerHTML = '<svg class="icon"><use href="#i-close"/></svg>';
    row.append(radio, letter, input, el("span", "correct-tag", "Correct"), remove);
    list.append(row);
  }
  const add = button("+ Add choice", () => commit((next) => J.addChoice(next), { rebuild: true }), "text-button");
  add.disabled = Object.keys(choices).length >= 26;
  const actions = el("div", "browse-choice-actions");
  actions.append(add);
  if (!J.choicesInOrder(choices)) actions.append(button("Re-letter A, B, C…", () => commit((next) => J.reletterChoices(next), { rebuild: true }), "text-button"));
  wrapper.append(label, list, actions, errorsFor("choices"));
  return wrapper;
}

function extraKeys(data) {
  const extra = Object.keys(data).filter((key) => !J.FIELD_NAMES.includes(key));
  const wrapper = el("div", "browse-extra");
  if (!extra.length) return wrapper;
  wrapper.append(el("span", "form-label", "Other keys"));
  for (const key of extra) {
    const row = el("div", "browse-extra-row");
    row.append(el("span", "mono", key), el("span", "mono", JSON.stringify(data[key])));
    wrapper.append(row);
  }
  wrapper.append(el("p", "browse-note", "Kept unchanged on export. Use Edit line text to change them."));
  return wrapper;
}

/** Update problems, badges and buttons in place, without rebuilding inputs (so focus and typing are kept). */
function refreshDetail() {
  const line = currentLine();
  if (!line || !$("browse-line-problems")) return;
  const problems = validation.problems[currentIndex()] ?? [];
  $("browse-detail-badges")?.replaceChildren(...lineBadges(line, problems));
  if ($("browse-revert")) $("browse-revert").disabled = !J.isEdited(line);
  const general = problems.filter((item) => !item.field || !$("browse-detail").querySelector(`[data-errors-for="${item.field}"]`));
  fillProblems($("browse-line-problems"), general);
  for (const box of $("browse-detail").querySelectorAll(".field-problems")) fillProblems(box, problems.filter((item) => item.field === box.dataset.errorsFor));
  for (const wrapper of $("browse-detail").querySelectorAll(".browse-field")) {
    const key = [...wrapper.className.split(" ")].find((name) => name.startsWith("field-"))?.slice(6);
    wrapper.classList.toggle("has-error", fieldProblems(key).some((item) => item.level === "error"));
  }
  const recompute = $("browse-recompute");
  if (recompute && line.data) {
    const expected = J.expectedDuration(line.data);
    const off = expected !== null && expected > 0 && problems.some((item) => item.rule === "duration");
    recompute.hidden = !off;
    recompute.textContent = off ? `Set to ${expected} (end − start)` : "Recompute from times";
  }
}

/* ---------- Video ---------- */

const SOURCE_HELP = {
  drive: "Plays the uploaded clip from Google Drive, so 0:00 is start_time. Drive only plays it in a browser signed in to a Google account that can open the file (or when the file is shared with anyone who has the link). Blocking third-party cookies (Safari, Firefox strict mode, Chrome with third-party cookies off) can make Drive ask you to sign in even when you are. This page cannot start or seek the Drive player: use its own controls. If it shows a sign-in or access message, use Open in Drive or switch to YouTube.",
  youtube: "Plays the original video from start_time to end_time in YouTube's embedded player. YouTube's start and end take whole seconds, so the range is rounded outward; after you seek, the end is no longer enforced. The video's owner must allow embedding.",
  local: "Plays a clip file from this computer, named <video_clip_id>.mp4, so 0:00 is start_time. Files are not uploaded or saved: choose them again after reloading the page.",
};

function availableSources(line) {
  const data = line.data;
  const clip = typeof data?.video_clip_id === "string" ? data.video_clip_id : "";
  return { clip, yt: data ? J.youtubeLinks(data) : null, driveId: drive.map[clip] ?? null, local: localClips.get(clip) ?? null };
}

function chosenSource(dataset, line, sources) {
  const saved = prefs.sources[sourceKey(dataset, line)];
  if (saved === "drive" && sources.driveId) return "drive";
  if (saved === "youtube" && sources.yt) return "youtube";
  if (saved === "local") return "local";
  return sources.local ? "local" : sources.driveId ? "drive" : sources.yt ? "youtube" : "local";
}

function stopVideo() {
  const box = $("browse-video");
  box?.querySelector?.("video")?.pause?.();
  box?.querySelector(".browse-stage")?.replaceChildren();
  videoKey = null;
}

function renderVideo() {
  const box = $("browse-video");
  const dataset = current();
  const line = currentLine();
  if (!box || !dataset || !line || document.body.dataset.view !== "browse") return;
  const sources = availableSources(line);
  const source = chosenSource(dataset, line, sources);
  const key = JSON.stringify([source, sources.driveId, sources.yt?.embed, sources.local?.url, line.data === undefined]);
  if (key === videoKey) return;
  videoKey = key;
  const tabs = el("div", "source-switch");
  tabs.setAttribute("role", "radiogroup");
  tabs.setAttribute("aria-label", "Video source");
  for (const [id, label] of Object.entries(SOURCES)) {
    const tab = button(label, () => {
      if (id === "local" && !sources.local) { pickLocal(sources.clip); return; }
      prefs.sources[sourceKey(dataset, line)] = id;
      savePrefs();
      renderVideo();
    }, "source-option");
    tab.setAttribute("role", "radio");
    tab.setAttribute("aria-checked", String(id === source));
    if (id === "drive" && !sources.driveId) { tab.disabled = true; tab.title = sources.clip ? `No Drive file ID for ${sources.clip}. Import a Drive mapping.` : "This line has no video_clip_id."; }
    if (id === "youtube" && !sources.yt) { tab.disabled = true; tab.title = "This line has no valid YouTube url."; }
    if (id === "local" && !sources.local) tab.title = `Choose ${sources.clip || "the clip"}.mp4 from this computer`;
    tabs.append(tab);
  }
  const stage = el("div", "browse-stage");
  if (line.data === undefined) stage.append(el("p", "stage-message", "Fix this line's text to play its clip."));
  else if (source === "drive" && sources.driveId) stage.append(frame(J.drivePreviewUrl(sources.driveId), `Google Drive player: ${sources.clip}.mp4`, "autoplay; fullscreen"));
  else if (source === "youtube" && sources.yt) stage.append(frame(sources.yt.embed, `YouTube player: ${sources.clip}`, "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"));
  else if (source === "local" && sources.local) {
    const video = el("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = sources.local.url;
    video.setAttribute("aria-label", `Local clip ${sources.local.name}`);
    stage.append(video);
  } else {
    const message = el("div", "stage-message");
    message.append(el("p", "", `No local file for ${sources.clip || "this clip"} yet.`), button(`Choose ${sources.clip || "clip"}.mp4`, () => pickLocal(sources.clip)));
    stage.append(message);
  }
  const links = el("div", "browse-video-links");
  if (sources.yt) {
    const start = J.parseClock(line.data.start_time);
    links.append(link(`YouTube at ${start === null ? "0:00" : J.formatClock(start).replace(/\.\d+$/, "")} ↗`, sources.yt.watch));
    links.append(el("span", "mono browse-video-url", sources.yt.watch));
  }
  if (sources.driveId) links.append(link("Open in Drive ↗", J.driveViewUrl(sources.driveId)));
  if (sources.local) links.append(el("span", "browse-note", `Local: ${sources.local.name}`));
  box.replaceChildren(tabs, stage, links, el("p", "browse-note video-help", SOURCE_HELP[source]));
}

function frame(src, title, allow) {
  const iframe = el("iframe");
  iframe.src = src;
  iframe.title = title;
  iframe.allow = allow;
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  return iframe;
}

let pendingLocalClip = null;
function pickLocal(clip) {
  pendingLocalClip = clip || null;
  $("browse-local-file").click();
}

/* ---------- Format tab (rendered from jsonl.js) ---------- */

function table(headings, rows) {
  const node = el("table", "format-table");
  const head = el("thead");
  const headRow = el("tr");
  headRow.append(...headings.map((text) => { const th = el("th", "", text); th.scope = "col"; return th; }));
  head.append(headRow);
  const body = el("tbody");
  body.append(...rows.map((cells) => {
    const row = el("tr");
    row.append(...cells.map((cell) => { const td = el("td"); if (typeof cell === "string") td.textContent = cell; else td.append(cell); return td; }));
    return row;
  }));
  node.append(head, body);
  const scroll = el("div", "table-scroll");
  scroll.append(node);
  return scroll;
}

function renderFormat() {
  $("browse-format-version").textContent = `v${J.FORMAT_VERSION}`;
  const card = el("div", "format-card");
  const intro = el("div", "format-intro");
  intro.append(el("span", "section-kicker", "THE FILE FORMAT"), el("h2", "", `OmniTalk QA submission format · v${J.FORMAT_VERSION}`),
    el("p", "", "One multiple-choice question per line, as JSON. This is the format Browse checks and writes. It is separate from the Annotate view's project JSON (schema 1.5). The same text is in JSONL_FORMAT.md in the repository."));
  const notes = el("ul", "format-notes");
  notes.append(...J.FILE_NOTES.map((note) => el("li", "", note)));
  const code = (text) => el("code", "", text);
  const fields = table(["Field", "Type", "Constraint", "Example"], J.FIELDS.map((field) => [code(field.name), field.type, field.constraint, code(field.example)]));
  const example = el("pre", "format-example mono", J.EXAMPLE_LINE);
  const scenarios = el("ol", "format-scenarios");
  scenarios.append(...J.SCENARIO_NAMES.map((name) => el("li", "", name)));
  const rules = table(["Rule", "Level", "Rule text"], J.RULES.map((rule) => [code(rule.id), el("span", `line-badge ${rule.level}`, rule.level), rule.text]));
  const changelog = el("ul", "format-notes");
  changelog.append(...J.CHANGELOG.map((entry) => el("li", "", `v${entry.version} (${entry.date}): ${entry.changes.join(" ")}`)));
  card.append(intro, el("h3", "", "File"), notes, el("h3", "", "Fields"), el("p", "browse-note", "All ten fields are required."), fields, el("h3", "", "Example line"), example,
    el("h3", "", "Scenario categories"), el("p", "browse-note", "scenario uses these names exactly, the same 12 categories as the Annotate view."), scenarios,
    el("h3", "", "Validation rules"), el("p", "browse-note", "An error means the line does not follow the format; a warning points at a probable mistake that is allowed."), rules,
    el("h3", "", "Export"), el("p", "browse-note", "Unedited lines are written back exactly as imported, with the file's line ending and a final newline; a byte order mark and blank lines are dropped. Edited lines keep the original text of unchanged fields and the line's separators (\", \" and \": \"), so duration stays 34.0. Keys keep their order; unknown keys are kept."),
    el("h3", "", "Changelog"), changelog);
  $("browse-format").replaceChildren(card);
}

function setTab(tab, persist = true) {
  prefs.tab = tab === "format" ? "format" : "questions";
  $("browse-tab-questions").setAttribute("aria-selected", String(prefs.tab === "questions"));
  $("browse-tab-format").setAttribute("aria-selected", String(prefs.tab === "format"));
  $("browse-questions").hidden = prefs.tab !== "questions";
  $("browse-format").hidden = prefs.tab !== "format";
  if (prefs.tab === "format") stopVideo(); else renderVideo();
  if (persist) savePrefs();
}

/* ---------- View switch ---------- */

function setView(view, persist = true) {
  const next = view === "browse" ? "browse" : "annotate";
  document.body.dataset.view = next;
  $("view-annotate").setAttribute("aria-selected", String(next === "annotate"));
  $("view-browse").setAttribute("aria-selected", String(next === "browse"));
  if (next === "browse") { videoKey = null; renderVideo(); } else stopVideo();
  // Lets the Annotate view pause its player; it holds its own state and is otherwise untouched.
  window.dispatchEvent(new CustomEvent("omnitalk-view", { detail: next }));
  prefs.view = next;
  if (persist) savePrefs();
}

function renderAll() {
  revalidate();
  renderPicker();
  renderSources();
  renderFilters();
  renderSummary();
  renderStats();
  const has = !!current();
  $("browse-empty").hidden = has;
  $("browse-workspace").hidden = !has;
  renderList();
  renderDetail();
  renderVideo();
}

/* ---------- Events ---------- */

$("view-annotate").addEventListener("click", () => setView("annotate"));
$("view-browse").addEventListener("click", () => setView("browse"));
$("browse-tab-questions").addEventListener("click", () => setTab("questions"));
$("browse-tab-format").addEventListener("click", () => setTab("format"));
$("browse-import").addEventListener("click", () => $("browse-import-file").click());
$("browse-import-file").addEventListener("change", async () => { await importFiles($("browse-import-file").files); $("browse-import-file").value = ""; });
$("browse-export").addEventListener("click", exportCurrent);
$("browse-remove-dataset").addEventListener("click", removeCurrent);
$("browse-dataset").addEventListener("change", () => {
  activeId = $("browse-dataset").value;
  rawEditing = false;
  clearFilters();
  savePrefs();
  renderAll();
});
$("browse-drive-import").addEventListener("click", () => $("browse-drive-file").click());
$("browse-drive-file").addEventListener("change", async () => {
  const [file] = $("browse-drive-file").files;
  $("browse-drive-file").value = "";
  if (!file) return;
  try { showReport([await importDrive(file)]); } catch (problem) { showReport([`${file.name}: ${problem.message}`], true); }
  videoKey = null;
  renderSources();
  renderVideo();
});
$("browse-drive-clear").addEventListener("click", async () => {
  if (!await confirmAction("Clear the Drive mapping?", "Questions will no longer offer the Drive player until you import a mapping again. Files on Drive are not changed.", "Clear mapping")) return;
  const next = { map: {}, name: "", imported_at: null };
  if (!writeKey(BROWSE_KEYS.drive, next) && !storageBlocked) return;
  drive = next;
  videoKey = null;
  renderSources();
  renderVideo();
});
$("browse-local-pick").addEventListener("click", () => pickLocal(currentLine()?.data?.video_clip_id));
$("browse-local-file").addEventListener("change", () => {
  const files = [...$("browse-local-file").files];
  $("browse-local-file").value = "";
  if (!files.length) return;
  const clip = pendingLocalClip;
  showReport([addLocalClips(files, clip)]);
  const line = currentLine();
  if (clip && line && line.data?.video_clip_id === clip && localClips.has(clip)) { prefs.sources[sourceKey(current(), line)] = "local"; savePrefs(); }
  renderSources();
  renderVideo();
});
$("browse-dismiss-report").addEventListener("click", () => showReport([]));
$("browse-search").addEventListener("input", () => { filters.query = $("browse-search").value; renderList(); renderDetail(); renderVideo(); });
for (const key of ["scenario", "status"]) $(`browse-${key}`).addEventListener("change", () => { filters[key] = $(`browse-${key}`).value; renderList(); renderDetail(); renderVideo(); });
$("browse-hide-answers").addEventListener("change", () => {
  prefs.hide_answers = $("browse-hide-answers").checked;
  $("browse-view").classList.toggle("answers-hidden", prefs.hide_answers);
  savePrefs();
});
$("browse-undo").addEventListener("click", undo);
$("browse-list").addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = [...$("browse-list").querySelectorAll(".browse-item")];
  const position = items.findIndex((item) => item.dataset.index === String(currentIndex()));
  const next = items[Math.max(0, Math.min(items.length - 1, position + (event.key === "ArrowDown" ? 1 : -1)))];
  if (!next) return;
  event.preventDefault();
  select(Number(next.dataset.index));
  next.focus();
});
$("browse-view").addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types?.includes?.("Files")) return;
  event.preventDefault();
  $("browse-view").classList.add("is-dragging");
});
$("browse-view").addEventListener("dragleave", (event) => { if (event.target === $("browse-view") || !$("browse-view").contains(event.relatedTarget)) $("browse-view").classList.remove("is-dragging"); });
$("browse-view").addEventListener("drop", (event) => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  $("browse-view").classList.remove("is-dragging");
  importFiles(event.dataTransfer.files, { localFallback: currentLine()?.data?.video_clip_id ?? null });
});
window.addEventListener("storage", (event) => {
  if (Object.values(BROWSE_KEYS).includes(event.key) && event.key !== BROWSE_KEYS.prefs && !storageBlocked) {
    storageBlocked = true;
    warn("Another tab changed the Browse data. Saving is paused here so neither overwrites the other. Export your QA files, then reload.");
  }
});
window.addEventListener("beforeunload", (event) => {
  if (storageBlocked && datasets.some((item) => item.lines.some(J.isEdited))) { event.preventDefault(); event.returnValue = ""; }
});

restore();
renderFormat();
setTab(prefs.tab, false);
renderAll();
setView(prefs.view, false);
