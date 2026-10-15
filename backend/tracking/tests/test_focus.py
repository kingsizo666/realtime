import json
from datetime import timedelta
from unittest.mock import patch

from django.test import Client, TestCase, override_settings
from django.utils import timezone

from .. import blocking
from ..models import BlockedApp, FocusSession


@override_settings(REALTIME_HELPER_TOKEN='test-native-token')
class FocusTests(TestCase):
    def setUp(self):
        with blocking.lock:
            blocking.presence.update(seen=0, ready=False, apps=[], last_blocked='', error='')
        self.now = timezone.now()
        clock_patch = patch('tracking.views.focus.timezone.now', return_value=self.now)
        self.clock = clock_patch.start()
        self.addCleanup(clock_patch.stop)

    def helper(self, **extra):
        data = {'ready': True, 'apps': [{'name': 'Example', 'path': r'C:\Apps\Example.exe'}], **extra}
        return self.client.post('/api/focus/helper/', json.dumps(data), content_type='application/json', HTTP_X_REALTIME_HELPER='test-native-token')

    def command(self, action, **extra):
        saved = FocusSession.objects.filter(pk=1).first()
        return self.client.post('/api/focus/', json.dumps({'action': action, 'revision': saved.revision if saved else 0, **extra}), content_type='application/json')

    def test_existing_browser_timer_imports_once_without_losing_its_deadline(self):
        self.helper()
        self.assertFalse(self.client.get('/api/focus/').json()['exists'])
        deadline = self.now + timedelta(minutes=7)
        data = self.command('restore', minutes=10, remaining_ms=600000, deadline=deadline.timestamp() * 1000).json()
        self.assertEqual(data['focus']['minutes'], 10)
        self.assertEqual(FocusSession.objects.get().deadline, deadline)
        self.command('restore', minutes=1, remaining_ms=60000)
        self.assertEqual(FocusSession.objects.get().minutes, 10)
        self.assertFalse(FocusSession.objects.get().block_enabled)

    def test_pause_resume_reset_and_restart_preserve_remaining_time(self):
        self.command('start', minutes=10)
        self.clock.return_value = self.now + timedelta(minutes=2)
        self.command('pause')
        self.assertEqual(FocusSession.objects.get().remaining_ms, 480000)
        self.assertIsNone(FocusSession.objects.get().deadline)
        self.clock.return_value = self.now + timedelta(minutes=5)
        data = self.command('start').json()['focus']
        self.assertEqual(FocusSession.objects.get().deadline, self.now + timedelta(minutes=13))
        self.assertEqual(Client().get('/api/focus/').json()['focus'], data)
        self.command('reset')
        self.assertEqual(FocusSession.objects.get().remaining_ms, 600000)
        self.assertIsNone(FocusSession.objects.get().deadline)

    def test_session_expires_even_without_browser_ticks(self):
        self.command('start', minutes=1)
        self.clock.return_value = self.now + timedelta(days=1)
        self.helper()
        state = FocusSession.objects.get()
        self.assertTrue(state.completed)
        self.assertIsNone(state.deadline)
        self.assertEqual(state.remaining_ms, 0)
        self.command('start')
        self.assertEqual(FocusSession.objects.get().remaining_ms, 60000)

    def test_native_pause_releases_and_updates_shared_timer(self):
        self.command('start', minutes=1)
        self.clock.return_value = self.now + timedelta(seconds=15)
        data = self.helper(pause=True).json()['focus']
        self.assertIsNone(data['deadline'])
        self.assertEqual(data['remaining_ms'], 45000)
        revision = data['revision']
        self.assertEqual(self.helper(pause=True).json()['focus']['revision'], revision)

    def test_blocking_requires_a_live_helper_and_selected_apps(self):
        self.command('blocking', enabled=True)
        self.assertEqual(self.command('start').status_code, 400)
        self.helper()
        self.assertEqual(self.command('start').status_code, 400)
        self.client.post('/api/blocked-apps/', {'path': r'C:\Apps\Example.exe'}, content_type='application/json')
        self.assertEqual(self.command('start').status_code, 200)
        self.assertEqual(self.command('blocking', enabled=False).status_code, 400)
        self.command('pause')
        with blocking.lock:
            blocking.presence['seen'] = 0
        self.assertEqual(self.command('start').status_code, 400)
        self.command('blocking', enabled=False)
        self.assertEqual(self.command('start').status_code, 200)

    def test_running_apps_are_normalized_and_only_discovered_apps_can_be_added(self):
        self.helper(apps=[{'name': 'Example', 'path': r'C:\Apps\EXAMPLE.EXE'},
                          {'name': 'Other', 'path': r'C:\Apps\example.exe'},
                          {'name': 'Browser', 'path': r'C:\Apps\brave.exe'}])
        status = self.client.get('/api/blocked-apps/').json()
        self.assertEqual(len(status['blocker']['running_apps']), 1)
        for _ in range(2):
            result = self.client.post('/api/blocked-apps/', {'path': r'C:\Apps\Example.exe'}, content_type='application/json')
            self.assertEqual(result.status_code, 200)
        self.assertEqual(BlockedApp.objects.count(), 1)
        self.assertEqual(BlockedApp.objects.get().path, r'c:\apps\example.exe')
        unknown = self.client.post('/api/blocked-apps/', {'path': r'C:\Unknown.exe'}, content_type='application/json')
        self.assertEqual(unknown.status_code, 400)
        app = BlockedApp.objects.get()
        self.client.delete(f'/api/blocked-apps/{app.pk}/')
        self.assertFalse(BlockedApp.objects.exists())

    def test_browser_and_system_tools_cannot_be_selected(self):
        for name in ['brave.exe', 'msedge.exe', 'duckduckgo.exe', 'Realtime.exe', 'explorer.exe', 'taskmgr.exe', 'powershell.exe']:
            path = 'C:\\Apps\\' + name
            self.helper(apps=[{'name': name, 'path': path}])
            result = self.client.post('/api/blocked-apps/', {'path': path}, content_type='application/json')
            self.assertEqual(result.status_code, 400)

    def test_untrusted_helper_cannot_set_app_list_or_pause_focus(self):
        self.command('start')
        for headers in [{}, {'HTTP_X_REALTIME_HELPER': 'wrong'}, {'HTTP_X_REALTIME_HELPER': 'test-native-token', 'REMOTE_ADDR': '192.0.2.1'}]:
            result = self.client.post('/api/focus/helper/', {'apps': [], 'pause': True}, content_type='application/json', **headers)
            self.assertEqual(result.status_code, 403)
        self.assertIsNotNone(FocusSession.objects.get().deadline)
        self.assertFalse(blocking.status()['available'])
        with override_settings(REALTIME_HELPER_TOKEN=''):
            self.assertEqual(self.helper().status_code, 403)

    def test_stale_window_cannot_overwrite_a_new_timer_state(self):
        self.command('start')
        result = self.command('reset', revision=0)
        self.assertEqual(result.status_code, 409)
        self.assertIsNotNone(FocusSession.objects.get().deadline)
        self.assertEqual(result.json()['focus']['revision'], 1)

    def test_invalid_data_does_not_modify_timer(self):
        self.command('restore')
        for data in [{'action': 'start', 'minutes': 0}, {'action': 'start', 'minutes': 181},
                     {'action': 'start', 'minutes': True}, {'action': 'blocking', 'enabled': 'yes'}, {'action': 'unknown'}]:
            self.assertEqual(self.command(**data).status_code, 400)
        self.assertIsNone(FocusSession.objects.get().deadline)
        for body in ['[]', '{', '{"apps": {}}', '{"apps": [1]}']:
            self.assertEqual(self.client.post('/api/focus/helper/', body, content_type='application/json', HTTP_X_REALTIME_HELPER='test-native-token').status_code, 400)

    def test_mutations_require_csrf_and_public_endpoints_are_loopback_only(self):
        client = Client(enforce_csrf_checks=True)
        client.get('/api/focus/')
        self.assertEqual(client.post('/api/focus/', {'action': 'start'}, content_type='application/json').status_code, 403)
        self.assertEqual(client.post('/api/blocked-apps/', {}, content_type='application/json').status_code, 403)
        self.assertEqual(client.delete('/api/blocked-apps/1/').status_code, 403)
        result = client.post('/api/focus/', {'action': 'start'}, content_type='application/json', HTTP_X_CSRFTOKEN=client.cookies['csrftoken'].value)
        self.assertEqual(result.status_code, 200)
        for url in ['/api/focus/', '/api/blocked-apps/']:
            self.assertEqual(client.get(url, REMOTE_ADDR='192.0.2.1').status_code, 403)
        self.assertEqual(result['Cache-Control'], 'no-store')

    def test_stale_helper_and_hook_failure_release_availability(self):
        self.helper(ready=False, error='Hook unavailable')
        self.assertFalse(blocking.status()['available'])
        self.assertEqual(blocking.status()['message'], 'Hook unavailable')
        self.helper()
        with patch('tracking.blocking.time.monotonic', return_value=blocking.presence['seen'] + 6):
            self.assertFalse(blocking.status()['available'])
            self.assertEqual(blocking.status()['running_apps'], [])
