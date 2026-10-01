# Annotation JSON import specification (schema 1.3)

Use this specification when generating annotations with scripts, models, or manual editing. An import file contains **one project**, with the hierarchy **project → videos → clips → questions → options**. Research catalogs and flat QA arrays require conversion before import.

The executable source of truth is [core.js](src/annotation_toolkit/static/core.js): `validateProject`, `validateQuestion`, `MODALITIES`, and `SUBTITLE_STATUSES`. Local exports are also checked by `validate_export` in [downloads.py](src/annotation_toolkit/downloads.py). Keep this document and the [README schema overview](README.md#annotation-json-schema) aligned with those implementations.

## Importable example

[examples/annotation-project-1.3.json](examples/annotation-project-1.3.json) contains one project, one YouTube video, one clip, and one Draft question with two options. It demonstrates structure; its question and answer are illustrative and have not been verified against the video. For a new project, generate fresh record UUIDs and replace the source, interval, and annotation content.

## Required fields

Every field in the following tables is required unless explicitly marked optional. An optional UI input means its value may be empty; the JSON field must still exist. Only the project's `exported_at` field may be omitted.

String limits below follow JavaScript UTF-16 code-unit counting, rather than byte counts. Unless a nonempty value is explicitly required, a string may be `""`.

### Project: the root object

The root must be an object, not an array of questions or projects.

| Field | Type and constraints |
| --- | --- |
| `schema_version` | The string `"1.3"`, not the number `1.3`. |
| `project_id` | A UUID string, not a project name or business identifier. |
| `project_name` | String, maximum 200. |
| `annotator` | Object containing `id` and `name`, both strings, maximum 200 each. Either may be empty. This `id` does not need to be a UUID. |
| `created_at`, `updated_at` | Date-time strings with explicit time zones. |
| `videos` | Array; may be `[]`. Maximum 1,000 video records. |
| `exported_at` | **Optional** date-time string. Validated on import and regenerated on the next export. |

An unattributed annotator is represented as `{"id": "", "name": ""}`, not a missing object or missing fields.

### Video: `videos[]`

| Field | Type and constraints |
| --- | --- |
| `id` | Video record UUID, distinct from the YouTube `video_id`. |
| `source` | The string `"youtube"`. |
| `video_id` | An 11-character string containing only ASCII letters, digits, `_`, and `-`. |
| `url` | A full YouTube HTTP(S) video URL matching `video_id`. Generated files should use `https://www.youtube.com/watch?v=VIDEO_ID`. |
| `title` | String, maximum 500. |
| `duration_seconds` | Duration of the **original video**: a positive finite number that remains positive after millisecond rounding, or `null` if unknown. Do not use the downloaded clip's duration. |
| `created_at` | Date-time string with a time zone. |
| `clips` | Array; may be `[]`. Maximum 10,000 clips per video and 50,000 clips per project. |

The frontend also accepts full YouTube short links and shorts/embed/live URLs and normalizes them. Generators should use the canonical URL above, which the local export validator requires. A syntactically valid video ID does not establish that the video exists or matches the research source.

### Clip: `videos[].clips[]`

| Field | Type and constraints |
| --- | --- |
| `id` | Clip record UUID, not a business identifier. |
| `ref_id` | Your own reference ID for the clip, such as `R3-I08`, or `""` when there is none. String, maximum 100, one line; surrounding spaces are removed on import. Shown in the library, clip table and question panel, and searchable. Duplicates are allowed but flagged when saving in the app. |
| `start_seconds`, `end_seconds` | Numeric seconds measured from the beginning of the **original YouTube video**. Clock strings such as `"00:46"` are not accepted here. |
| `annotator` | Same object structure as the project annotator; records who created the clip. Both fields are required. |
| `note` | String, maximum 20,000; use `""` when empty. |
| `tags` | Array of strings; use `[]` when empty. Maximum 50 entries, each maximum 100 and not empty or whitespace-only. |
| `subtitle_status` | One of `"unknown"`, `"none"`, `"present"`, `"masked"`. |
| `questions` | Array; use `[]` when empty. Maximum 100 questions per clip. |
| `created_at`, `updated_at` | Date-time strings with time zones. |

Times must be finite and nonnegative. After rounding to milliseconds, they must satisfy `start_seconds < end_seconds`. When the original video duration is known, `end_seconds` must not exceed it. Numeric seconds must not exceed `Number.MAX_SAFE_INTEGER / 1000`.

If an annotation window is relative to a downloaded MP4 clip, convert it before import:

```text
import start = source-video start of the downloaded clip + clip-relative start
import end   = source-video start of the downloaded clip + clip-relative end
```

For example, a downloaded clip starting at source second 205 with a local window `00:46–00:54` yields source boundaries `251–259`. First establish which time base the annotation uses, and check that the window fits inside the analyzed clip. A URL's `t=` parameter does not replace the numeric clip boundaries.

Subtitle statuses describe the media:

| Value | Meaning |
| --- | --- |
| `unknown` | Not reviewed. |
| `none` | Reviewed and no subtitles are present. |
| `present` | Subtitles are present. |
| `masked` | Subtitles have already been masked. |

`clean` is not a supported value and does not, by itself, establish any of these states. The status field does not mask or process the video.

### Question: `videos[].clips[].questions[]`

| Field | Type and constraints |
| --- | --- |
| `id` | Question UUID. |
| `prompt` | Question string, maximum 10,000. |
| `options` | Array of at most 26 option objects. Each object requires UUID `id` and string `text` (maximum 5,000). |
| `correct_option_id` | The UUID of an option in **this question**, or `null` when no answer is selected. An answer letter, numeric index, or answer text is not accepted. |
| `required_modalities` | Array selecting from `audio`, `visual`, `text`; no duplicates. |
| `evidence_cues` | Array selecting from the table below; no duplicates. Every cue's parent modality must also be selected. Use `[]` when no specific cues are selected. |
| `rationale` | Explanation string, maximum 20,000; use `""` when empty. |
| `status` | `"draft"` or `"ready"`. |
| `created_at`, `updated_at` | Date-time strings with time zones. |

| Parent modality | Accepted evidence cues |
| --- | --- |
| `audio` | `speech_content`, `prosody`, `environmental_sounds` |
| `visual` | `action_event`, `gesture`, `facial_expression`, `gaze`, `person_appearance`, `object_scene` |
| `text` | `subtitles`, `scene_text` |

Use the exact enum strings, including the plural in `environmental_sounds`. For example, `gaze` requires `visual` in `required_modalities`. Visible subtitles do not automatically make `text` a required modality. Question and option text themselves do not count as a Text requirement. These labels describe the author's evidence judgment; they do not establish an ablation result.

A Draft may have an empty prompt, no options, a `null` answer, and no modalities. All fields are still required, and existing values must satisfy type, enum, uniqueness, and reference constraints. Ready requires a non-whitespace prompt, at least two non-whitespace options, a selected correct answer, and at least one modality. Ready means author-complete, not independently reviewed or human gold. Audio-only questions are allowed.

Display letters are derived from option order. When converting `{ "A": "...", "B": "..." }`, preserve the intended order, create one UUID per option, and translate the answer letter into the corresponding UUID. Reordering options must not change the UUID referenced by the answer.

## Shared rules

- Project, video record, clip, question, and option UUIDs must be unique across the entire file, case-insensitively. Use the standard `8-4-4-4-12` string format. UUIDv4 is suitable; UUIDv5 with a fixed namespace and unique business keys supports reproducible generation. Keep IDs stable when regenerating the same project.
- Date-time strings must use `YYYY-MM-DDTHH:mm:ss[.sss]Z` or an explicit `±HH:mm` offset. Fractional seconds are optional and may have up to three digits. Prefer `2026-10-01T00:00:00.000Z`. Time-zone-free dates and invalid calendar dates are rejected.
- Do not substitute `null` for required strings or arrays. Use empty strings/arrays only where permitted.
- The frontend discards unrecognized fields. Preserve needed business IDs, source observations, and ablation explanations in supported `note`, `tags`, and `rationale` fields, and retain the original research data separately.
- JSON does not embed media. A custom `video_path` field does not enable local MP4 playback; the current player uses YouTube sources.

## Import behavior and legacy versions

All selected files are validated before the workspace changes. If any file fails, the entire batch is rejected. The UI normally reports the first validation error, so validate again after each correction.

Each file remains a separate project; imports are not automatically merged. A project with an already-loaded `project_id` is skipped. To load an updated version, first remove the old project from the UI, then import the revised file. Export any unsaved work before removing it.

Files larger than 20 MB require confirmation. Insufficient browser storage may also prevent an otherwise valid import.

Legacy versions `"1.0"`, `"1.1"` and `"1.2"` are accepted and migrated to 1.3; their clips get `ref_id: ""`, because notes and tags are never parsed for an ID. Version 1.0 gains empty question arrays and `unknown` subtitle status. Clips in 1.0/1.1 inherit the project annotator. Do not downgrade `schema_version` to bypass QA validation: 1.0 question fields are not retained, and notes are never automatically parsed into questions.

## Schema versions

| Version | Change | Import into the current app |
| --- | --- | --- |
| `1.0` | Projects, videos and clips with notes and tags. | Clips gain `subtitle_status: "unknown"`, `questions: []`, the project annotator and `ref_id: ""`. Notes are not parsed into questions. |
| `1.1` | Clip `subtitle_status` and `questions`. | Clips gain the project annotator and `ref_id: ""`. |
| `1.2` | Per-clip `annotator`. | Clips gain `ref_id: ""`. |
| `1.3` | Per-clip `ref_id`. | Current version; imported as is. |

Every import is re-exported as the current version. Releases up to and including `v0.3.0` read at most `1.2` and reject `1.3` files with "Unsupported file version". The current app cannot write `1.2`, so keep the original `1.2` file if someone still uses an older release or a demo that has not been updated.

### `ref_id` in 1.3

`ref_id` holds an identifier from your own catalog or review records, such as `R4-C06`. It lets reviewers find a clip by the same ID used in notes, spreadsheets and discussion. The app shows it in the video library, the clip table and the question panel, and both library and clip search match it. Clips with `""` look as they did in 1.2.

- It belongs to the **clip**, not the video. A video with several referenced clips is listed as, for example, `R5-14 +2`.
- It is not a record UUID and does not replace `id`. Record UUIDs stay the keys for import, deduplication and answer references.
- Uniqueness is not enforced. The app warns when a saved clip reuses an ID already present in the project. Generators should still emit unique IDs.
- Import does not read IDs from `note` or `tags`. Text such as `Clip ID: R4-C06` may remain there for human readers, but only `ref_id` is displayed and searched as the reference ID.

To upgrade a 1.2 generator, set `schema_version` to `"1.3"` and add `ref_id` to every clip: the business ID when one exists, otherwise `""`. Keep the source catalog's ID column as the origin of the value, rather than extracting it from free text.

## Validate generated files before delivery

Run the following from the `annotation-toolkit/` directory. Replace the example file argument with one or more files to check. This reads files without changing them or installing dependencies; it requires an existing Node.js runtime.

```bash
node --input-type=module - examples/annotation-project-1.3.json <<'JS'
import { readFileSync } from 'node:fs';
import { validateProject } from './src/annotation_toolkit/static/core.js';

for (const file of process.argv.slice(2)) {
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const project = validateProject(JSON.parse(raw));
    const clips = project.videos.flatMap(video => video.clips);
    const questions = clips.flatMap(clip => clip.questions);
    console.log(`${file}: OK — ${project.videos.length} videos, ${clips.length} clips, ${questions.length} questions`);
  } catch (error) {
    console.error(`${file}: ${error.message}`);
    process.exitCode = 1;
  }
}
JS
```

Before declaring a file importable, verify that it parses, passes this actual import validator, and contains the expected video/clip/question counts. Check that converted answers still select the intended options and that source links and time bases match the research records. Passing schema validation establishes structural compatibility; video availability, subtitle states, sound events, and question facts require separate review.

## Common validation errors

| Error | What to check |
| --- | --- |
| `Project must be a JSON object.` | The root may be a flat question array. |
| `Project ID must be a valid UUID.` | A project name or business ID may have been used as `project_id`. |
| `Annotator ID must be text...` | `annotator.id` may be missing or `null`. |
| `Invalid evidence cues or parent modality.` | Check exact cue spelling, duplicates, and the selected parent modalities. |
| `Invalid clip subtitle status.` | A custom value such as `clean` may have been used. |
| `Correct answer must reference an existing option.` | An answer letter may remain, or the UUID may refer to another question's option. |
| `The file contains duplicate project, video, or clip IDs.` | Check all record UUIDs, including questions and options. |
| `The clip end cannot exceed the video duration.` | A clip duration may have been used as the source duration, or a time offset may have been added twice. |
| `Each clip must contain ref_id text; use "" when there is none.` | A 1.3 clip has no `ref_id` field. Add `"ref_id": ""` for clips without an ID. |
| `Reference ID must be text with at most 100 characters.` | `ref_id` is `null`, a number, or longer than 100 characters. |
| `Reference ID must be a single line.` | The ID contains a line break. |
| `Unsupported file version.` | An older app release cannot read `1.3`; update the app, or import the original `1.2` file into that release. |
