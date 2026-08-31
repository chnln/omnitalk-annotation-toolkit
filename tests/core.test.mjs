import test from "node:test";
import assert from "node:assert/strict";
import { createProject, createVideo, createClip, parseYouTubeUrl, parseTime, formatTime, validateProject } from "../src/annotation_toolkit/static/core.js";

const ID = "M7lc1UVf-VE";
const canonical = `https://www.youtube.com/watch?v=${ID}`;

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
