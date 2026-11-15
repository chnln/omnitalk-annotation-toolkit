import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createProject, createVideo, createClip, parseYouTubeUrl, parseTime, formatTime, validateProject } from "../src/annotation_toolkit/static/core.js";

const ID = "M7lc1UVf-VE";
const canonical = `https://www.youtube.com/watch?v=${ID}`;

test("shared validator fixtures: core.js agrees with validate_export in downloads.py", () => {
  const { base, aliases, cases } = JSON.parse(readFileSync(new URL("./fixtures/validator_cases.json", import.meta.url), "utf8"));
  for (const { name, valid, set } of cases) {
    const project = structuredClone(base);
    for (const [alias, value] of set) {
      const path = aliases[alias];
      const target = path.slice(0, -1).reduce((node, key) => node[key], project);
      target[path.at(-1)] = value?.$repeat ? value.$repeat[0].repeat(value.$repeat[1]) : value;
    }
    if (valid) assert.doesNotThrow(() => validateProject(project), name);
    else assert.throws(() => validateProject(project), Error, name);
  }
});

test("team text keeps whole seconds inside fractional clip boundaries and converts back (issue #20)", async () => {
  const { createQuestion, createEvidence, formatAnnotation } = await import("../src/annotation_toolkit/static/core.js");
  const render = (start, end, spanStart, spanEnd, clipTime) => {
    const q = createQuestion();
    const e = createEvidence("gesture", { start_seconds: spanStart, end_seconds: spanEnd });
    e.content = "x"; q.annotations = [e];
    return /time_span: (\S+) ~ (\S+)\]/.exec(formatAnnotation(q, { start_seconds: start, end_seconds: end }, { clipTime })).slice(1);
  };
  assert.deepEqual(render(10, 14.25, 10, 14.25, true), ["00:00", "00:04"], "the end stays within a clip of 4.25 s");
  assert.deepEqual(render(10, 14.25, 10, 14.25, false), ["00:10", "00:14"]);
  assert.deepEqual(render(10.5, 14.25, 10.5, 12, false), ["00:11", "00:12"], "the start stays within the clip");
  assert.deepEqual(render(10, 40, 12.2, 12.8, false), ["00:12", "00:13"], "whole-second clips still widen outward");
  assert.deepEqual(render(10, 14.25, 14.1, 14.2, false), ["00:13", "00:14"], "a span in the fractional tail stays nonempty and inside");
  assert.deepEqual(render(10.5, 14.25, 10.5, 10.9, false), ["00:11", "00:12"], "a span in the fractional head stays nonempty and inside");
  assert.deepEqual(render(0, 0.5, 0.1, 0.4, true), ["00:00", "00:01"], "a clip holding no whole-second interval keeps the widened text");

  for (const [start, end, spanStart, spanEnd, clipTime] of [[10, 14.25, 10, 14.25, true], [10, 14.25, 10, 14.25, false], [10.5, 14.25, 10.5, 12, false], [10.5, 14.25, 10.5, 12, true], [10, 14.25, 14.1, 14.2, true], [10.5, 14.75, 13.9, 14.75, true]]) {
    const [from, to] = render(start, end, spanStart, spanEnd, clipTime).map(parseTime);
    const offset = clipTime ? start : 0;
    const q = createQuestion();
    q.required_modalities = ["visual"]; q.evidence_cues = ["gesture"];
    q.annotations = [{ ...createEvidence("gesture"), spans: [{ start_seconds: from + offset, end_seconds: to + offset }] }];
    const project = createProject();
    const video = createVideo(parseYouTubeUrl(ID));
    const clip = createClip({ start_seconds: start, end_seconds: end });
    clip.questions = [q]; video.clips = [clip]; project.videos = [video];
    assert.doesNotThrow(() => validateProject(project), `${start}-${end} clipTime=${clipTime}`);
  }
});

test("common YouTube forms preserve video identity and parse starting times", () => {
  for (const input of [ID, canonical, `http://m.youtube.com/watch?v=${ID}`, `youtube.com/watch?v=${ID}`, `https://youtu.be/${ID}`, `https://www.youtube.com/shorts/${ID}`, `https://youtube.com/embed/${ID}`, `https://www.youtube-nocookie.com/embed/${ID}`, `https://youtube.com/live/${ID}`]) {
    assert.deepEqual(parseYouTubeUrl(input), { video_id: ID, url: canonical, start_seconds: 0 });
  }
  assert.equal(parseYouTubeUrl(`${canonical}&t=1h2m3.5s`).start_seconds, 3723.5);
  assert.equal(parseYouTubeUrl(`https://youtu.be/${ID}?start=62.25`).start_seconds, 62.25);
  assert.equal(parseYouTubeUrl(`${canonical}#t=3m`).start_seconds, 180);
});

test("YouTube parsing rejects untrusted hosts, schemes, identifiers, and timestamps", () => {
  for (const input of [
    `https://youtube.com.evil.example/watch?v=${ID}`, `https://notyoutube.com/watch?v=${ID}`,
    `https://youtube.com@evil.example/watch?v=${ID}`, `https://evil.example@youtube.com/watch?v=${ID}`,
    `ftp://youtube.com/watch?v=${ID}`, `javascript:alert(1)`, `https://youtube.com:8443/watch?v=${ID}`,
    `https://youtube.com/watch?v=bad`, `https://youtu.be/${ID}/extra`, `https://youtube.com/playlist?list=${ID}`,
    `${canonical}&t=Infinity`, `${canonical}&t=NaN`, `${canonical}&t=-1`, `${canonical}&t=`, `${canonical}&start=1e309`,
  ]) assert.throws(() => parseYouTubeUrl(input), Error, input);
});

test("time inputs, millisecond rounding, and hour formatting", () => {
  assert.equal(parseTime("72.125"), 72.125);
  assert.equal(parseTime("01:12.500"), 72.5);
  assert.equal(parseTime("01:02:03.004"), 3723.004);
  assert.equal(parseTime("90:00"), 5400);
  assert.equal(parseTime(12.3456), 12.346);
  assert.equal(formatTime(72.125), "01:12");
  assert.equal(formatTime(3723.004, { milliseconds: true }), "01:02:03.004");
  assert.equal(formatTime(59.9996, { milliseconds: true }), "01:00.000");
  for (const input of ["", "-1", "1e3", "1:2", "01:60", "01:60:00", "01:02.1234", "NaN", Infinity, -1, null]) {
    assert.throws(() => parseTime(input), Error, String(input));
  }
});

test("clip intervals use millisecond boundaries and reject out-of-range data", () => {
  const clip = createClip({ start_seconds: 0, end_seconds: 12.1234 }, 12.1234);
  assert.equal(clip.start_seconds, 0);
  assert.equal(clip.end_seconds, 12.123);
  assert.deepEqual(clip.tags, []);
  for (const interval of [
    { start_seconds: -1, end_seconds: 1 },
    { start_seconds: 2, end_seconds: 2 },
    { start_seconds: 2, end_seconds: 1 },
    { start_seconds: 1, end_seconds: 1.0001 },
    { start_seconds: 0, end_seconds: 13 },
    { start_seconds: NaN, end_seconds: 1 },
    { start_seconds: 0, end_seconds: Infinity },
    { start_seconds: "0", end_seconds: 1 },
  ]) assert.throws(() => createClip(interval, 12), Error);
});

function exampleProject() {
  const project = createProject();
  project.project_name = "双语访谈 / Interviews";
  project.annotator = { id: "A01", name: "研究者" };
  const video = createVideo(parseYouTubeUrl(canonical));
  video.duration_seconds = 120;
  video.clips.push(createClip({ start_seconds: 0, end_seconds: 12.125, note: "中文、emoji 🎤\n<script>alert('not HTML')</script>", tags: ["插话", "gesture"] }, 120));
  project.videos.push(video);
  return project;
}

test("export/import roundtrip preserves Unicode and copies all mutable containers", () => {
  const original = exampleProject();
  const exported = JSON.parse(JSON.stringify({ ...original, exported_at: new Date().toISOString() }));
  const imported = validateProject(exported);
  assert.deepEqual(imported, original);
  imported.annotator.name = "changed";
  imported.videos[0].clips[0].tags.push("new");
  imported.videos[0].clips[0].note = "changed";
  assert.equal(exported.annotator.name, "研究者");
  assert.equal(exported.videos[0].clips[0].tags.length, 2);
  assert.equal(exported.videos[0].clips[0].note, original.videos[0].clips[0].note);
  assert.deepEqual(validateProject(createProject()).videos, []);
});

test("imports reject malformed schema, source metadata, intervals, and duplicate IDs", () => {
  const mutations = [
    (p) => { p.schema_version = "99"; },
    (p) => { p.project_id = "anything"; },
    (p) => { p.project_name = 7; },
    (p) => { p.annotator = []; },
    (p) => { p.annotator.id = null; },
    (p) => { p.created_at = "2026-02-30T01:00:00Z"; },
    (p) => { p.updated_at = "yesterday"; },
    (p) => { p.exported_at = "invalid"; },
    (p) => { p.videos = {}; },
    (p) => { p.videos[0].source = "external"; },
    (p) => { p.videos[0].url = ID; },
    (p) => { p.videos[0].url = "https://evil.example/watch?v=" + ID; },
    (p) => { p.videos[0].url = "https://youtube.com/watch?v=dQw4w9WgXcQ"; },
    (p) => { p.videos[0].video_id = [ID]; },
    (p) => { p.videos[0].duration_seconds = -1; },
    (p) => { p.videos[0].duration_seconds = 0; },
    (p) => { p.videos[0].duration_seconds = Infinity; },
    (p) => { delete p.videos[0].duration_seconds; },
    (p) => { p.videos[0].title = {}; },
    (p) => { p.videos[0].clips = {}; },
    (p) => { p.videos[0].clips[0].start_seconds = null; },
    (p) => { p.videos[0].clips[0].end_seconds = 121; },
    (p) => { p.videos[0].clips[0].note = { html: "<script>" }; },
    (p) => { delete p.videos[0].clips[0].note; },
    (p) => { p.videos[0].clips[0].tags = "tag"; },
    (p) => { p.videos[0].clips[0].tags = [null]; },
    (p) => { p.videos[0].clips[0].id = p.videos[0].id; },
    (p) => { p.videos.push(structuredClone(p.videos[0])); },
  ];
  for (const mutate of mutations) {
    const project = exampleProject();
    mutate(project);
    assert.throws(() => validateProject(project), Error, mutate.toString());
  }
});

test("imports enforce size limits and discard unrecognized JSON fields", () => {
  const tooMany = exampleProject();
  tooMany.videos = Array(1001).fill(tooMany.videos[0]);
  assert.throws(() => validateProject(tooMany), /1000/);
  const tooLong = exampleProject();
  tooLong.videos[0].clips[0].note = "x".repeat(20001);
  assert.throws(() => validateProject(tooLong), /20000/);
  const project = exampleProject();
  const withUnknown = JSON.parse(JSON.stringify(project).replace('"schema_version":', '"__proto__":{"polluted":true},"unexpected":"ignored","schema_version":'));
  const cleaned = validateProject(withUnknown);
  assert.deepEqual(cleaned, project);
  assert.equal(Object.hasOwn(cleaned, "__proto__"), false);
  assert.equal({}.polluted, undefined);
});

test("schema 1.0 migrates without interpreting notes; current schema preserves multiple questions", async () => {
  const { createQuestion } = await import("../src/annotation_toolkit/static/core.js");
  const p = createProject(); const v = createVideo(parseYouTubeUrl("M7lc1UVf-VE"));
  v.clips.push(createClip({start_seconds:0,end_seconds:10,note:"Question: keep this note"})); p.videos.push(v);
  const old = structuredClone(p); old.schema_version = "1.0";
  delete old.videos[0].clips[0].questions; delete old.videos[0].clips[0].subtitle_status;
  const migrated = validateProject(old);
  assert.equal(migrated.schema_version, "1.5");
  assert.equal(migrated.videos[0].clips[0].note, "Question: keep this note");
  assert.deepEqual(migrated.videos[0].clips[0].questions, []);
  v.clips[0].questions.push(createQuestion(), createQuestion());
  assert.deepEqual(validateProject(p), p);
});

test("ready audio-only questions and stable answer IDs survive option reorder", async () => {
  const { createQuestion, validateQuestion } = await import("../src/annotation_toolkit/static/core.js");
  const q = createQuestion(); q.prompt = "Sincere or sarcastic?";
  q.options = q.options.slice(0,2); q.options[0].text="Sincere"; q.options[1].text="Sarcastic";
  q.correct_option_id=q.options[1].id; q.required_modalities=["audio"]; q.evidence_cues=["speech_content","prosody"]; q.status="ready";
  q.options.reverse(); assert.equal(validateQuestion(q).correct_option_id, q.options[0].id);
  q.options.shift(); assert.throws(()=>validateQuestion(q), /existing option/);
});

test("QA validation rejects malformed cues, duplicate IDs and incomplete Ready records", async () => {
  const { createQuestion, validateQuestion } = await import("../src/annotation_toolkit/static/core.js");
  const q=createQuestion(); q.status="ready"; assert.throws(()=>validateQuestion(q), /question/);
  q.status="draft"; q.evidence_cues=["gaze"]; assert.throws(()=>validateQuestion(q), /evidence/);
  q.required_modalities=["visual"]; assert.equal(validateQuestion(q).evidence_cues[0],"gaze");
  const p=createProject(); const v=createVideo(parseYouTubeUrl("M7lc1UVf-VE"));
  v.clips.push(createClip({start_seconds:0,end_seconds:10})); p.videos.push(v);
  v.clips[0].questions=[q,structuredClone(q)]; assert.throws(()=>validateProject(p), /duplicate/);
});

test("1.1 imports attribute clips to the project annotator; 1.2 keeps per-clip annotators", async () => {
  const { createQuestion, annotatorLabel } = await import("../src/annotation_toolkit/static/core.js");
  const p = createProject(); p.annotator = { id: "P001", name: "Leixin" };
  const v = createVideo(parseYouTubeUrl("M7lc1UVf-VE"));
  v.clips.push(createClip({ start_seconds: 0, end_seconds: 10 }, null, { id: "P002", name: "Nan" }));
  v.clips[0].questions.push(createQuestion());
  p.videos.push(v);
  const current = validateProject(structuredClone(p));
  assert.deepEqual(current.videos[0].clips[0].annotator, { id: "P002", name: "Nan" });
  assert.equal(Object.hasOwn(current.videos[0].clips[0].questions[0], "annotator"), false, "questions carry no annotator");
  const old = structuredClone(p); old.schema_version = "1.1";
  delete old.videos[0].clips[0].annotator;
  const migrated = validateProject(old);
  assert.deepEqual(migrated.videos[0].clips[0].annotator, { id: "P001", name: "Leixin" });
  migrated.videos[0].clips[0].annotator.name = "changed";
  assert.equal(migrated.annotator.name, "Leixin", "records must not share the project annotator object");
  for (const mutate of [
    (x) => { delete x.videos[0].clips[0].annotator; },
    (x) => { x.videos[0].clips[0].annotator = "Nan"; },
    (x) => { x.videos[0].clips[0].annotator.id = 7; },
    (x) => { x.videos[0].clips[0].annotator.name = "x".repeat(201); },
  ]) {
    const broken = structuredClone(p); mutate(broken);
    assert.throws(() => validateProject(broken), Error, mutate.toString());
  }
  assert.equal(annotatorLabel({ id: "P1", name: "Nan" }), "Nan (P1)");
  assert.equal(annotatorLabel({ id: "P1", name: " " }), "P1");
  assert.equal(annotatorLabel({ id: "", name: "" }), "");
});

test("1.3 clips carry a trimmed single-line reference ID; older schemas migrate to an empty one", async () => {
  const p = createProject(); const v = createVideo(parseYouTubeUrl("M7lc1UVf-VE"));
  v.clips.push(createClip({ ref_id: "  R4-C06 ", start_seconds: 0, end_seconds: 10, note: "Clip ID: R4-C06", tags: ["R4-C06"] }, null, { id: "", name: "Nan" }));
  p.videos.push(v);
  assert.equal(v.clips[0].ref_id, "R4-C06");
  assert.equal(validateProject(structuredClone(p)).videos[0].clips[0].ref_id, "R4-C06");
  assert.equal(createClip({ start_seconds: 0, end_seconds: 1 }).ref_id, "", "the field is optional when creating a clip");
  const old = structuredClone(p); old.schema_version = "1.2"; delete old.videos[0].clips[0].ref_id;
  const migrated = validateProject(old);
  assert.equal(migrated.videos[0].clips[0].ref_id, "", "notes and tags are never parsed for a reference ID");
  assert.deepEqual(migrated.videos[0].clips[0].annotator, { id: "", name: "Nan" }, "1.2 keeps per-clip annotators");
  for (const mutate of [
    (x) => { delete x.videos[0].clips[0].ref_id; },
    (x) => { x.videos[0].clips[0].ref_id = null; },
    (x) => { x.videos[0].clips[0].ref_id = "R4\nC06"; },
    (x) => { x.videos[0].clips[0].ref_id = "x".repeat(101); },
  ]) {
    const broken = structuredClone(p); mutate(broken);
    assert.throws(() => validateProject(broken), Error, mutate.toString());
  }
});

test("reference IDs are listed per video, searchable in the library, and checked for reuse", async () => {
  const { filterVideos, videoRefIds, refIdConflicts } = await import("../src/annotation_toolkit/static/core.js");
  const a = createVideo(parseYouTubeUrl("M7lc1UVf-VE")); const b = createVideo(parseYouTubeUrl("jNQXAC9IVRw"));
  a.clips.push(createClip({ ref_id: "R5-14", start_seconds: 20, end_seconds: 30 }), createClip({ ref_id: "R5-13", start_seconds: 0, end_seconds: 10 }), createClip({ start_seconds: 40, end_seconds: 50 }));
  b.clips.push(createClip({ start_seconds: 0, end_seconds: 5 }));
  assert.deepEqual(videoRefIds(a), ["R5-13", "R5-14"], "time order, empty IDs omitted");
  assert.deepEqual(videoRefIds(b), []);
  assert.deepEqual(filterVideos([a, b], { query: "r5-14" }), [a]);
  assert.deepEqual(filterVideos([a, b], { query: "jNQXAC9IVRw" }), [b]);
  assert.equal(refIdConflicts([a, b], "r5-14").length, 1);
  assert.equal(refIdConflicts([a, b], "R5-14", a.clips[0].id).length, 0, "a clip does not conflict with itself");
  assert.equal(refIdConflicts([a, b], "").length, 0, "clips without IDs never conflict");
});

test("library filters combine title/ID text, annotator, and question status", async () => {
  const { createQuestion, filterVideos, projectAnnotators } = await import("../src/annotation_toolkit/static/core.js");
  const nan = { id: "", name: "Nan" }; const erik = { id: "E1", name: "Erik" };
  const video = (id, title) => { const v = createVideo(parseYouTubeUrl(id)); v.title = title; return v; };
  const a = video("M7lc1UVf-VE", "Dinner date");
  a.clips.push(createClip({ start_seconds: 0, end_seconds: 5, tags: ["range-fix"] }, null, nan));
  a.clips.push(createClip({ start_seconds: 5, end_seconds: 8 }, null, erik));
  const ready = createQuestion(); ready.status = "ready"; a.clips[0].questions.push(ready); a.clips[1].questions.push(structuredClone(ready));
  a.clips[1].questions[0].id = crypto.randomUUID();
  const b = video("jNQXAC9IVRw", "Taskmaster");
  b.clips.push(createClip({ start_seconds: 0, end_seconds: 5 }, null, nan), createClip({ start_seconds: 5, end_seconds: 9 }));
  b.clips[0].questions.push(createQuestion());
  const c = video("dQw4w9WgXcQ", "Empty video");
  const all = [a, b, c];
  const ids = (filters) => filterVideos(all, filters).map((v) => v.title);
  assert.deepEqual(ids({}), ["Dinner date", "Taskmaster", "Empty video"]);
  assert.deepEqual(ids({ query: "TASK" }), ["Taskmaster"]);
  assert.deepEqual(ids({ query: "dQw4" }), ["Empty video"]);
  const authors = projectAnnotators(all);
  assert.deepEqual(authors.map((x) => x.label), ["Erik (E1)", "Nan", ""]);
  assert.deepEqual(ids({ annotator: authors[0].key }), ["Dinner date"]);
  assert.deepEqual(ids({ annotator: authors[2].key }), ["Taskmaster"], "unattributed clips are filterable");
  assert.deepEqual(ids({ status: "has-drafts" }), ["Taskmaster"]);
  assert.deepEqual(ids({ status: "all-ready" }), ["Dinner date"]);
  assert.deepEqual(ids({ status: "missing-questions" }), ["Taskmaster"]);
  assert.deepEqual(ids({ status: "no-clips" }), ["Empty video"]);
  assert.deepEqual(ids({ annotator: authors[1].key, status: "all-ready" }), ["Dinner date"]);
  assert.deepEqual(ids({ annotator: authors[0].key, query: "task" }), []);
});

test("1.4 questions carry time-spanned evidence; 1.3 migrates with none; spans stay inside the clip", async () => {
  const { createQuestion, createEvidence, formatAnnotation, spansOutside, cueModality } = await import("../src/annotation_toolkit/static/core.js");
  const p = createProject(); const v = createVideo(parseYouTubeUrl(ID));
  const clip = createClip({ start_seconds: 60, end_seconds: 90 });
  const q = createQuestion();
  Object.assign(q, { required_modalities: ["audio", "visual"], evidence_cues: ["speech_content", "vocalization", "gesture"] });
  const speech = createEvidence("speech_content", { start_seconds: 61, end_seconds: 63.5 });
  speech.content = "Woman: “Is that sugar?”";
  const gesture = createEvidence("gesture", { start_seconds: 64, end_seconds: 65 });
  gesture.spans.push({ start_seconds: 70, end_seconds: 72 });
  Object.assign(gesture, { content: "Man points at the jar", function: "identifies what “that” refers to" });
  q.annotations.push(speech, gesture); clip.questions.push(q); v.clips.push(clip); p.videos.push(v);
  assert.equal(cueModality("vocalization"), "audio");
  assert.deepEqual(validateProject(structuredClone(p)).videos[0].clips[0].questions[0].annotations, q.annotations);

  assert.equal(formatAnnotation(q, clip), [
    "Annotation:",
    "(speech content): Woman: “Is that sugar?” [time_span: 01:01 ~ 01:04]",
    "(gesture): Man points at the jar [time_span: 01:04 ~ 01:05] & [time_span: 01:10 ~ 01:12]",
    "Function of non-speech content to communication:",
    "(gesture) identifies what “that” refers to",
  ].join("\n"));
  assert.match(formatAnnotation(q, clip, { clipTime: true }), /\(gesture\): Man points at the jar \[time_span: 00:04 ~ 00:05\] & \[time_span: 00:10 ~ 00:12\]/);
  assert.equal(spansOutside(clip, 60, 90), 0);
  assert.equal(spansOutside(clip, 62, 71), 2, "the speech span starts before 62 and the second gesture span ends after 71");

  const old = structuredClone(p); old.schema_version = "1.3"; delete old.videos[0].clips[0].questions[0].annotations;
  assert.deepEqual(validateProject(old).videos[0].clips[0].questions[0].annotations, []);
  const legacyExtra = structuredClone(p); legacyExtra.schema_version = "1.3";
  assert.deepEqual(validateProject(legacyExtra).videos[0].clips[0].questions[0].annotations, [], "1.3 never carried evidence");

  const ready = structuredClone(p); const rq = ready.videos[0].clips[0].questions[0];
  Object.assign(rq, { prompt: "What is in the jar?", options: rq.options.map((o, i) => ({ ...o, text: `Option ${i}` })), status: "ready" });
  rq.correct_option_id = rq.options[0].id;
  assert.equal(validateProject(structuredClone(ready)).videos[0].clips[0].questions[0].status, "ready");
  for (const mutate of [
    (e) => { e.spans = []; },
    (e) => { e.content = "  "; },
  ]) {
    const broken = structuredClone(ready); mutate(broken.videos[0].clips[0].questions[0].annotations[1]);
    assert.throws(() => validateProject(broken), /evidence line needs content/, mutate.toString());
  }
  for (const mutate of [
    (q) => { delete q.annotations; },
    (q) => { q.annotations = {}; },
    (q) => { q.annotations[0].cue = "smell"; },
    (q) => { q.annotations[0].cue = "prosody"; },
    (q) => { q.annotations[0].id = "x"; },
    (q) => { q.annotations[1].id = q.annotations[0].id; },
    (q) => { q.annotations[0].content = null; },
    (q) => { q.annotations[0].function = "x".repeat(2001); },
    (q) => { q.annotations[0].spans = {}; },
    (q) => { q.annotations[0].spans = Array.from({ length: 21 }, () => ({ start_seconds: 61, end_seconds: 62 })); },
    (q) => { q.annotations[0].spans[0].end_seconds = 61; },
    (q) => { q.annotations[0].spans[0].start_seconds = 59; },
    (q) => { q.annotations[0].spans[0].end_seconds = 90.5; },
    (q) => { q.annotations[0].spans[0].start_seconds = "61"; },
    (q) => { q.annotations = Array.from({ length: 51 }, () => createEvidence("gesture")); },
  ]) {
    const broken = structuredClone(p); mutate(broken.videos[0].clips[0].questions[0]);
    assert.throws(() => validateProject(broken), Error, mutate.toString());
  }
  assert.throws(() => createEvidence("smell"), /Unknown evidence cue/);
  assert.throws(() => createEvidence("gesture", { start_seconds: 40, end_seconds: 40 }), /Span end must be after its start/);
});

test("1.5 clips carry distinct known scenario categories; files before 1.5 migrate with none", async () => {
  const { SCENARIOS } = await import("../src/annotation_toolkit/static/core.js");
  assert.equal(Object.keys(SCENARIOS).length, 12);
  assert.equal(SCENARIOS.entertainment_recreation_media, "Entertainment, Recreation & Media");
  const p = createProject(); const v = createVideo(parseYouTubeUrl(ID));
  v.clips.push(createClip({ start_seconds: 0, end_seconds: 10, ref_id: "R9-01", scenarios: ["food_dining", "everyday_problems"] })); p.videos.push(v);
  assert.deepEqual(createClip({ start_seconds: 0, end_seconds: 1 }).scenarios, [], "a new clip starts without a scenario");
  assert.deepEqual(validateProject(structuredClone(p)).videos[0].clips[0].scenarios, ["food_dining", "everyday_problems"], "the file's order is kept");
  const broken = (value) => { const copy = structuredClone(p); copy.videos[0].clips[0].scenarios = value; return copy; };
  assert.deepEqual(validateProject(broken([])).videos[0].clips[0].scenarios, [], "no suitable label is an empty selection");
  assert.throws(() => validateProject(broken(["food_dining", "food_dining"])), /same scenario category twice/);
  assert.throws(() => validateProject(broken(["cooking"])), /Unknown scenario category: "cooking"/);
  assert.throws(() => validateProject(broken(["Food & Dining"])), /Unknown scenario category/, "display names are not IDs");
  assert.throws(() => validateProject(broken(["constructor"])), /Unknown scenario category/);
  assert.throws(() => validateProject(broken("food_dining")), /must be an array/);
  assert.throws(() => validateProject(broken(null)), /must be an array/);
  const missing = structuredClone(p); delete missing.videos[0].clips[0].scenarios;
  assert.throws(() => validateProject(missing), /must contain a scenarios array/);
  assert.throws(() => createClip({ start_seconds: 0, end_seconds: 1, scenarios: ["x"] }), /Unknown scenario category/);
  for (const version of ["1.0", "1.1", "1.2", "1.3", "1.4"]) {
    const old = structuredClone(p); old.schema_version = version;
    old.videos[0].clips[0].scenarios = "ignored before 1.5";
    if (version === "1.0") { delete old.videos[0].clips[0].questions; delete old.videos[0].clips[0].subtitle_status; }
    const clip = validateProject(old).videos[0].clips[0];
    assert.deepEqual(clip.scenarios, [], version);
    assert.equal(clip.ref_id, ["1.3", "1.4"].includes(version) ? "R9-01" : "", `${version} keeps ref_id only where it existed`);
  }
});

test("1.4 files keep ref IDs and evidence; action_event and object_scene become action and object, de-duplicated", async () => {
  const { createQuestion, createEvidence, MODALITIES, LEGACY_CUE_RENAMES } = await import("../src/annotation_toolkit/static/core.js");
  assert.deepEqual(LEGACY_CUE_RENAMES, { action_event: "action", object_scene: "object" });
  assert.deepEqual(Object.keys(MODALITIES.audio.cues), ["speech_content", "prosody", "environmental_sounds", "voice_characteristics", "vocalization"]);
  assert.deepEqual(Object.keys(MODALITIES.visual.cues), ["scene", "action", "event", "gesture", "facial_expression", "gaze", "person_appearance", "object"]);
  assert.deepEqual(Object.values(MODALITIES.visual.cues), ["Scene", "Action", "Event", "Body Gesture", "Facial Expression", "Gaze", "Human Status & Appearance", "Object"]);
  assert.equal(MODALITIES.text.cues.scene_text, "Written language");
  const p = createProject(); p.schema_version = "1.4";
  const v = createVideo(parseYouTubeUrl(ID));
  const clip = createClip({ start_seconds: 60, end_seconds: 90, ref_id: "R8-03" }); delete clip.scenarios;
  const q = createQuestion();
  Object.assign(q, { required_modalities: ["audio", "visual"], evidence_cues: ["speech_content", "action_event", "action", "object_scene", "gesture"] });
  const act = { ...createEvidence("gesture", { start_seconds: 61, end_seconds: 62 }), cue: "action_event", content: "hands over a cup", function: "f" };
  const obj = { ...createEvidence("gesture", { start_seconds: 63, end_seconds: 64 }), cue: "object_scene", content: "the cup" };
  const kept = { ...createEvidence("gesture", { start_seconds: 65, end_seconds: 66 }), content: "points" };
  q.annotations.push(act, obj, kept); clip.questions.push(q); v.clips.push(clip); p.videos.push(v);
  const migrated = validateProject(structuredClone(p));
  assert.equal(migrated.schema_version, "1.5");
  const mc = migrated.videos[0].clips[0]; const mq = mc.questions[0];
  assert.equal(mc.ref_id, "R8-03"); assert.deepEqual(mc.scenarios, []);
  assert.deepEqual(mq.evidence_cues, ["speech_content", "action", "object", "gesture"], "renamed in place, duplicates dropped");
  assert.deepEqual(mq.annotations.map((e) => e.cue), ["action", "object", "gesture"]);
  assert.deepEqual(mq.annotations.map((e) => [e.content, e.function, e.spans]), q.annotations.map((e) => [e.content, e.function, e.spans]));
  assert.deepEqual(validateProject(structuredClone(migrated)), migrated, "the migrated project is valid 1.5 and unchanged by a second pass");
  const current = structuredClone(p); current.schema_version = "1.5"; current.videos[0].clips[0].scenarios = [];
  assert.throws(() => validateProject(current), /Invalid evidence cues/, "1.5 files may not use the split cues");
  const strayEvidence = structuredClone(p); strayEvidence.videos[0].clips[0].questions[0].annotations[2].cue = "event";
  assert.throws(() => validateProject(strayEvidence), /must also be selected/);

  const example = JSON.parse(readFileSync(new URL("../examples/annotation-project-1.4.json", import.meta.url), "utf8"));
  const fromExample = validateProject(example).videos[0].clips[0];
  assert.deepEqual(fromExample.questions[0].evidence_cues, ["speech_content", "action"]);
  assert.deepEqual(fromExample.questions[0].annotations.map((e) => e.cue), ["speech_content", "action"]);
  assert.equal(fromExample.ref_id, "PILOT-01");
});
