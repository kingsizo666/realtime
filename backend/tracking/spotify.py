"""Spotify Connect controller for this local, single-user app."""
import base64
import hashlib
import json
import os
import re
import secrets
import threading
import time
from functools import lru_cache
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from django.conf import settings

REDIRECT_URI = 'http://127.0.0.1:8000/spotify/callback'
SCOPES = 'user-read-playback-state user-modify-playback-state'
CLIENT_ID_PATTERN = re.compile(r'^[a-fA-F0-9]{32}$')


class SpotifyError(Exception):
    def __init__(self, message, status=400, retry_after=0):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


class SpotifyService:
    def __init__(self, directory, clock=time.time):
        self.config_file = directory / 'spotify.config.json'
        self.auth_file = directory / '.spotify-auth.json'
        self.clock = clock
        self.lock = threading.RLock()
        self.pending = {}
        self.blocked_until = 0

    def read_json(self, path):
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def write_json(self, path, data):
        temporary = path.with_suffix('.tmp')
        try:
            with open(temporary, 'w', encoding='utf-8') as handle:
                json.dump(data, handle)
            temporary.replace(path)
        except OSError:
            raise SpotifyError('Could not save Spotify settings. Check the project folder permissions.', 503)

    def client_id(self):
        value = os.getenv('SPOTIFY_CLIENT_ID') or self.read_json(self.config_file).get('client_id', '')
        return value if isinstance(value, str) and CLIENT_ID_PATTERN.fullmatch(value) else ''

    def credentials(self):
        saved = self.read_json(self.auth_file)
        if saved.get('client_id') != self.client_id():
            return {}
        if not all(isinstance(saved.get(key), str) and saved[key] for key in ('access_token', 'refresh_token')):
            return {}
        if not isinstance(saved.get('expires_at'), (float, int)):
            return {}
        return saved

    def begin_login(self, origin, client_id=''):
        with self.lock:
            if client_id:
                if not isinstance(client_id, str) or not CLIENT_ID_PATTERN.fullmatch(client_id):
                    raise SpotifyError('Enter the 32-character Client ID from your Spotify app.')
                if os.getenv('SPOTIFY_CLIENT_ID') and client_id != self.client_id():
                    raise SpotifyError('The Client ID is configured through SPOTIFY_CLIENT_ID.')
                self.write_json(self.config_file, {'client_id': client_id})
            client_id = self.client_id()
            if not client_id:
                raise SpotifyError('Set up your Spotify app and enter its Client ID first.')
            state = secrets.token_urlsafe(32)
            verifier = secrets.token_urlsafe(64)
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
            self.pending = {key: value for key, value in self.pending.items() if value['expires_at'] > self.clock()}
            self.pending[state] = {'verifier': verifier, 'client_id': client_id, 'origin': origin, 'expires_at': self.clock() + 600}
            url = 'https://accounts.spotify.com/authorize?' + urlencode({
                'client_id': client_id, 'response_type': 'code', 'redirect_uri': REDIRECT_URI,
                'scope': SCOPES, 'state': state, 'code_challenge_method': 'S256', 'code_challenge': challenge,
            })
            return url, state

    def finish_login(self, state, cookie, code, denied=False):
        with self.lock:
            if not state or not cookie or not state.isascii() or not cookie.isascii() or not secrets.compare_digest(state, cookie):
                raise SpotifyError('Spotify sign-in could not be verified. Connect again.')
            pending = self.pending.pop(state, None)
            if not pending or pending['expires_at'] <= self.clock():
                raise SpotifyError('Spotify sign-in expired. Connect again.')
            if denied:
                raise SpotifyError('Spotify connection canceled.')
            if not code:
                raise SpotifyError('Spotify did not return a sign-in code. Connect again.')
            if pending['client_id'] != self.client_id():
                raise SpotifyError('Spotify settings changed. Connect again.')
            tokens = self.token_request({
                'grant_type': 'authorization_code', 'code': code, 'code_verifier': pending['verifier'],
                'redirect_uri': REDIRECT_URI, 'client_id': pending['client_id'],
            })
            self.save_tokens(tokens, pending['client_id'])
            return pending['origin']

    def send(self, url, method='GET', headers=None, data=None, *, expect_json=True):
        if self.clock() < self.blocked_until:
            raise SpotifyError('Spotify is busy. Please wait before trying again.', 429, max(1, int(self.blocked_until - self.clock()) + 1))
        request = Request(url, data=data, headers=headers or {}, method=method)
        try:
            with urlopen(request, timeout=8) as response:
                # Playback commands have no JSON payload to consume. Spotify
                # can acknowledge them with an empty or plain-text response.
                if not expect_json or response.status == 204:
                    return None
                body = response.read()
                try:
                    return json.loads(body) if body.strip() else None
                except ValueError:
                    raise SpotifyError('Spotify returned an unexpected response. Please try again.', 502)
        except HTTPError as error:
            if error.code == 429:
                try:
                    delay = max(1, int(error.headers.get('Retry-After', '30')))
                except ValueError:
                    delay = 30
                self.blocked_until = self.clock() + delay
                raise SpotifyError('Spotify is busy. Please wait before trying again.', 429, delay)
            if error.code == 401:
                raise SpotifyError('Reconnect Spotify to continue.', 401)
            if error.code == 403:
                raise SpotifyError('Spotify denied access. Check Premium and your app’s authorized users.', 403)
            if error.code == 404:
                raise SpotifyError('Open Spotify on your computer or phone and start a song.', 409)
            if url == 'https://accounts.spotify.com/api/token' and error.code == 400:
                raise SpotifyError('Spotify sign-in expired or was revoked. Connect again.', 401)
            raise SpotifyError('Spotify could not complete that request. Please try again.', 502)
        except (URLError, TimeoutError, OSError):
            raise SpotifyError('Cannot reach Spotify. Check your internet connection and try again.', 502)

    def token_request(self, parameters):
        return self.send('https://accounts.spotify.com/api/token', 'POST',
                         {'Content-Type': 'application/x-www-form-urlencoded'}, urlencode(parameters).encode())

    def save_tokens(self, tokens, client_id, previous=None):
        if not isinstance(tokens, dict):
            raise SpotifyError('Spotify returned an invalid sign-in response.', 502)
        refresh = tokens.get('refresh_token') or (previous or {}).get('refresh_token')
        access = tokens.get('access_token')
        expires = tokens.get('expires_in')
        if not isinstance(access, str) or not access or not isinstance(refresh, str) or not refresh or not isinstance(expires, (int, float)) or expires <= 0:
            raise SpotifyError('Spotify returned an invalid sign-in response.', 502)
        saved = {'client_id': client_id, 'access_token': access, 'refresh_token': refresh, 'expires_at': self.clock() + expires}
        self.write_json(self.auth_file, saved)
        return saved

    def access_token(self, force=False):
        saved = self.credentials()
        if not saved:
            raise SpotifyError('Connect Spotify first.', 401)
        if force or saved['expires_at'] <= self.clock() + 30:
            try:
                tokens = self.token_request({'grant_type': 'refresh_token', 'refresh_token': saved['refresh_token'], 'client_id': saved['client_id']})
                saved = self.save_tokens(tokens, saved['client_id'], saved)
            except SpotifyError as error:
                if error.status == 401:
                    self.disconnect()
                raise
        return saved['access_token']

    def api(self, path, method='GET'):
        token = self.access_token()
        url = 'https://api.spotify.com/v1/me/player' + path
        try:
            return self.send(url, method, {'Authorization': 'Bearer ' + token}, expect_json=method == 'GET')
        except SpotifyError as error:
            if error.status != 401:
                raise
            token = self.access_token(force=True)
            try:
                return self.send(url, method, {'Authorization': 'Bearer ' + token}, expect_json=method == 'GET')
            except SpotifyError as retry_error:
                if retry_error.status == 401:
                    self.disconnect()
                raise

    def status(self):
        with self.lock:
            result = {'configured': bool(self.client_id()), 'connected': bool(self.credentials()), 'playback': None}
            if not result['connected']:
                return result
            data = self.api('?additional_types=track,episode')
            if not data:
                return result
            device = data.get('device') or {}
            item = data.get('item') or {}
            images = (item.get('album') or {}).get('images') or item.get('images') or (item.get('show') or {}).get('images') or []
            image_url = ''
            for image in images:
                candidate = image.get('url') if isinstance(image, dict) else None
                if isinstance(candidate, str) and candidate.startswith('https://'):
                    parsed = urlsplit(candidate)
                    if parsed.hostname and not parsed.username and not parsed.password:
                        image_url = candidate
                        break
            url = (item.get('external_urls') or {}).get('spotify', '')
            # Link metadata only to Spotify, never to an arbitrary supplied URL.
            if not isinstance(url, str) or not url.startswith('https://open.spotify.com/'):
                url = 'https://open.spotify.com/'
            actions = data.get('actions') or {}
            result['playback'] = {
                'name': item.get('name', ''),
                'artist': ', '.join(artist.get('name', '') for artist in item.get('artists', [])) or (item.get('show') or {}).get('publisher', ''),
                'url': url, 'image_url': image_url, 'is_playing': data.get('is_playing') is True,
                'device': device.get('name', ''),
                'available': bool(device.get('id')) and not device.get('is_restricted', False),
                'disallows': actions.get('disallows', actions),
            }
            return result

    def control(self, action):
        commands = {'play': ('/play', 'PUT'), 'pause': ('/pause', 'PUT'), 'next': ('/next', 'POST'), 'previous': ('/previous', 'POST')}
        if not isinstance(action, str) or action not in commands:
            raise SpotifyError('Choose play, pause, next, or previous.')
        with self.lock:
            self.api(*commands[action])

    def disconnect(self):
        with self.lock:
            try:
                self.auth_file.unlink(missing_ok=True)
            except OSError:
                raise SpotifyError('Could not remove the saved Spotify connection.', 503)
            self.pending.clear()


@lru_cache(maxsize=1)
def get_spotify_service():
    return SpotifyService(settings.BASE_DIR)
