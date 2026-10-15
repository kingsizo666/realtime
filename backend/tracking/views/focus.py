import hmac
from datetime import timedelta
from ipaddress import ip_address

from django.conf import settings
from django.db import transaction
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt, ensure_csrf_cookie
from django.views.decorators.http import require_http_methods, require_POST

from .. import blocking
from ..models import BlockedApp, FocusSession
from .common import read_data


def response(data, status=200):
    result = JsonResponse(data, status=status)
    result['Cache-Control'] = 'no-store'
    return result


def local(request):
    try:
        return ip_address(request.META.get('REMOTE_ADDR', '')).is_loopback
    except ValueError:
        return False


def expire(session):
    if session.deadline and session.deadline <= timezone.now():
        session.deadline = None
        session.remaining_ms = 0
        session.completed = True
        session.revision += 1
        session.save()
    return session


def pause(session):
    if session.deadline:
        session.remaining_ms = max(0, round((session.deadline - timezone.now()).total_seconds() * 1000))
        session.deadline = None


def snapshot(session):
    return {'minutes': session.minutes, 'remaining_ms': session.remaining_ms,
            'deadline': session.deadline.isoformat() if session.deadline else None,
            'completed': session.completed, 'block_enabled': session.block_enabled,
            'revision': session.revision}


def payload(session):
    return {'exists': session is not None, 'focus': snapshot(session) if session else None,
            'blocker': blocking.status(), 'apps': [app.as_dict() for app in BlockedApp.objects.all()]}


@ensure_csrf_cookie
@require_http_methods(['GET', 'POST'])
def focus(request):
    if not local(request):
        return response({'error': 'Focus is available only on this computer.'}, 403)
    with transaction.atomic():
        session = FocusSession.objects.select_for_update().filter(pk=1).first()
        if session:
            expire(session)
        if request.method == 'GET':
            return response(payload(session))
        try:
            data = read_data(request)
            action = data.get('action')
            if action not in ('restore', 'start', 'pause', 'reset', 'blocking'):
                raise ValueError('Unknown focus action.')
            if action == 'restore' and session:
                return response(payload(session))
            if session and data.get('revision') != session.revision:
                return response({'error': 'Focus changed in another window. Try again.', **payload(session)}, 409)
            session = session or FocusSession(pk=1)
            minutes = data.get('minutes', session.minutes)
            if type(minutes) is not int or not 1 <= minutes <= 180:
                raise ValueError('Choose 1 to 180 minutes.')
            if action in ('restore', 'start', 'reset') and not session.deadline and minutes != session.minutes:
                session.minutes = minutes
                session.remaining_ms = minutes * 60000
            if action == 'restore':
                remaining = data.get('remaining_ms', session.remaining_ms)
                if type(remaining) not in (int, float) or not 0 <= remaining <= minutes * 60000:
                    raise ValueError('Invalid remaining time.')
                session.remaining_ms = int(remaining)
                deadline = data.get('deadline')
                if deadline is not None:
                    if type(deadline) not in (int, float):
                        raise ValueError('Invalid focus deadline.')
                    delta = deadline / 1000 - timezone.now().timestamp()
                    if delta > minutes * 60 + 5:
                        raise ValueError('Invalid focus deadline.')
                    session.deadline = timezone.now() + timedelta(seconds=max(0, delta))
                session.completed = session.remaining_ms == 0 and data.get('completed') is True
            elif action == 'blocking':
                if session.deadline:
                    raise ValueError('Pause focus before changing app blocking.')
                if type(data.get('enabled')) is not bool:
                    raise ValueError('Provide a blocking preference.')
                session.block_enabled = data['enabled']
            elif action == 'start' and not session.deadline:
                if session.block_enabled and (not blocking.status()['available'] or not BlockedApp.objects.exists()):
                    raise ValueError('Open Realtime.exe and select apps in Configuration before starting with blocking.')
                if session.remaining_ms <= 0:
                    session.remaining_ms = session.minutes * 60000
                session.deadline = timezone.now() + timedelta(milliseconds=session.remaining_ms)
                session.completed = False
            elif action == 'pause':
                pause(session)
            elif action == 'reset':
                session.deadline = None
                session.remaining_ms = session.minutes * 60000
                session.completed = False
            session.revision += 1
            session.save()
            expire(session)
            return response(payload(session))
        except (ValueError, TypeError, OverflowError) as error:
            return response({'error': str(error)}, 400)


@ensure_csrf_cookie
@require_http_methods(['GET', 'POST', 'DELETE'])
def blocked_apps(request, app_id=None):
    if not local(request):
        return response({'error': 'App selection is available only on this computer.'}, 403)
    try:
        if request.method == 'POST':
            data = read_data(request)
            path = blocking.normalize_path(data.get('path'))
            available = blocking.status()
            app = next((app for app in available['running_apps'] if app['path'] == path), None)
            if not available['available'] or not app:
                raise ValueError('Open the app, then refresh the running apps list.')
            BlockedApp.objects.get_or_create(path=path, defaults={'name': app['name']})
        elif request.method == 'DELETE':
            if app_id is None:
                raise ValueError('Choose an app to remove.')
            BlockedApp.objects.filter(pk=app_id).delete()
        return response({'apps': [app.as_dict() for app in BlockedApp.objects.all()], 'blocker': blocking.status()})
    except (ValueError, TypeError) as error:
        return response({'error': str(error)}, 400)


@csrf_exempt
@require_POST
def helper(request):
    token = settings.REALTIME_HELPER_TOKEN
    supplied = request.headers.get('X-Realtime-Helper', '')
    if not local(request) or not token or not hmac.compare_digest(token.encode(), supplied.encode()):
        return response({'error': 'Native helper authentication required.'}, 403)
    try:
        data = read_data(request)
        if not isinstance(data.get('apps'), list) or not all(isinstance(item, dict) for item in data['apps']):
            raise ValueError('Invalid app list.')
        blocking.heartbeat(data)
        with transaction.atomic():
            session = FocusSession.objects.select_for_update().filter(pk=1).first()
            if session:
                expire(session)
                if data.get('pause') is True and session.deadline:
                    pause(session)
                    session.revision += 1
                    session.save()
            return response(payload(session))
    except (ValueError, TypeError) as error:
        return response({'error': str(error)}, 400)
