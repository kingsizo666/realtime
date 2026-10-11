from ipaddress import ip_address
from pathlib import Path

from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.http import require_POST


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
