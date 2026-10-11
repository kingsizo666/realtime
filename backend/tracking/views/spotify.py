import json
from functools import wraps
from html import escape
from ipaddress import ip_address

from django.http import HttpResponse, JsonResponse
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from ..spotify import SpotifyError, get_spotify_service
from .common import read_data

APP_ORIGINS = ('http://127.0.0.1:8000', 'http://127.0.0.1:5173')
STATE_COOKIE = 'realtime_spotify_state'


def local_only(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        try:
            local = ip_address(request.META.get('REMOTE_ADDR', '')).is_loopback
        except ValueError:
            local = False
        if not local:
            return JsonResponse({'error': 'Spotify control is available only on this computer.'}, status=403)
        return view(request, *args, **kwargs)
    return wrapped


def error_response(error):
    response = JsonResponse({'error': str(error), 'retry_after': error.retry_after}, status=error.status)
    if error.retry_after:
        response['Retry-After'] = str(error.retry_after)
    response['Cache-Control'] = 'no-store'
    return response


@require_GET
@local_only
@ensure_csrf_cookie
def status(request):
    try:
        response = JsonResponse(get_spotify_service().status())
        response['Cache-Control'] = 'no-store'
        return response
    except SpotifyError as error:
        return error_response(error)


@require_POST
@local_only
def connect(request):
    try:
        origin = request.headers.get('Origin') or request.build_absolute_uri('/').rstrip('/')
        if origin not in APP_ORIGINS:
            raise SpotifyError('Open Realtime at http://127.0.0.1:8000 to connect Spotify.')
        data = read_data(request, allow_empty=True)
        client_id = data.get('client_id', '')
        if not isinstance(client_id, str):
            raise SpotifyError('Enter the Client ID from your Spotify app.')
        url, state = get_spotify_service().begin_login(origin, client_id.strip())
        response = JsonResponse({'url': url})
        response.set_cookie(STATE_COOKIE, state, max_age=600, httponly=True, samesite='Lax', path='/spotify/callback')
        response['Cache-Control'] = 'no-store'
        return response
    except SpotifyError as error:
        return error_response(error)
    except (ValueError, UnicodeDecodeError):
        return error_response(SpotifyError('Please provide valid Spotify settings.'))


@require_GET
@local_only
def callback(request):
    success = False
    message = 'Spotify connected. You can close this window.'
    service = get_spotify_service()
    with service.lock:
        origin = service.pending.get(request.GET.get('state', ''), {}).get('origin', APP_ORIGINS[0])
    try:
        origin = service.finish_login(request.GET.get('state', ''), request.COOKIES.get(STATE_COOKIE, ''),
                                      request.GET.get('code', ''), bool(request.GET.get('error')))
        success = True
    except SpotifyError as error:
        message = str(error)
    payload = json.dumps({'type': 'realtime-spotify', 'success': success, 'error': '' if success else message}).replace('<', '\\u003c')
    # No authorization codes or tokens are passed to browser JavaScript.
    response = HttpResponse(f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Spotify connection</title></head>
<body><p>{escape(message)}</p><script>
if (window.opener) {{
  window.opener.postMessage({payload}, {json.dumps(origin)});
  window.close();
}}
</script></body></html>''')
    response.delete_cookie(STATE_COOKIE, path='/spotify/callback', samesite='Lax')
    response['Cache-Control'] = 'no-store'
    response['Referrer-Policy'] = 'no-referrer'
    return response


@require_POST
@local_only
def control(request):
    try:
        get_spotify_service().control(read_data(request).get('action'))
        return JsonResponse({'sent': True})
    except SpotifyError as error:
        return error_response(error)
    except (ValueError, UnicodeDecodeError):
        return error_response(SpotifyError('Please provide a valid playback action.'))


@require_POST
@local_only
def disconnect(request):
    try:
        get_spotify_service().disconnect()
        return JsonResponse({'disconnected': True})
    except SpotifyError as error:
        return error_response(error)
