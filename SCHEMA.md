# Annotation JSON import specification (schema 1.5)

Use this specification when generating annotations with scripts, models, or manual editing. An import file contains **one project**, with the hierarchy **project → videos → clips → questions → options**. Research catalogs and flat QA arrays require conversion before import.

The executable source of truth is [core.js](src/annotation_toolkit/static/core.js): `validateProject`, `validateQuestion`, `SCENARIOS`, `MODALITIES`, `LEGACY_CUE_RENAMES`, and `SUBTITLE_STATUSES`. Local exports are also checked by `validate_export` in [downloads.py](src/annotation_toolkit/downloads.py). Keep this document and the [README schema overview](README.md#annotation-json-schema) aligned with those implementations.

## Importable example

[examples/annotation-project-1.5.json](examples/annotation-project-1.5.json) contains one project, one YouTube video, one clip with a scenario category, and one Draft question with two options and two evidence lines. It demonstrates structure; its scenario, question and answer are illustrative and have not been verified against the video. For a new project, generate fresh record UUIDs and replace the source, interval, and annotation content. [examples/annotation-project-1.4.json](examples/annotation-project-1.4.json) is the same example in schema 1.4, kept to show and test the migration.

## Required fields

Every field in the following tables is required unless explicitly marked optional. An optional UI input means its value may be empty; the JSON field must still exist. Only the project's `exported_at` field may be omitted.

String limits below follow JavaScript UTF-16 code-unit counting, rather than byte counts. Unless a nonempty value is explicitly required, a string may be `""`.

### Project: the root object

The root must be an object, not an array of questions or projects.

| Field | Type and constraints |
| --- | --- |
| `schema_version` | The string `"1.5"`, not the number `1.5`. |
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
| `scenarios` | Array of [scenario category](#scenario-categories) IDs, no duplicates; use `[]` when none is chosen or none fits. |
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

#### Scenario categories

The twelve categories of the team guideline (Annotation Labels tab, *Scenario Category*), in its table order. Use the ID in JSON; the app and the copied team text show the name.

| ID | Scenario Category |
| --- | --- |
| `social_personal` | Social & Personal Interactions |
| `everyday_problems` | Everyday Problems & Unexpected Situations |
| `food_dining` | Food & Dining |
| `household_domestic` | Household & Domestic Activities |
| `travel_navigation` | Travel & Navigation |
| `education_training` | Education & Training |
| `work_professional` | Work & Professional Activities |
| `entertainment_recreation_media` | Entertainment, Recreation & Media |
| `health_wellbeing` | Health & Well-being |
| `public_service` | Public & Service Interactions |
| `institutional_formal` | Institutional & Formal Interactions |
| `safety_emergency` | Safety & Emergency Situations |

The guideline allows several labels but asks to prioritize the dominant scenario and avoid unnecessary labels, so most clips have one. Order is kept as given; the app saves its selection in table order. When no category fits (the guideline's "No suitable scenario label"), use `[]` and describe the scenario in `note`; there is no separate field for it. `[]` therefore also covers clips not labelled yet, including every clip migrated from an earlier schema. The category is descriptive and is not required for Ready.

### Question: `videos[].clips[].questions[]`

| Field | Type and constraints |
| --- | --- |
| `id` | Question UUID. |
| `prompt` | Question string, maximum 10,000. |
| `options` | Array of at most 26 option objects. Each object requires UUID `id` and string `text` (maximum 5,000). |
| `correct_option_id` | The UUID of an option in **this question**, or `null` when no answer is selected. An answer letter, numeric index, or answer text is not accepted. |
| `required_modalities` | Array selecting from `audio`, `visual`, `text`; no duplicates. |
| `evidence_cues` | Array selecting from the table below; no duplicates. Every cue's parent modality must also be selected. Use `[]` when no specific cues are selected. |
| `annotations` | Array of at most 50 evidence objects (see [Evidence](#evidence-videosclipsquestionsannotations)); use `[]` when there are none. |
| `rationale` | Explanation string, maximum 20,000; use `""` when empty. |
| `status` | `"draft"` or `"ready"`. |
| `created_at`, `updated_at` | Date-time strings with time zones. |

The cues follow the guideline's *Modality Elements* list. The app shows the names in the second column, with the guideline's definitions as tooltips.

| Parent modality | Cue | Shown as | Guideline definition (short) |
| --- | --- | --- | --- |
| `audio` | `speech_content` | Speech content | What is said. |
| `audio` | `prosody` | Prosody | Rate, loudness, etc. |
| `audio` | `environmental_sounds` | Environmental Sound | Sound from objects or animals. |
| `audio` | `voice_characteristics` | Voice Characteristics | Whose voice it is, usually to tell speakers apart. **New in 1.5.** |
| `audio` | `vocalization` | Vocalization | Non-verbal: laughter, "hmm", "um", whisper, non-verbal exclaiming. |
| `visual` | `scene` | Scene | The broader physical or situational setting. **New in 1.5.** |
| `visual` | `action` | Action | Usually intentional, goal-directed behavior. **New in 1.5.** |
| `visual` | `event` | Event | An occurrence or change that need not be intentional. **New in 1.5.** |
| `visual` | `gesture` | Body Gesture | Communicative; typically does not change the physical world. |
| `visual` | `facial_expression` | Facial Expression | |
| `visual` | `gaze` | Gaze | Direction, target and movement of attention, including closely related head movement. |
| `visual` | `person_appearance` | Human Status & Appearance | |
| `visual` | `object` | Object | **New in 1.5.** |
| `text` | `subtitles` | Subtitles | Toolkit cue; the guideline's list has no subtitles. |
| `text` | `scene_text` | Written language | E.g. a phone message or written notes, not transcription. |

Use the exact enum strings, including the plural in `environmental_sounds`. For example, `gaze` requires `visual` in `required_modalities`. 1.5 replaced `action_event` with `action` and `event`, and `object_scene` with `object` and `scene`; a 1.5 file using the old IDs is rejected (see [migration](#import-behavior-and-legacy-versions)).

The guideline lists *Written language* with the Visual signals. Schema 1.5 keeps it as the `text` cue `scene_text`, only renamed in the interface, so files from earlier schemas keep their modality and no `required_modalities` value has to change. Exports and copied text still use the guideline's name (row label `written-content`). Code that maps cues to the guideline's Audio/Visual split should treat `scene_text` as Visual. Visible subtitles do not automatically make `text` a required modality. Question and option text themselves do not count as a Text requirement. These labels describe the author's evidence judgment; they do not establish an ablation result.

A Draft may have an empty prompt, no options, a `null` answer, and no modalities. All fields are still required, and existing values must satisfy type, enum, uniqueness, and reference constraints. Ready requires a non-whitespace prompt, at least two options with every option containing non-whitespace text (remove unused blank options rather than leaving them empty), a selected correct answer, at least one modality, and non-whitespace `content` plus at least one span on every evidence object. Ready means author-complete, not independently reviewed or human gold. Audio-only questions are allowed.

Display letters are derived from option order. When converting `{ "A": "...", "B": "..." }`, preserve the intended order, create one UUID per option, and translate the answer letter into the corresponding UUID. Reordering options must not change the UUID referenced by the answer.

### Evidence: `videos[].clips[].questions[].annotations[]`

Each evidence object is one line of the team's *Annotation* section: a piece of evidence the answer needs, where it occurs, and what it does in the communication.

| Field | Type and constraints |
| --- | --- |
| `id` | Evidence UUID. |
| `cue` | One cue from the table above. It must also be listed in this question's `evidence_cues` (and so its modality in `required_modalities`). |
| `content` | What is said, heard or seen, maximum 5,000. For speech, write who says what, e.g. `Woman in red: "Is that sugar?"`. |
| `spans` | Array of at most 20 `{ "start_seconds", "end_seconds" }` objects. Times are seconds in the **original video**, like clip boundaries, rounded to milliseconds, with `clip.start_seconds <= start_seconds < end_seconds <= clip.end_seconds`. Several spans express evidence that is not contiguous. A Draft may hold `[]`. |
| `function` | Its communicative function, maximum 2,000; `""` when empty. Usually filled for non-speech cues. The guideline asks for a more abstract, generalizable level than the evidence description, e.g. `Indicates an object referent`, `Indicates the addressee`, `Elicits a question`. Free text; the app offers the guideline's categories as insertable suggestions. |

`vocalization` covers non-lexical sounds a person makes (laughs, sighs, gasps, "mm-hm"); `prosody` covers how words are said; `environmental_sounds` covers sounds not made by speakers.

The app's **Copy as team text** button renders the evidence as the rows used in the team document (Data_Leixin), in original-video time by default or in clip time. Each evidence line is one row, in temporal order by its earliest span, with all its spans in millisecond precision side by side; lines without spans come last. A non-speech label used by several lines is numbered so that each Function line names its row. The Function block lists the non-speech lines that have a function, and the last line gives the clip's scenario categories (omitted when `scenarios` is `[]`):

```text
Annotation:
[01:01.000–01:03.500] (speech-content): Woman in red: "Is that sugar?"
[01:04.000–01:05.000] [01:10.000–01:12.000] (gesture 1): Man points at the jar
[01:20.250–01:21.000] (gesture 2): Woman nods
Function of Non-Speech Content Modalities:
(gesture 1): Indicates an object referent
(gesture 2): Elicits a confirmation
Scenario Category: Food & Dining
```

Row labels are `speech-content`, `prosody`, `environmental-sound`, `voice-characteristics`, `non-speech vocalization`, `scene`, `action`, `event`, `gesture`, `facial-expression`, `gaze`, `human-appearance`, `object`, `subtitles` and `written-content` (for `scene_text`), the spellings most used in those rows. Multiple categories are joined with `; `.

**Copy in time_span format** keeps the earlier output, `(speech content): Woman in red: "Is that sugar?" [time_span: 01:01 ~ 01:04]`, followed by `Function of non-speech content to communication:` and `(gesture) …` lines. Its times are whole seconds, rounded outward and then kept inside the clip, so it approximates fractional spans. Its cue names are spaced (`speech content`, `human appearance`, `written content`, …).

When converting spans recorded relative to a downloaded clip, add the clip's `start_seconds` before import. In the app, a clip cannot be shortened so that existing evidence spans fall outside it, and a modality or cue used by an evidence line cannot be deselected.

## Shared rules

- Project, video record, clip, question, option, and evidence UUIDs must be unique across the entire file, case-insensitively. Use the standard `8-4-4-4-12` string format. UUIDv4 is suitable; UUIDv5 with a fixed namespace and unique business keys supports reproducible generation. Keep IDs stable when regenerating the same project.
- Date-time strings must use `YYYY-MM-DDTHH:mm:ss[.sss]Z` or an explicit `±HH:mm` offset. Fractional seconds are optional and may have up to three digits. Prefer `2026-10-01T00:00:00.000Z`. Time-zone-free dates and invalid calendar dates are rejected.
- Do not substitute `null` for required strings or arrays. Use empty strings/arrays only where permitted.
- The frontend discards unrecognized fields. Preserve needed business IDs, source observations, and ablation explanations in supported `note`, `tags`, and `rationale` fields, and retain the original research data separately.
- JSON does not embed media. A custom `video_path` field does not enable local MP4 playback; the current player uses YouTube sources.

## Import behavior and legacy versions

All selected files are validated before the workspace changes. If any file fails, the entire batch is rejected. The UI normally reports the first validation error, so validate again after each correction.

Each file remains a separate project; imports are not automatically merged. A project with an already-loaded `project_id` is skipped. To load an updated version, first remove the old project from the UI, then import the revised file. Export any unsaved work before removing it.

Files larger than 20 MB require confirmation. Insufficient browser storage may also prevent an otherwise valid import.

Legacy versions `"1.0"` to `"1.4"` are accepted and migrated to 1.5:

- Clips get `scenarios: []` (any `scenarios` field in an older file is ignored).
- In `evidence_cues` and in every `annotations[].cue`, `action_event` becomes `action` and `object_scene` becomes `object`; a cue listed twice after the rename is kept once, in its first position. Legacy files may already use the 1.5 cue IDs. **This mapping is a default for the annotator to review**: an old `action_event` may really be an Event (not intentional, such as an object falling), and an old `object_scene` may really be a Scene (the whole setting). The content, spans and function of each evidence line are unchanged.
- Questions from before 1.4 get `annotations: []` (any `annotations` field in an older file is ignored), and clips from before 1.3 get `ref_id: ""`, because notes and tags are never parsed for an ID. Version 1.0 gains empty question arrays and `unknown` subtitle status. Clips in 1.0/1.1 inherit the project annotator. Do not downgrade `schema_version` to bypass QA validation: 1.0 question fields are not retained, and notes are never automatically parsed into questions.

## Schema versions

| Version | Change | Import into the current app |
| --- | --- | --- |
| `1.0` | Projects, videos and clips with notes and tags. | Clips gain `subtitle_status: "unknown"`, `questions: []`, the project annotator, `ref_id: ""` and `scenarios: []`. Notes are not parsed into questions. |
| `1.1` | Clip `subtitle_status` and `questions`. | Clips gain the project annotator, `ref_id: ""` and `scenarios: []`; cues are renamed as for 1.4. |
| `1.2` | Per-clip `annotator`. | Clips gain `ref_id: ""` and `scenarios: []`; questions gain `annotations: []`; cues are renamed as for 1.4. |
| `1.3` | Per-clip `ref_id`. | Clips gain `scenarios: []`; questions gain `annotations: []`; cues are renamed as for 1.4. |
| `1.4` | Per-question `annotations` (evidence with time spans); new audio cue `vocalization`. | Clips gain `scenarios: []`; `action_event` → `action`, `object_scene` → `object`. |
| `1.5` | Per-clip `scenarios`; cues follow the guideline's Modality Elements: new `voice_characteristics`, `action_event` split into `action`/`event`, `object_scene` into `object`/`scene`; relabelled Body Gesture, Human Status & Appearance, Written language. | Current version; imported as is. |

Every import is re-exported as the current version. Releases up to and including `v0.3.0` read at most `1.2` and reject `1.3` files with "Unsupported file version"; releases before evidence spans reject `1.4`, and releases before scenario categories reject `1.5`, the same way. The current app cannot write older versions, so keep the original file if someone still uses an older release or a demo that has not been updated.

### `ref_id` in 1.3

`ref_id` holds an identifier from your own catalog or review records, such as `R4-C06`. It lets reviewers find a clip by the same ID used in notes, spreadsheets and discussion. The app shows it in the video library, the clip table and the question panel, and both library and clip search match it. Clips with `""` look as they did in 1.2.

- It belongs to the **clip**, not the video. A video with several referenced clips is listed as, for example, `R5-14 +2`.
- It is not a record UUID and does not replace `id`. Record UUIDs stay the keys for import, deduplication and answer references.
- Uniqueness is not enforced. The app warns when a saved clip reuses an ID already present in the project. Generators should still emit unique IDs.
- Import does not read IDs from `note` or `tags`. Text such as `Clip ID: R4-C06` may remain there for human readers, but only `ref_id` is displayed and searched as the reference ID.

To upgrade a 1.4 generator to 1.5, set `schema_version` to `"1.5"`, add `"scenarios": []` (or real categories) to every clip, and emit `action` or `event` instead of `action_event` and `object` or `scene` instead of `object_scene`, choosing by the guideline's definitions rather than mapping blindly.

To upgrade a 1.3 generator to 1.4, set `schema_version` to `"1.4"` and add `"annotations": []` (or real evidence) to every question.

To upgrade a 1.2 generator, set `schema_version` to `"1.3"` and add `ref_id` to every clip: the business ID when one exists, otherwise `""`. Keep the source catalog's ID column as the origin of the value, rather than extracting it from free text.

## Validate generated files before delivery

Run the following from the `annotation-toolkit/` directory. Replace the example file argument with one or more files to check. This reads files without changing them or installing dependencies; it requires an existing Node.js runtime.

```bash
node --input-type=module - examples/annotation-project-1.5.json <<'JS'
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
| `Invalid evidence cues or parent modality.` | Check exact cue spelling, duplicates, and the selected parent modalities. A 1.5 file may not use `action_event` or `object_scene`. |
| `Each clip must contain a scenarios array; use [] when none applies.` | A 1.5 clip has no `scenarios` field. |
| `Clip scenarios must be an array of scenario categories...` | `scenarios` is `null`, a string or an object. |
| `Unknown scenario category: "…".` | Use the IDs in [Scenario categories](#scenario-categories), not the display names. |
| `A clip lists the same scenario category twice.` | Remove the duplicate. |
| `Invalid clip subtitle status.` | A custom value such as `clean` may have been used. |
| `Correct answer must reference an existing option.` | An answer letter may remain, or the UUID may refer to another question's option. |
| `The file contains duplicate project, video, or clip IDs.` | Check all record UUIDs, including questions and options. |
| `The clip end cannot exceed the video duration.` | A clip duration may have been used as the source duration, or a time offset may have been added twice. |
| `Each clip must contain ref_id text; use "" when there is none.` | A 1.3 clip has no `ref_id` field. Add `"ref_id": ""` for clips without an ID. |
| `Reference ID must be text with at most 100 characters.` | `ref_id` is `null`, a number, or longer than 100 characters. |
| `Reference ID must be a single line.` | The ID contains a line break. |
| `Question annotations must be an array...` | A 1.4 or 1.5 question has no `annotations` field. Add `"annotations": []`. |
| `Each evidence line's cue must also be selected in the question's evidence cues.` | Add the cue to `evidence_cues` and its modality to `required_modalities`. |
| `Evidence spans must lie within their clip.` | Spans may be in clip time; add the clip's `start_seconds`. |
| `Each evidence line needs content and at least one time span before Ready.` | Fill the evidence or set the question to `draft`. |
| `Unsupported file version.` | An older app release cannot read this version; update the app, or import the original older file into that release. |
