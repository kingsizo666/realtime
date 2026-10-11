import json
from ipaddress import ip_address

from django.http import JsonResponse
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_http_methods

from ..models import Notepad


@ensure_csrf_cookie
@require_http_methods(['GET', 'PUT'])
def notepad(request):
    try:
        if not ip_address(request.META.get('REMOTE_ADDR', '')).is_loopback:
            return JsonResponse({'error': 'Notes are available only on this computer.'}, status=403)
    except ValueError:
        return JsonResponse({'error': 'Notes are available only on this computer.'}, status=403)
    if request.method == 'GET':
        saved = Notepad.objects.filter(pk=1).first()
        response = JsonResponse({'notes': saved.notes if saved else '', 'exists': saved is not None})
    else:
        try:
            data = json.loads(request.body)
            if not isinstance(data, dict) or not isinstance(data.get('notes'), str):
                raise ValueError
        except (ValueError, UnicodeDecodeError):
            return JsonResponse({'error': 'Please provide notes as text.'}, status=400)
        saved, _ = Notepad.objects.update_or_create(pk=1, defaults={'notes': data['notes']})
        response = JsonResponse({'notes': saved.notes, 'exists': True})
    response['Cache-Control'] = 'no-store'
    return response
