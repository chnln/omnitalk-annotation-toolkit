import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as j from "../src/annotation_toolkit/static/jsonl.js";
import { SCENARIOS } from "../src/annotation_toolkit/static/core.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const example = read("../examples/omnitalk-qa-example.jsonl");
const bad = read("./fixtures/qa_bad_lines.jsonl");
const load = (text) => { const parsed = j.parseJsonl(text); return { ...parsed, style: j.detectStyle(parsed.lines) }; };
const rules = (problems) => problems.map((item) => item.rule).sort();

test("an unedited import exports byte for byte, keeping extra keys and 3-, 4- and 5-choice lines", () => {
  const dataset = load(example);
  assert.equal(dataset.lines.length, 4);
  assert.deepEqual(dataset.lines.map((line) => Object.keys(line.data.choices).length), [4, 3, 5, 4]);
  assert.equal(dataset.lines[3].data.reviewer_note, "Kept: the gesture contradicts the words.");
  assert.equal(j.exportJsonl(dataset), example);
  assert.equal(j.exportJsonl(load(example.trimEnd())), example, "only a final newline is added");
  assert.equal(j.exportJsonl(load(`﻿${example}`)), example, "a byte order mark is dropped");
  const crlf = example.replace(/\n/g, "\r\n");
  assert.equal(j.exportJsonl(load(crlf)), crlf, "CRLF files keep CRLF");
  const { summary } = j.validateDataset(dataset.lines);
  assert.deepEqual(summary, { lines: 4, errorLines: 0, warningLines: 0, byRule: {} });
});

test("an edited line keeps its separators, key order, untouched fields, extra keys and float-looking duration", () => {
  const dataset = load(example);
  const line = dataset.lines[3];
  j.editLine(line, (data) => { data.question = "Où vont-ils ?"; data.duration = 25; }, dataset.style);
  assert.ok(j.isEdited(line));
  assert.equal(line.raw, line.original.replace("Which way does the passer-by tell them to go?", "Où vont-ils ?"));
  assert.deepEqual(Object.keys(line.data), [...j.FIELD_NAMES, "reviewer_note"]);
  j.editLine(line, (data) => { data.question = "Which way does the passer-by tell them to go?"; }, dataset.style);
  assert.equal(line.raw, line.original, "editing back restores the original text");
  assert.ok(!j.isEdited(line));
  j.editLine(line, (data) => { data.choices.E = "Up the stairs"; }, dataset.style);
  assert.match(line.raw, /"D": "Right at the bridge", "E": "Up the stairs"\}, "correct_answer": "D", "reviewer_note"/);
  const compact = '{"video_clip_id":"X-1","duration":2.5,"extra":{"a":1}}';
  const record = j.parseJsonl(compact).lines[0];
  j.editLine(record, (data) => { data.duration = 3; }, j.detectStyle([record]));
  assert.equal(record.raw, '{"video_clip_id":"X-1","duration":3.0,"extra":{"a":1}}');
});

test("bad lines are reported with line numbers, kept for export, and can be fixed", () => {
  const dataset = load(bad);
  assert.deepEqual(dataset.blank, [3]);
  assert.deepEqual(dataset.malformed.map((item) => item.number), [2, 5]);
  assert.deepEqual(dataset.lines.map((line) => line.number), [1, 2, 4, 5]);
  assert.equal(j.exportJsonl(dataset), bad.replace("\n\n", "\n"), "malformed lines are written back verbatim, blank lines dropped");
  const { problems, summary } = j.validateDataset(dataset.lines);
  assert.deepEqual(rules(problems[1]), ["json"]);
  assert.deepEqual(rules(problems[3]), ["json"]);
  assert.deepEqual(rules(problems[2]), ["answer", "choices", "choices_distinct", "question", "question_id", "question_id_form", "scenario", "time_format", "url_form"].sort());
  assert.ok(problems[0].some((item) => item.rule === "question_id" && /line 4/.test(item.message)), "duplicate IDs name the other line");
  assert.equal(summary.errorLines, 4);
  assert.throws(() => j.editLine(dataset.lines[1], () => {}), /not valid JSON/);
  j.setLineRaw(dataset.lines[1], dataset.lines[0].raw.replace(/Demo-001/g, "Demo-002"));
  assert.equal(j.validateDataset(dataset.lines).problems[1].length, 0);
});

test("validator: times, duration, choices with 3 or 5 letters, answers, scenarios and clip consistency", () => {
  const base = j.parseJsonl(example).lines[0].data;
  const check = (change) => { const data = structuredClone(base); change(data); return rules(j.validateRecord(data)); };
  assert.deepEqual(check(() => {}), []);
  assert.deepEqual(check((d) => { d.end_time = "00:00:10.000"; }), ["time_order"]);
  assert.deepEqual(check((d) => { d.start_time = "00:00:10"; }), ["time_format"]);
  assert.deepEqual(check((d) => { d.end_time = "00:60:00.000"; }), ["time_format"]);
  assert.deepEqual(check((d) => { d.duration = 34.001; }), ["duration"]);
  assert.deepEqual(check((d) => { d.duration = "34.0"; }), ["required"]);
  assert.deepEqual(check((d) => { delete d.question; }), ["required"]);
  assert.deepEqual(check((d) => { delete d.choices.D; }), [], "3 choices are fine");
  assert.deepEqual(check((d) => { d.choices.E = "Fifth"; }), [], "5 choices are fine");
  assert.deepEqual(check((d) => { d.correct_answer = "E"; }), ["answer"]);
  assert.deepEqual(check((d) => { d.choices = { A: "only" }; d.correct_answer = "A"; }), ["choices"]);
  assert.deepEqual(check((d) => { d.scenario = []; }), ["scenario"]);
  assert.deepEqual(check((d) => { d.scenario = ["Food & Dining", "Travel & Navigation", "Health & Well-being"]; }), ["scenario"]);
  assert.deepEqual(check((d) => { d.scenario = ["Food and Dining"]; }), ["scenario"]);
  assert.deepEqual(check((d) => { d.url = "https://example.com/watch?v=M7lc1UVf-VE"; }), ["url"]);
  assert.deepEqual(check((d) => { d.question_id = "Q1"; }), ["question_id_form"]);
  assert.equal(j.expectedDuration({ start_time: "00:01:05.250", end_time: "00:01:31.550" }), 26.3);
  assert.equal(j.formatClock(j.parseClock("01:02:03.004")), "01:02:03.004");
  const lines = j.parseJsonl(example).lines;
  lines[1].data.end_time = "00:00:45.000"; lines[1].data.duration = 35;
  const { problems } = j.validateDataset(lines);
  assert.deepEqual(rules(problems[0]), ["clip_consistent"]);
  assert.deepEqual(rules(problems[1]), ["clip_consistent"]);
});

test("removing a choice re-letters the rest and the answer follows its choice", () => {
  const data = { choices: { A: "a", B: "b", C: "c", D: "d" }, correct_answer: "C" };
  j.removeChoice(data, "A");
  assert.deepEqual(data, { choices: { A: "b", B: "c", C: "d" }, correct_answer: "B" });
  j.removeChoice(data, "B");
  assert.deepEqual(data, { choices: { A: "b", B: "d" }, correct_answer: "" });
  j.addChoice(data);
  assert.deepEqual(Object.keys(data.choices), ["A", "B", "C"]);
});

test("filters by clip ID, text, scenario and status", () => {
  const lines = j.parseJsonl(bad).lines;
  const { problems } = j.validateDataset(lines);
  const all = j.parseJsonl(example).lines;
  const clean = j.validateDataset(all).problems;
  assert.deepEqual(j.filterLines(all, clean, { query: "demo-002" }), [2]);
  assert.deepEqual(j.filterLines(all, clean, { query: "bread basket" }), [1]);
  assert.deepEqual(j.filterLines(all, clean, { scenario: "Work & Professional Activities" }), [2]);
  assert.deepEqual(j.filterLines(lines, problems, { status: "errors" }), [0, 1, 2, 3]);
  assert.deepEqual(j.filterLines(all, clean, { status: "ok" }), [0, 1, 2, 3]);
  j.editLine(all[0], (data) => { data.question = "Changed"; });
  assert.deepEqual(j.filterLines(all, clean, { status: "edited" }), [0]);
});

test("Drive mappings: object form, Drive listing form with folders, duplicates and bad IDs", () => {
  const object = j.parseDriveMapping(JSON.parse(read("../examples/drive-mapping-example.json")));
  assert.deepEqual(Object.keys(object.map), ["Demo-001", "Demo-002"]);
  const listing = j.parseDriveMapping([
    { title: "catalog", id: "11guVECmb-folder-0000", mimeType: "application/vnd.google-apps.folder" },
    { title: "Demo-001.mp4", id: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345", mimeType: "video/mp4" },
    { title: "Demo-001.mp4", id: "1ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", mimeType: "video/mp4" },
    { title: "notes.txt", id: "1CcDeFgHiJkLmNoPqRsTuVwXyZ0123456" },
    { title: "Demo-003.mp4", id: "bad id" },
  ]);
  assert.deepEqual(listing.map, { "Demo-001": "1ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ" });
  assert.deepEqual(listing.duplicates, ["Demo-001"]);
  assert.deepEqual(listing.skipped, ["catalog", "notes.txt", "Demo-003.mp4"]);
  assert.throws(() => j.parseDriveMapping("x"), /Expected an object/);
  assert.equal(j.drivePreviewUrl("1AbC"), "https://drive.google.com/file/d/1AbC/preview");
  const links = j.youtubeLinks({ url: "https://www.youtube.com/watch?v=M7lc1UVf-VE", start_time: "00:01:05.250", end_time: "00:01:31.550" });
  assert.equal(links.watch, "https://www.youtube.com/watch?v=M7lc1UVf-VE&t=65s");
  assert.equal(links.embed, "https://www.youtube.com/embed/M7lc1UVf-VE?start=65&playsinline=1&rel=0&hl=en&end=92");
  assert.equal(j.youtubeLinks({ url: "nope" }), null);
});

test("JSONL_FORMAT.md matches the spec the validator and Format tab use", () => {
  const doc = read("../JSONL_FORMAT.md");
  assert.ok(doc.includes(`**Format version: v${j.FORMAT_VERSION}**`));
  for (const field of j.FIELDS) assert.ok(doc.includes(`| \`${field.name}\` | ${field.type} | ${field.constraint} | \`${field.example}\` |`), field.name);
  for (const rule of j.RULES) assert.ok(doc.includes(`| \`${rule.id}\` | ${rule.level} | ${rule.text} |`), rule.id);
  for (const note of j.FILE_NOTES) assert.ok(doc.includes(`- ${note}`), note);
  for (const name of j.SCENARIO_NAMES) assert.ok(doc.includes(`- ${name}\n`), name);
  for (const entry of j.CHANGELOG) assert.ok(doc.includes(`- **v${entry.version}** (${entry.date}): ${entry.changes.join(" ")}`), entry.version);
  assert.ok(doc.includes(j.EXAMPLE_LINE));
  assert.equal(example.split("\n")[0], j.EXAMPLE_LINE, "the documented example is the sample file's first line");
  assert.deepEqual(j.SCENARIO_NAMES, Object.values(SCENARIOS));
  assert.equal(j.SCENARIO_NAMES.length, 12);
});

test("re-lettering choices keeps their order and moves the answer with its choice", () => {
  const data = { choices: { A: "Left", C: "Right", D: "Up" }, correct_answer: "D" };
  assert.ok(!j.choicesInOrder(data.choices));
  j.reletterChoices(data);
  assert.deepEqual(data, { choices: { A: "Left", B: "Right", C: "Up" }, correct_answer: "C" });
  assert.ok(j.choicesInOrder(data.choices));
});
