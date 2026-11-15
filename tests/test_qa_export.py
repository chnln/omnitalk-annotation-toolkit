import copy
import json
from pathlib import Path
import unittest
from uuid import uuid4
from annotation_toolkit.downloads import validate_export, DownloadError
from test_downloads import project_fixture

VALIDATOR_CASES = json.loads((Path(__file__).parent / 'fixtures' / 'validator_cases.json').read_text(encoding='utf-8'))


def apply_validator_case(case):
    project = copy.deepcopy(VALIDATOR_CASES['base'])
    for alias, value in case['set']:
        *parents, last = VALIDATOR_CASES['aliases'][alias]
        target = project
        for key in parents:
            target = target[key]
        target[last] = value['$repeat'][0] * value['$repeat'][1] if isinstance(value, dict) else value
    return project


class ValidatorParityTests(unittest.TestCase):
    def test_shared_fixtures_match_the_browser_validator(self):
        for case in VALIDATOR_CASES['cases']:
            with self.subTest(case['name']):
                project = apply_validator_case(case)
                if case['valid']:
                    self.assertIs(validate_export(project), project)
                else:
                    with self.assertRaises(DownloadError):
                        validate_export(project)


class QuestionExportTests(unittest.TestCase):
    def fixture(self):
        project = project_fixture()
        project['schema_version'] = '1.1'
        clip = project['videos'][0]['clips'][0]
        clip['subtitle_status'] = 'unknown'
        options = [{'id': str(uuid4()), 'text': label} for label in ('Yes', 'No')]
        clip['questions'] = [{'id': str(uuid4()), 'prompt': 'Is the reply sarcastic?',
            'options': options, 'correct_option_id': options[0]['id'],
            'required_modalities': ['audio'], 'evidence_cues': ['speech_content', 'prosody'],
            'rationale': 'Words and delivery differ.', 'status': 'ready',
            'created_at': project['created_at'], 'updated_at': project['updated_at']}]
        return project

    def test_ready_audio_integration_and_drafts_are_preserved(self):
        p = self.fixture()
        self.assertEqual(validate_export(copy.deepcopy(p)), p)
        q = p['videos'][0]['clips'][0]['questions'][0]
        q.update(status='draft', prompt='', options=[], correct_option_id=None,
                 required_modalities=[], evidence_cues=[])
        self.assertEqual(validate_export(copy.deepcopy(p)), p)

    def test_invalid_qa_is_rejected(self):
        for change in ({'correct_option_id':str(uuid4())}, {'evidence_cues':['gaze']},
                       {'prompt':''}, {'required_modalities':['unknown']}, {'options':None}):
            p = self.fixture()
            p['videos'][0]['clips'][0]['questions'][0].update(change)
            with self.subTest(change=change), self.assertRaises(DownloadError):
                validate_export(p)

    def test_schema_1_3_requires_trimmed_reference_ids(self):
        p = self.fixture()
        p['schema_version'] = '1.3'
        clip = p['videos'][0]['clips'][0]
        clip['annotator'] = {'id': '', 'name': 'Nan'}
        for ref in ('', 'R4-C06'):
            clip['ref_id'] = ref
            self.assertEqual(validate_export(copy.deepcopy(p)), p)
        for ref in (None, 7, ' R4-C06', 'R4\nC06', 'x' * 101):
            broken = copy.deepcopy(p)
            broken['videos'][0]['clips'][0]['ref_id'] = ref
            with self.subTest(ref=ref), self.assertRaises(DownloadError):
                validate_export(broken)
        del clip['ref_id']
        with self.assertRaises(DownloadError):
            validate_export(p)

    def test_schema_1_2_requires_clip_annotators(self):
        p = self.fixture()
        p['schema_version'] = '1.2'
        clip = p['videos'][0]['clips'][0]
        clip['annotator'] = {'id': 'P001', 'name': 'Nan'}
        self.assertEqual(validate_export(copy.deepcopy(p)), p)
        for path, value in ((('annotator',), None), (('annotator',), 'Nan'), (('annotator',), {'id': 1, 'name': ''})):
            broken = copy.deepcopy(p)
            target = broken['videos'][0]['clips'][0]
            for key in path[:-1]:
                target = target[key]
            if value is None:
                del target[path[-1]]
            else:
                target[path[-1]] = value
            with self.subTest(path=path, value=value), self.assertRaises(DownloadError):
                validate_export(broken)

class EvidenceExportTests(unittest.TestCase):
    def fixture(self):
        p = QuestionExportTests().fixture()
        p['schema_version'] = '1.4'
        clip = p['videos'][0]['clips'][0]
        clip['annotator'] = {'id': '', 'name': 'Nan'}
        clip['ref_id'] = 'R8-01'
        start, end = clip['start_seconds'], clip['end_seconds']
        q = clip['questions'][0]
        q['annotations'] = [
            {'id': str(uuid4()), 'cue': 'speech_content', 'content': 'A: "Sure."', 'function': '',
             'spans': [{'start_seconds': start, 'end_seconds': end}]},
            {'id': str(uuid4()), 'cue': 'prosody', 'content': 'flat, drawn-out "sure"', 'function': 'marks sarcasm',
             'spans': [{'start_seconds': start, 'end_seconds': (start + end) / 2}, {'start_seconds': (start + end) / 2, 'end_seconds': end}]},
        ]
        return p

    def test_schema_1_4_evidence_is_accepted(self):
        p = self.fixture()
        self.assertEqual(validate_export(copy.deepcopy(p)), p)
        q = p['videos'][0]['clips'][0]['questions'][0]
        q['status'] = 'draft'
        q['annotations'][0].update(content='', spans=[])
        self.assertEqual(validate_export(copy.deepcopy(p)), p, 'drafts may hold unfinished evidence')

    def test_schema_1_4_rejects_invalid_evidence(self):
        def mutations(q, start, end):
            e = q['annotations'][0]
            return [
                lambda: q.pop('annotations'),
                lambda: q.update(annotations={}),
                lambda: e.update(cue='gaze'),
                lambda: e.update(cue='smell'),
                lambda: e.update(id='x'),
                lambda: e.update(content=None),
                lambda: e.update(function='x' * 2001),
                lambda: e.update(spans={}),
                lambda: e.update(spans=[{'start_seconds': start, 'end_seconds': start}]),
                lambda: e.update(spans=[{'start_seconds': start - 1, 'end_seconds': end}]),
                lambda: e.update(spans=[{'start_seconds': start, 'end_seconds': end + 1}]),
                lambda: e.update(spans=[{'start_seconds': True, 'end_seconds': end}]),
                lambda: e.update(spans=[{'start_seconds': start, 'end_seconds': float('inf')}]),
                lambda: e.update(spans=[]),
                lambda: e.update(content='  '),
            ]
        count = len(mutations({'annotations': [{}]}, 0, 1))
        for i in range(count):
            p = self.fixture()
            clip = p['videos'][0]['clips'][0]
            mutations(clip['questions'][0], clip['start_seconds'], clip['end_seconds'])[i]()
            with self.subTest(i=i), self.assertRaises(DownloadError):
                validate_export(p)


class ScenarioAndCueExportTests(unittest.TestCase):
    def fixture(self):
        p = EvidenceExportTests().fixture()
        p['schema_version'] = '1.5'
        p['videos'][0]['clips'][0]['scenarios'] = ['work_professional']
        return p

    def test_schema_1_5_accepts_scenarios_and_the_doc_cues(self):
        p = self.fixture()
        self.assertEqual(validate_export(copy.deepcopy(p)), p)
        q = p['videos'][0]['clips'][0]['questions'][0]
        q.update(required_modalities=['audio', 'visual'],
                 evidence_cues=['speech_content', 'prosody', 'voice_characteristics', 'scene', 'action', 'event', 'object'])
        q['annotations'][1]['cue'] = 'voice_characteristics'
        p['videos'][0]['clips'][0]['scenarios'] = []
        self.assertEqual(validate_export(copy.deepcopy(p)), p, 'no suitable scenario label is an empty list')

    def test_schema_1_5_rejects_bad_scenarios_and_split_cues(self):
        for change in ({'scenarios': None}, {'scenarios': 'work_professional'}, {'scenarios': ['work_professional'] * 2},
                       {'scenarios': ['Work & Professional Activities']}, {'scenarios': [1]}):
            p = self.fixture()
            p['videos'][0]['clips'][0].update(change)
            with self.subTest(change=change), self.assertRaises(DownloadError):
                validate_export(p)
        p = self.fixture()
        del p['videos'][0]['clips'][0]['scenarios']
        with self.assertRaises(DownloadError):
            validate_export(p)
        for cue in ('action_event', 'object_scene'):
            p = self.fixture()
            q = p['videos'][0]['clips'][0]['questions'][0]
            q.update(required_modalities=['audio', 'visual'], evidence_cues=['speech_content', 'prosody', cue])
            with self.subTest(cue=cue), self.assertRaises(DownloadError):
                validate_export(p)

    def test_schema_1_4_keeps_its_cues_and_ignores_scenarios(self):
        p = self.fixture()
        p['schema_version'] = '1.4'
        clip = p['videos'][0]['clips'][0]
        clip['scenarios'] = 'not checked before 1.5'
        q = clip['questions'][0]
        q.update(required_modalities=['audio', 'visual'], evidence_cues=['speech_content', 'prosody', 'action_event', 'object_scene'])
        q['annotations'][1]['cue'] = 'action_event'
        self.assertEqual(validate_export(copy.deepcopy(p)), p)
