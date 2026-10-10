import json
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.test import Client, TestCase, override_settings
from django.utils import timezone

from .models import CATEGORIES, Entry


class EntryTests(TestCase):
    def payload(self, **overrides):
        return {
            'category': 'Research',
            'description': 'Review the protocol',
            'started_at': (timezone.now() - timedelta(hours=1)).isoformat(),
            **overrides,
        }

    def create(self, **overrides):
        return self.client.post('/api/entries/', json.dumps(self.payload(**overrides)), content_type='application/json')

    def test_categories_and_empty_list(self):
        response = self.client.get('/api/entries/')
        self.assertEqual(response.json(), {'entries': [], 'categories': CATEGORIES, 'can_shutdown': False})

    def test_add_without_end_and_finish_at_server_time(self):
        response = self.create()
        self.assertEqual(response.status_code, 201)
        entry = response.json()['entry']
        self.assertIsNone(entry['ended_at'])
        self.assertFalse(entry['is_submitted'])
        now = timezone.now()
        with patch('tracking.views.timezone.now', return_value=now):
            finished = self.client.post(f"/api/entries/{entry['id']}/finish/")
        self.assertEqual(finished.status_code, 200)
        self.assertEqual(Entry.objects.get().ended_at, now)
        self.assertTrue(Entry.objects.get().is_submitted)
        self.assertEqual(self.create(category='System Validation').status_code, 201)

    def test_provided_end_is_preserved_on_submit(self):
        selected_end = timezone.now() - timedelta(minutes=20)
        response = self.create(ended_at=selected_end.isoformat())
        entry_id = response.json()['entry']['id']
        now = timezone.now()
        with patch('tracking.views.timezone.now', return_value=now):
            self.client.post(f'/api/entries/{entry_id}/finish/')
        self.assertEqual(Entry.objects.get().ended_at, selected_end)
        self.assertTrue(Entry.objects.get().is_submitted)

    def test_duplicate_finish_does_not_move_end_time(self):
        entry_id = self.create().json()['entry']['id']
        first_response = self.client.post(f'/api/entries/{entry_id}/finish/')
        self.assertEqual(first_response.status_code, 200)
        first = first_response.json()
        with patch('tracking.views.timezone.now', return_value=timezone.now() + timedelta(hours=1)):
            second = self.client.post(f'/api/entries/{entry_id}/finish/').json()
        self.assertEqual(first, second)

    def test_one_pending_entry_and_refresh_recovery(self):
        entry = self.create().json()['entry']
        self.assertEqual(self.create().status_code, 409)
        self.assertEqual(self.client.get('/api/entries/').json()['entries'], [entry])
        self.assertEqual(Entry.objects.count(), 1)

    def test_validation(self):
        invalid = [
            {'category': 'Unknown'}, {'category': ['Research']},
            {'description': ''}, {'description': '   '},
            {'description': 'x' * 1001}, {'description': 17},
            {'started_at': '2026-10-10T12:00:00'}, {'started_at': 'garbage'},
            {'started_at': (timezone.now() + timedelta(days=1)).isoformat()},
            {'ended_at': (timezone.now() - timedelta(days=1)).isoformat()},
        ]
        for data in invalid:
            with self.subTest(data=data):
                self.assertEqual(self.create(**data).status_code, 400)
        self.assertEqual(Entry.objects.count(), 0)

    def test_malformed_input_and_missing_entry(self):
        for body in ['{', '[]', 'null']:
            self.assertEqual(self.client.post('/api/entries/', body, content_type='application/json').status_code, 400)
        self.assertEqual(self.client.post('/api/entries/999/finish/').status_code, 404)

    def test_csrf_protection(self):
        client = Client(enforce_csrf_checks=True)
        self.assertEqual(client.post('/api/entries/', json.dumps(self.payload()), content_type='application/json').status_code, 403)
        client.get('/api/entries/')
        token = client.cookies['csrftoken'].value
        response = client.post('/api/entries/', json.dumps(self.payload()), content_type='application/json', HTTP_X_CSRFTOKEN=token)
        self.assertEqual(response.status_code, 201)

    def test_historical_submit_uses_entry_date_and_current_clock(self):
        from datetime import datetime
        start = datetime.fromisoformat('2026-08-08T09:00:00+02:00')
        now = datetime.fromisoformat('2026-08-10T10:00:00+02:00')
        with patch('tracking.views.timezone.now', return_value=now):
            entry_id = self.create(started_at=start.isoformat()).json()['entry']['id']
            self.client.post(f'/api/entries/{entry_id}/finish/')
        entry = Entry.objects.get(pk=entry_id)
        self.assertEqual((entry.ended_at - entry.started_at).total_seconds(), 3600)

    def test_end_date_boundaries_and_overnight(self):
        cases = [
            ('2026-08-08T09:00:00+02:00', '2026-08-08T10:00:00+02:00', 201),
            ('2026-08-08T23:00:00+02:00', '2026-08-09T01:00:00+02:00', 201),
            ('2026-08-08T23:00:00+02:00', '2026-08-10T01:00:00+02:00', 400),
            ('2026-08-08T09:00:00+02:00', '2026-08-09T10:00:00+02:00', 400),
        ]
        for start, end, expected in cases:
            with self.subTest(start=start, end=end):
                response = self.create(started_at=start, ended_at=end)
                self.assertEqual(response.status_code, expected)
                if expected == 201:
                    self.client.delete(f"/api/entries/{response.json()['entry']['id']}/")

    def test_patch_rejects_multiple_days(self):
        entry_id = self.create(started_at='2026-08-08T23:00:00+02:00').json()['entry']['id']
        response = self.client.patch(f'/api/entries/{entry_id}/', json.dumps({'ended_at': '2026-08-10T01:00:00+02:00'}), content_type='application/json')
        self.assertEqual(response.status_code, 400)
        self.assertIsNone(Entry.objects.get().ended_at)

    def test_historical_submit_can_roll_into_next_day(self):
        from datetime import datetime
        now = datetime.fromisoformat('2026-08-10T01:00:00+02:00')
        with patch('tracking.views.timezone.now', return_value=now):
            entry_id = self.create(started_at='2026-08-08T23:00:00+02:00').json()['entry']['id']
            response = self.client.post(f'/api/entries/{entry_id}/finish/')
        self.assertEqual(response.status_code, 200)
        entry = Entry.objects.get()
        self.assertEqual((entry.ended_at - entry.started_at).total_seconds(), 7200)

    def test_method_restrictions(self):
        self.assertEqual(self.client.delete('/api/entries/').status_code, 405)
        self.assertEqual(self.client.get('/api/entries/1/finish/').status_code, 405)

    def test_frontend_rebuild_uses_latest_asset_references(self):
        with TemporaryDirectory() as directory, override_settings(PROJECT_DIR=Path(directory)):
            index = Path(directory) / 'frontend' / 'dist' / 'index.html'
            index.parent.mkdir(parents=True)
            index.write_text('<script src="/assets/first.js"></script>', encoding='utf-8')
            self.assertContains(self.client.get('/'), 'first.js')
            index.write_text('<script src="/assets/second.js"></script>', encoding='utf-8')
            self.assertContains(self.client.get('/'), 'second.js')

    def test_submit_saves_changed_fields_and_selected_end_atomically(self):
        entry_id = self.create().json()['entry']['id']
        now = timezone.now()
        start = now - timedelta(hours=2)
        with patch('tracking.views.timezone.now', return_value=now):
            response = self.client.post(f'/api/entries/{entry_id}/finish/', json.dumps({
                'category': 'Automated Reasoning', 'description': 'Changed before submit',
                'started_at': start.isoformat(), 'ended_at': (now - timedelta(minutes=5)).isoformat(),
            }), content_type='application/json')
        self.assertEqual(response.status_code, 200)
        entry = Entry.objects.get(pk=entry_id)
        self.assertEqual(entry.category, 'Automated Reasoning')
        self.assertEqual(entry.description, 'Changed before submit')
        self.assertEqual(entry.started_at, start)
        self.assertEqual(entry.ended_at, now - timedelta(minutes=5))

    def test_clearing_preselected_end_uses_current_time(self):
        entry_id = self.create(ended_at=(timezone.now() - timedelta(minutes=20)).isoformat()).json()['entry']['id']
        now = timezone.now()
        with patch('tracking.views.timezone.now', return_value=now):
            response = self.client.post(f'/api/entries/{entry_id}/finish/', json.dumps({'ended_at': None}), content_type='application/json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Entry.objects.get().ended_at, now)

    def test_selected_overnight_end_is_preserved(self):
        from datetime import datetime
        selected_end = datetime.fromisoformat('2026-08-09T01:00:00+02:00')
        entry_id = self.create(started_at='2026-08-08T23:00:00+02:00').json()['entry']['id']
        response = self.client.post(f'/api/entries/{entry_id}/finish/', json.dumps({'ended_at': selected_end.isoformat()}), content_type='application/json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Entry.objects.get().ended_at, selected_end)

    def test_invalid_selected_end_does_not_fall_back_to_now(self):
        entry_id = self.create().json()['entry']['id']
        for end in ['invalid', '2026-08-10T01:00:00+02:00']:
            response = self.client.post(f'/api/entries/{entry_id}/finish/', json.dumps({'ended_at': end}), content_type='application/json')
            self.assertEqual(response.status_code, 400)
        self.assertFalse(Entry.objects.get().is_submitted)
        self.assertIsNone(Entry.objects.get().ended_at)

    def test_invalid_submit_keeps_unfinished_entry_unchanged(self):
        entry_id = self.create().json()['entry']['id']
        response = self.client.post(f'/api/entries/{entry_id}/finish/', json.dumps({'description': ''}), content_type='application/json')
        self.assertEqual(response.status_code, 400)
        entry = Entry.objects.get(pk=entry_id)
        self.assertFalse(entry.is_submitted)
        self.assertIsNone(entry.ended_at)
        self.assertEqual(entry.description, 'Review the protocol')

    def test_edit_submitted_entry_preserves_manual_end(self):
        entry_id = self.create().json()['entry']['id']
        self.client.post(f'/api/entries/{entry_id}/finish/')
        start = timezone.now() - timedelta(days=1)
        end = start + timedelta(hours=3)
        response = self.client.patch(f'/api/entries/{entry_id}/', json.dumps({
            'description': 'Corrected task', 'started_at': start.isoformat(), 'ended_at': end.isoformat(),
        }), content_type='application/json')
        self.assertEqual(response.status_code, 200)
        entry = Entry.objects.get(pk=entry_id)
        self.assertEqual(entry.description, 'Corrected task')
        self.assertEqual(entry.started_at, start)
        self.assertEqual(entry.ended_at, end)
        self.assertTrue(entry.is_submitted)

    def test_edit_validates_times_and_description_without_partial_save(self):
        original = self.create().json()['entry']
        self.client.post(f"/api/entries/{original['id']}/finish/")
        for payload in [
            {'description': ''}, {'ended_at': None},
            {'started_at': (timezone.now() + timedelta(days=1)).isoformat()},
            {'ended_at': (timezone.now() - timedelta(days=1)).isoformat()},
            {'started_at': 'invalid'},
        ]:
            with self.subTest(payload=payload):
                response = self.client.patch(f"/api/entries/{original['id']}/", json.dumps(payload), content_type='application/json')
                self.assertEqual(response.status_code, 400)
        self.assertEqual(Entry.objects.get().description, original['description'])
        self.assertEqual(Entry.objects.get().started_at.isoformat(), original['started_at'])

    def test_edit_pending_entry_without_finishing(self):
        entry_id = self.create().json()['entry']['id']
        response = self.client.patch(f'/api/entries/{entry_id}/', json.dumps({'description': 'Still working', 'ended_at': None}), content_type='application/json')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()['entry']['is_submitted'])
        self.assertIsNone(response.json()['entry']['ended_at'])

    def test_delete_selected_entry_and_allow_new_pending_entry(self):
        entry_id = self.create().json()['entry']['id']
        self.assertEqual(self.client.delete(f'/api/entries/{entry_id}/').status_code, 200)
        self.assertFalse(Entry.objects.filter(pk=entry_id).exists())
        new_id = self.create().json()['entry']['id']
        self.assertEqual(self.client.delete(f'/api/entries/{entry_id}/').status_code, 404)
        self.assertTrue(Entry.objects.filter(pk=new_id).exists())

    def test_edit_missing_or_malformed_entry(self):
        self.assertEqual(self.client.patch('/api/entries/999/', '{}', content_type='application/json').status_code, 404)
        entry_id = self.create().json()['entry']['id']
        for body in ['{', '[]', 'null']:
            self.assertEqual(self.client.patch(f'/api/entries/{entry_id}/', body, content_type='application/json').status_code, 400)

    def test_edit_and_delete_require_csrf(self):
        entry_id = self.create().json()['entry']['id']
        client = Client(enforce_csrf_checks=True)
        self.assertEqual(client.patch(f'/api/entries/{entry_id}/', '{}', content_type='application/json').status_code, 403)
        self.assertEqual(client.delete(f'/api/entries/{entry_id}/').status_code, 403)
        self.assertTrue(Entry.objects.filter(pk=entry_id).exists())


class ShutdownTests(TestCase):
    def test_unmanaged_server_does_not_offer_or_allow_shutdown(self):
        with override_settings(REALTIME_SHUTDOWN_FILE=''):
            self.assertFalse(self.client.get('/api/entries/').json()['can_shutdown'])
            self.assertEqual(self.client.post('/api/shutdown/').status_code, 409)

    def test_shutdown_requires_local_post_with_csrf_and_keeps_entries(self):
        Entry.objects.create(category='Research', description='Keep this task', started_at=timezone.now() - timedelta(minutes=5))
        with TemporaryDirectory() as directory:
            signal = Path(directory) / 'stop.signal'
            with override_settings(REALTIME_SHUTDOWN_FILE=str(signal)):
                client = Client(enforce_csrf_checks=True)
                self.assertTrue(client.get('/api/entries/').json()['can_shutdown'])
                token = client.cookies['csrftoken'].value
                self.assertEqual(client.get('/api/shutdown/').status_code, 405)
                self.assertEqual(client.post('/api/shutdown/').status_code, 403)
                self.assertEqual(client.post('/api/shutdown/', HTTP_X_CSRFTOKEN=token, REMOTE_ADDR='192.0.2.1').status_code, 403)
                self.assertFalse(signal.exists())
                response = client.post('/api/shutdown/', HTTP_X_CSRFTOKEN=token)
                self.assertEqual(response.json(), {'stopping': True})
                self.assertEqual(signal.read_text(), 'stop')
                self.assertEqual(Entry.objects.count(), 1)
                self.assertFalse(Entry.objects.get().is_submitted)

    def test_shutdown_io_failure_is_reported(self):
        with TemporaryDirectory() as directory, override_settings(REALTIME_SHUTDOWN_FILE=directory):
            self.assertEqual(self.client.post('/api/shutdown/').status_code, 503)
