import base64
import hashlib
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse

from django.test import Client, SimpleTestCase

from .spotify import REDIRECT_URI, SCOPES, SpotifyError, SpotifyService
from .spotify_views import STATE_COOKIE

CLIENT_ID = 'a' * 32
TOKENS = {'access_token': 'test-access', 'refresh_token': 'test-refresh', 'expires_in': 3600}
PLAYBACK = {
    'device': {'id': 'desktop', 'name': 'My computer', 'is_restricted': False},
    'is_playing': True,
    'item': {'name': 'Test song', 'artists': [{'name': 'Test artist'}], 'external_urls': {'spotify': 'https://open.spotify.com/track/test'}},
    'actions': {'skipping_next': True},
}


class SpotifyTests(SimpleTestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.now = 1000
        self.service = SpotifyService(Path(self.directory.name), lambda: self.now)
        env = patch.dict('os.environ', {'SPOTIFY_CLIENT_ID': ''})
        env.start()
        self.addCleanup(env.stop)
        service = patch('tracking.spotify_views.get_spotify_service', return_value=self.service)
        service.start()
        self.addCleanup(service.stop)

    def authorize(self):
        self.service.begin_login('http://127.0.0.1:8000', CLIENT_ID)
        self.service.save_tokens(TOKENS, CLIENT_ID)

    def test_pkce_callback_binds_browser_and_rejects_replay_or_expiration(self):
        url, state = self.service.begin_login('http://127.0.0.1:8000', CLIENT_ID)
        query = parse_qs(urlparse(url).query)
        self.assertEqual(query['redirect_uri'], [REDIRECT_URI])
        self.assertEqual(query['scope'], [SCOPES])
        verifier = self.service.pending[state]['verifier']
        expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
        self.assertEqual(query['code_challenge'], [expected])
        with patch.object(self.service, 'token_request', return_value=TOKENS) as exchange:
            for cookie in ['', 'wrong', 'é']:
                with self.assertRaises(SpotifyError):
                    self.service.finish_login(state, cookie, 'code')
            exchange.assert_not_called()
            self.assertEqual(self.service.finish_login(state, state, 'code'), 'http://127.0.0.1:8000')
            self.assertEqual(exchange.call_args.args[0]['code_verifier'], verifier)
            with self.assertRaises(SpotifyError):
                self.service.finish_login(state, state, 'code')
            self.assertEqual(exchange.call_count, 1)
        _, state = self.service.begin_login('http://127.0.0.1:8000')
        self.now += 601
        with self.assertRaisesMessage(SpotifyError, 'expired'):
            self.service.finish_login(state, state, 'code')

    def test_status_without_setup_or_connection_makes_no_spotify_requests(self):
        with patch.object(self.service, 'send') as send:
            self.assertEqual(self.service.status(), {'configured': False, 'connected': False, 'playback': None})
            self.service.begin_login('http://127.0.0.1:8000', CLIENT_ID)
            self.assertEqual(self.service.status()['connected'], False)
            send.assert_not_called()

    def test_playback_metadata_restrictions_and_saved_connection(self):
        self.authorize()
        restored = SpotifyService(Path(self.directory.name), lambda: self.now)
        with patch.object(restored, 'send', return_value=PLAYBACK):
            status = restored.status()
        self.assertTrue(status['connected'])
        self.assertEqual(status['playback']['artist'], 'Test artist')
        self.assertEqual(status['playback']['name'], 'Test song')
        self.assertTrue(status['playback']['disallows']['skipping_next'])
        self.assertTrue(status['playback']['available'])
        self.assertNotIn('test-access', json.dumps(status))
        self.assertNotIn('test-refresh', json.dumps(status))
        with patch.object(restored, 'send', return_value=None):
            self.assertIsNone(restored.status()['playback'])
        with patch.object(restored, 'send', return_value={**PLAYBACK, 'device': {'id': 'restricted', 'is_restricted': True}}):
            self.assertFalse(restored.status()['playback']['available'])

    def test_refresh_keeps_old_refresh_token_and_retries_expired_access_once(self):
        self.authorize()
        self.now += 3600
        fresh = {'access_token': 'new-access', 'expires_in': 3600}
        with patch.object(self.service, 'token_request', return_value=fresh) as refresh, patch.object(self.service, 'send', return_value=PLAYBACK):
            self.assertTrue(self.service.status()['connected'])
            self.assertEqual(refresh.call_args.args[0]['refresh_token'], 'test-refresh')
        self.assertEqual(self.service.credentials()['refresh_token'], 'test-refresh')
        with patch.object(self.service, 'token_request', return_value=fresh) as refresh, patch.object(self.service, 'send', side_effect=[SpotifyError('Expired', 401), PLAYBACK]) as send:
            self.service.status()
            self.assertEqual(refresh.call_count, 1)
            self.assertEqual(send.call_count, 2)
        self.now += 3600
        with patch.object(self.service, 'token_request', side_effect=SpotifyError('Revoked', 401)):
            with self.assertRaises(SpotifyError):
                self.service.status()
        self.assertFalse(self.service.auth_file.exists())

    def test_cover_art_for_tracks_episodes_and_missing_images(self):
        self.authorize()
        cover = 'https://i.scdn.co/image/test-cover'
        cases = [
            ({'album': {'images': [{'url': cover}]}}, cover),
            ({'images': [{'url': cover}]}, cover),
            ({'images': [], 'show': {'images': [{'url': cover}]}}, cover),
            ({'album': {'images': None}}, ''),
            ({'album': {'images': [{'url': 'http://example.com/image'}, {'url': 'javascript:alert(1)'}, {'url': None}]}}, ''),
        ]
        for metadata, expected in cases:
            with self.subTest(metadata=metadata), patch.object(self.service, 'send', return_value={
                **PLAYBACK, 'item': {**PLAYBACK['item'], **metadata},
            }):
                self.assertEqual(self.client.get('/api/spotify/status/').json()['playback']['image_url'], expected)

    def test_commands_and_disconnect_preserve_configuration(self):
        self.authorize()
        with patch.object(self.service, 'send', return_value=None) as send:
            for action, method, path in [('play', 'PUT', '/play'), ('pause', 'PUT', '/pause'), ('next', 'POST', '/next'), ('previous', 'POST', '/previous')]:
                self.service.control(action)
                self.assertEqual(send.call_args.args[:2], ('https://api.spotify.com/v1/me/player' + path, method))
            for invalid in ['volume', None, ['next']]:
                with self.assertRaises(SpotifyError):
                    self.service.control(invalid)
        self.service.disconnect()
        self.assertFalse(self.service.auth_file.exists())
        self.assertEqual(self.service.client_id(), CLIENT_ID)
        self.assertEqual(self.service.pending, {})

    def test_successful_commands_accept_non_json_acknowledgments(self):
        self.authorize()
        for status, body in [(200, b'Accepted'), (202, b'OK'), (204, b''), (200, b'\n')]:
            with self.subTest(status=status, body=body):
                response = MagicMock()
                response.status = status
                response.read.return_value = body
                response.__enter__.return_value = response
                with patch('tracking.spotify.urlopen', return_value=response):
                    for action in ['play', 'pause', 'next', 'previous']:
                        result = self.client.post('/api/spotify/control/', json.dumps({'action': action}), content_type='application/json')
                        self.assertEqual(result.status_code, 200)
                        self.assertEqual(result.json(), {'sent': True})
                response.read.assert_not_called()

    def test_playback_json_and_network_errors_are_reported_separately(self):
        self.authorize()
        response = MagicMock()
        response.status = 200
        response.read.return_value = b'not-json'
        response.__enter__.return_value = response
        with patch('tracking.spotify.urlopen', return_value=response), self.assertRaisesMessage(SpotifyError, 'unexpected response'):
            self.service.status()
        with patch('tracking.spotify.urlopen', side_effect=TimeoutError), self.assertRaisesMessage(SpotifyError, 'Cannot reach Spotify'):
            self.service.control('pause')
        response.status = 204
        with patch('tracking.spotify.urlopen', return_value=response):
            self.assertIsNone(self.service.status()['playback'])

    def test_rate_limits_prevent_repeat_requests_and_errors_are_safe(self):
        self.authorize()
        error = HTTPError('https://api.spotify.com', 429, 'Rate limit', {'Retry-After': '20'}, io.BytesIO(b''))
        with patch('tracking.spotify.urlopen', side_effect=error) as send:
            with self.assertRaises(SpotifyError) as caught:
                self.service.status()
            self.assertEqual(caught.exception.retry_after, 20)
            with self.assertRaises(SpotifyError):
                self.service.status()
            self.assertEqual(send.call_count, 1)
        self.now += 21
        for status, expected in [(403, 403), (404, 409)]:
            error = HTTPError('https://api.spotify.com', status, 'Secret provider details', {}, io.BytesIO(b''))
            with patch('tracking.spotify.urlopen', side_effect=error), self.assertRaises(SpotifyError) as caught:
                self.service.status()
            self.assertEqual(caught.exception.status, expected)
            self.assertNotIn('Secret provider details', str(caught.exception))

    def test_routes_require_local_requests_post_and_csrf(self):
        self.assertEqual(self.client.get('/api/spotify/status/').json()['connected'], False)
        self.assertEqual(self.client.get('/api/spotify/status/', REMOTE_ADDR='192.0.2.1').status_code, 403)
        client = Client(enforce_csrf_checks=True)
        client.get('/api/spotify/status/')
        token = client.cookies['csrftoken'].value
        for path in ['connect', 'control', 'disconnect']:
            self.assertEqual(client.get(f'/api/spotify/{path}/').status_code, 405)
            self.assertEqual(client.post(f'/api/spotify/{path}/', '{}', content_type='application/json').status_code, 403)
        response = client.post('/api/spotify/connect/', json.dumps({'client_id': CLIENT_ID}), content_type='application/json', HTTP_X_CSRFTOKEN=token, HTTP_ORIGIN='http://127.0.0.1:8000', HTTP_HOST='127.0.0.1:8000')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.cookies[STATE_COOKIE]['httponly'])
        self.assertEqual(response.cookies[STATE_COOKIE]['samesite'], 'Lax')
        state = parse_qs(urlparse(response.json()['url']).query)['state'][0]
        with patch.object(self.service, 'token_request', return_value=TOKENS):
            callback = client.get('/spotify/callback', {'code': 'private-code', 'state': state})
        self.assertContains(callback, 'Spotify connected')
        for secret in ['private-code', 'test-access', 'test-refresh']:
            self.assertNotContains(callback, secret)
        self.assertEqual(callback['Cache-Control'], 'no-store')

    def test_invalid_settings_and_canceled_login_leave_tracking_independent(self):
        for body in ['{', '[]', '{"client_id": 17}', '{"client_id": "not-valid"}']:
            response = self.client.post('/api/spotify/connect/', body, content_type='application/json', HTTP_ORIGIN='http://127.0.0.1:8000')
            self.assertEqual(response.status_code, 400)
        response = self.client.post('/api/spotify/connect/', json.dumps({'client_id': CLIENT_ID}), content_type='application/json', HTTP_ORIGIN='http://127.0.0.1:8000')
        state = parse_qs(urlparse(response.json()['url']).query)['state'][0]
        with patch.object(self.service, 'token_request') as exchange:
            canceled = self.client.get('/spotify/callback', {'state': state, 'error': 'access_denied'})
            self.assertContains(canceled, 'connection canceled')
            exchange.assert_not_called()
        self.assertFalse(self.service.credentials())
