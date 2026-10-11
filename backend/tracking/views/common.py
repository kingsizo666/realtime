import json

from django.http import JsonResponse


def csrf_failure(request, reason=''):
    return JsonResponse({'error': 'Your session expired. Refresh the page and try again.'}, status=403)


def read_data(request, allow_empty=False):
    if allow_empty and request.content_type in ('multipart/form-data', 'application/x-www-form-urlencoded') and not request.POST:
        return {}
    data = json.loads(request.body or (b'{}' if allow_empty else b''))
    if not isinstance(data, dict):
        raise ValueError('Please provide an entry object.')
    return data
