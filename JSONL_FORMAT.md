# OmniTalk QA submission format (JSONL)

**Format version: v1.0**

This is the file format the **Browse** view reads, checks and writes: one multiple-choice question per line. It is separate from the [annotation project schema](SCHEMA.md) (schema 1.5), which the **Annotate** view imports and exports as JSON.

The rules below are the ones the app applies. They are defined once, in [`jsonl.js`](src/annotation_toolkit/static/jsonl.js) (`FIELDS`, `RULES`, `FILE_NOTES`, `CHANGELOG`); the **Format** tab in Browse is rendered from that file, and a test checks this document against it. Change both together and add a changelog entry.

## File

- UTF-8 text, one JSON object per line. A byte order mark is ignored; blank lines are skipped and reported.
- Keys keep their order. Keys not listed above are allowed and kept unchanged.
- Times are in the original YouTube video, not in the cut clip.
- Several questions about one clip are separate lines with the same video_clip_id and different question_id.

## Fields

All ten fields are required.

| Field | Type | Constraint | Example |
| --- | --- | --- | --- |
| `video_clip_id` | string | Non-empty, one line. Names the clip; the clip file is <video_clip_id>.mp4. | `Demo-001` |
| `url` | string | YouTube watch URL of the original video: https://www.youtube.com/watch?v=VIDEO_ID. | `https://www.youtube.com/watch?v=M7lc1UVf-VE` |
| `start_time` | string | HH:MM:SS.mmm, time in the original video where the clip starts. | `00:01:58.000` |
| `end_time` | string | HH:MM:SS.mmm, later than start_time. | `00:02:32.000` |
| `duration` | number | Seconds, equal to end_time − start_time to the millisecond, e.g. 34.0. | `34.0` |
| `question_id` | string | Unique in the file; usually <video_clip_id>_Q<n>. | `Demo-001_Q1` |
| `scenario` | array of strings | 1 or 2 distinct scenario category names (list below). | `["Food & Dining"]` |
| `question` | string | Non-empty question text. | `What does the man point at?` |
| `choices` | object | Letters A, B, C… in order mapped to non-empty text; usually 4, sometimes 3 or 5 (2 to 26). | `{"A": "…", "B": "…", "C": "…", "D": "…"}` |
| `correct_answer` | string | One letter that is a key of choices. | `B` |

### Example line

```json
{"video_clip_id": "Demo-001", "url": "https://www.youtube.com/watch?v=M7lc1UVf-VE", "start_time": "00:00:10.000", "end_time": "00:00:44.000", "duration": 34.0, "question_id": "Demo-001_Q1", "scenario": ["Food & Dining"], "question": "Which person orders the soup?", "choices": {"A": "The man in the grey coat", "B": "The woman by the window", "C": "The waiter", "D": "Nobody orders soup"}, "correct_answer": "B"}
```

A small importable sample is in [`examples/omnitalk-qa-example.jsonl`](examples/omnitalk-qa-example.jsonl). It is invented for documentation, not benchmark data.

## Scenario categories

`scenario` uses these names exactly, the same 12 categories as the Annotate view's scenario feature (see [scenario categories](SCHEMA.md#scenario-categories)):

- Social & Personal Interactions
- Everyday Problems & Unexpected Situations
- Food & Dining
- Household & Domestic Activities
- Travel & Navigation
- Education & Training
- Work & Professional Activities
- Entertainment, Recreation & Media
- Health & Well-being
- Public & Service Interactions
- Institutional & Formal Interactions
- Safety & Emergency Situations

## Validation rules

An **error** means the line does not follow the format. A **warning** points at something that is probably a mistake but is allowed.

| Rule | Level | Rule text |
| --- | --- | --- |
| `json` | error | Each non-blank line is one JSON object. |
| `required` | error | All ten fields are present with the listed types. |
| `clip_id` | error | video_clip_id is non-empty text on one line. |
| `url` | error | url is a YouTube link with a valid video ID. |
| `url_form` | warning | url uses the watch form https://www.youtube.com/watch?v=VIDEO_ID, without extra parameters. |
| `time_format` | error | start_time and end_time use HH:MM:SS.mmm, with minutes and seconds below 60. |
| `time_order` | error | end_time is later than start_time. |
| `duration` | error | duration is a number equal to end_time − start_time, to the millisecond. |
| `question_id` | error | question_id is non-empty and unique in the file. |
| `question_id_form` | warning | question_id has the form <video_clip_id>_Q<n>. |
| `scenario` | error | scenario lists 1 or 2 distinct names from the scenario categories. |
| `question` | error | question is non-empty text. |
| `choices` | error | choices has 2 to 26 keys A, B, C… in order, each with non-empty text. |
| `choices_distinct` | warning | No two choices have the same text. |
| `answer` | error | correct_answer is one of the letters in choices. |
| `clip_consistent` | warning | Lines with the same video_clip_id have the same url, start_time, end_time and duration. |

## How Browse reads and writes files

- **Import** keeps every line's original text. A line that is not a JSON object is kept as it is, reported with its line number, and can be fixed in Browse with **Edit line text**.
- **Export** writes each unedited line exactly as it was read, in the original order, with the file's line ending (LF, or CRLF if the file used it) and a final newline. Exporting an unedited import therefore reproduces the file byte for byte, except that a missing final newline is added, a byte order mark is dropped, and blank lines are left out.
- **Edited lines** keep the original text of every field that did not change and the line's separators (`", "` and `": "` in files written by Python's `json.dumps`). Changed fields are written in the same style; a number that replaces one written with a decimal point keeps one, so `duration` stays `34.0` rather than `34`. Key order is kept; non-ASCII text is written as is, not escaped.

## Changelog

Each change to the fields or rules bumps the version: the minor number for a new optional key, a new warning or a relaxed rule; the major number for a new required field or a stricter error.

- **v1.0** (2026-11-22): First documented version: ten required fields, one question per line, the 12 scenario categories.
