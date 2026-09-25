import copy
import unittest
from uuid import uuid4
from annotation_toolkit.downloads import validate_export, DownloadError
from test_downloads import project_fixture

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

    def test_schema_1_2_requires_clip_and_question_annotators(self):
        p = self.fixture()
        p['schema_version'] = '1.2'
        clip = p['videos'][0]['clips'][0]
        clip['annotator'] = {'id': 'P001', 'name': 'Nan'}
        clip['questions'][0]['annotator'] = {'id': '', 'name': 'Leixin'}
        self.assertEqual(validate_export(copy.deepcopy(p)), p)
        for path, value in ((('annotator',), None), (('annotator',), 'Nan'),
                            (('questions', 0, 'annotator'), None), (('questions', 0, 'annotator'), {'id': 1, 'name': ''})):
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
