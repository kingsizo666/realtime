import json

from django.test import Client, TestCase

from .models import Notepad


class NotepadTests(TestCase):
    def test_latest_notes_persist_across_sessions_and_clear_stays_empty(self):
        self.assertEqual(self.client.get('/api/notepad/').json(), {'notes': '', 'exists': False})
        for notes in ['First version', 'Latest findings\n\n  Next steps ✓', '']:
            response = self.client.put('/api/notepad/', json.dumps({'notes': notes}), content_type='application/json')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(Client().get('/api/notepad/').json(), {'notes': notes, 'exists': True})
            self.assertEqual(Notepad.objects.count(), 1)
            self.assertEqual(response['Cache-Control'], 'no-store')

    def test_invalid_changes_leave_saved_notes_intact(self):
        Notepad.objects.create(pk=1, notes='Keep these notes')
        for body in ['{', '[]', '{}', '{"notes": null}', '{"notes": 42}']:
            self.assertEqual(self.client.put('/api/notepad/', body, content_type='application/json').status_code, 400)
        self.assertEqual(Notepad.objects.get(pk=1).notes, 'Keep these notes')

    def test_notes_require_local_requests_and_csrf_for_writes(self):
        self.assertEqual(self.client.get('/api/notepad/', REMOTE_ADDR='192.0.2.1').status_code, 403)
        client = Client(enforce_csrf_checks=True)
        client.get('/api/notepad/')
        self.assertEqual(client.put('/api/notepad/', '{"notes":"Test"}', content_type='application/json').status_code, 403)
        response = client.put('/api/notepad/', '{"notes":"Test"}', content_type='application/json', HTTP_X_CSRFTOKEN=client.cookies['csrftoken'].value)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.delete('/api/notepad/').status_code, 405)
