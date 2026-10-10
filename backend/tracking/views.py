import json
from ipaddress import ip_address
from pathlib import Path
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.conf import settings
from django.db import IntegrityError
from django.http import JsonResponse, HttpResponse
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_http_methods, require_POST
from django.views.static import serve

from .models import CATEGORIES, Entry


def csrf_failure(request, reason=''):
    return JsonResponse({'error': 'Your session expired. Refresh the page and try again.'}, status=403)


def parse_timestamp(value, label):
    if not isinstance(value, str):
        raise ValueError(f'{label} is required.')
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise ValueError(f'{label} must be a valid date and time.')
    if timezone.is_naive(result):
        raise ValueError(f'{label} must include a timezone.')
    return result


def read_data(request, allow_empty=False):
    if allow_empty and request.content_type in ('multipart/form-data', 'application/x-www-form-urlencoded') and not request.POST:
        return {}
    data = json.loads(request.body or (b'{}' if allow_empty else b''))
    if not isinstance(data, dict):
        raise ValueError('Please provide an entry object.')
    return data


def validate_entry(data, entry=None, final_end=None):
    category = data.get('category', entry.category if entry else None)
    description = data.get('description', entry.description if entry else '')
    if category not in CATEGORIES:
        raise ValueError('Choose one of the available categories.')
    if not isinstance(description, str):
        raise ValueError('Description must be text.')
    description = description.strip()
    if len(description) > 1000:
        raise ValueError('Description must be 1,000 characters or fewer.')
    if 'started_at' in data:
        started_at = parse_timestamp(data['started_at'], 'Start time')
    elif entry:
        started_at = entry.started_at
    else:
        raise ValueError('Start time is required.')
    try:
        zone = ZoneInfo(data.get('timezone', settings.TIME_ZONE))
    except (ZoneInfoNotFoundError, TypeError, ValueError):
        raise ValueError('Choose a valid timezone.')
    ended_at = final_end
    if final_end is not None:
        # Use the server's current clock time on the entry's own calendar date.
        start_local = started_at.astimezone(zone)
        end_clock = final_end.astimezone(zone).timetz().replace(tzinfo=None)
        end_date = start_local.date()
        if end_clock < start_local.time():
            end_date += timedelta(days=1)
        ended_at = datetime.combine(end_date, end_clock, tzinfo=zone)
    if final_end is None:
        if 'ended_at' in data:
            ended_at = parse_timestamp(data['ended_at'], 'End time') if data['ended_at'] else None
        elif entry:
            ended_at = entry.ended_at
    if started_at > timezone.now():
        raise ValueError('Start time cannot be in the future.')
    if ended_at and ended_at < started_at:
        raise ValueError('End time cannot be before start time.')
    if ended_at and (not entry or final_end is not None or 'started_at' in data or 'ended_at' in data):
        start_local = started_at.astimezone(zone)
        end_local = ended_at.astimezone(zone)
        expected_date = start_local.date()
        if end_local.time() < start_local.time():
            expected_date += timedelta(days=1)
        if end_local.date() != expected_date:
            raise ValueError('End time must be on the entry date, or the next day when its clock time is earlier than start time.')
    if entry and entry.is_submitted and ended_at is None:
        raise ValueError('A submitted entry must have an end time.')
    return {'category': category, 'description': description, 'started_at': started_at, 'ended_at': ended_at}


@ensure_csrf_cookie
@require_http_methods(['GET', 'POST'])
def entries(request):
    if request.method == 'GET':
        return JsonResponse({'entries': [entry.as_dict() for entry in Entry.objects.all()], 'categories': CATEGORIES, 'can_shutdown': bool(settings.REALTIME_SHUTDOWN_FILE)})
    try:
        values = validate_entry(read_data(request))
        if Entry.objects.filter(is_submitted=False).exists():
            return JsonResponse({'error': 'Submit your unfinished entry before adding another.'}, status=409)
        entry = Entry.objects.create(**values)
        return JsonResponse({'entry': entry.as_dict()}, status=201)
    except (ValueError, UnicodeDecodeError) as error:
        return JsonResponse({'error': str(error)}, status=400)
    except IntegrityError:
        return JsonResponse({'error': 'An unfinished entry already exists. Refresh to resume it.'}, status=409)


@require_POST
def finish(request, entry_id):
    # A conditional update makes duplicate submissions safe, including across tabs.
    now = timezone.now()
    entry = Entry.objects.filter(pk=entry_id).first()
    if entry is None:
        return JsonResponse({'error': 'This entry no longer exists.'}, status=404)
    if not entry.is_submitted:
        try:
            data = read_data(request, allow_empty=True)
            selected_end = data.get('ended_at', entry.ended_at)
            if selected_end and 'ended_at' not in data:
                data['ended_at'] = entry.ended_at.isoformat()
            values = validate_entry(data, entry, final_end=None if selected_end else now)
        except (ValueError, UnicodeDecodeError) as error:
            return JsonResponse({'error': str(error)}, status=400)
        Entry.objects.filter(pk=entry_id, is_submitted=False).update(**values, is_submitted=True)
        entry.refresh_from_db()
    return JsonResponse({'entry': entry.as_dict()})


@require_http_methods(['PATCH', 'DELETE'])
def entry_detail(request, entry_id):
    entry = Entry.objects.filter(pk=entry_id).first()
    if entry is None:
        return JsonResponse({'error': 'This entry no longer exists.'}, status=404)
    if request.method == 'DELETE':
        entry.delete()
        return JsonResponse({'deleted_id': entry_id})
    try:
        values = validate_entry(read_data(request), entry)
        # Do not overwrite a submission that happened in another browser tab.
        updated = Entry.objects.filter(pk=entry_id, is_submitted=entry.is_submitted).update(**values)
        if not updated:
            return JsonResponse({'error': 'This entry changed in another tab. Refresh and try again.'}, status=409)
        entry.refresh_from_db()
        return JsonResponse({'entry': entry.as_dict()})
    except (ValueError, UnicodeDecodeError) as error:
        return JsonResponse({'error': str(error)}, status=400)


@ensure_csrf_cookie
def frontend(request):
    index = settings.PROJECT_DIR / 'frontend' / 'dist' / 'index.html'
    if not index.exists():
        return HttpResponse('Build the frontend with npm.cmd run build in frontend/, or use the Vite development server.', status=503)
    return HttpResponse(index.read_text(encoding='utf-8'))


def frontend_asset(request, path):
    return serve(request, path, document_root=settings.PROJECT_DIR / 'frontend' / 'dist' / 'assets')


@require_POST
def shutdown(request):
    if not settings.REALTIME_SHUTDOWN_FILE:
        return JsonResponse({'error': 'Open the app using Realtime.exe to use Stop app.'}, status=409)
    try:
        local_request = ip_address(request.META.get('REMOTE_ADDR', '')).is_loopback
    except ValueError:
        local_request = False
    if not local_request:
        return JsonResponse({'error': 'The app can only be stopped from this computer.'}, status=403)
    try:
        Path(settings.REALTIME_SHUTDOWN_FILE).write_text('stop', encoding='utf-8')
    except OSError:
        return JsonResponse({'error': 'Could not stop the app. Please try again.'}, status=503)
    return JsonResponse({'stopping': True})
