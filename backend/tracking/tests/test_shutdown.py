from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

from django.test import Client, TestCase, override_settings
from django.utils import timezone

from ..models import Entry


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
