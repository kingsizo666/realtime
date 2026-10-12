import json

from django.db import IntegrityError, transaction
from django.http import JsonResponse
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_http_methods

from ..models import Category, Entry


def category_list(status=200):
    response = JsonResponse({'categories': [item.as_dict() for item in Category.objects.filter(is_active=True)]}, status=status)
    response['Cache-Control'] = 'no-store'
    return response


def read_name(request):
    try:
        data = json.loads(request.body)
    except (ValueError, UnicodeDecodeError):
        raise ValueError('Enter a category name.')
    name = data.get('name') if isinstance(data, dict) else None
    if not isinstance(name, str) or not name.strip():
        raise ValueError('Enter a category name.')
    name = name.strip()
    if len(name) > 40:
        raise ValueError('Category names must be 40 characters or fewer.')
    return name


@ensure_csrf_cookie
@require_http_methods(['GET', 'POST'])
def categories(request):
    if request.method == 'GET':
        return category_list()
    try:
        name = read_name(request)
        with transaction.atomic():
            existing = Category.objects.filter(name__iexact=name).first()
            if existing and existing.is_active:
                return JsonResponse({'error': 'A category with that name already exists.'}, status=409)
            if existing:
                existing.is_active = True
                existing.save(update_fields=['is_active'])
            else:
                Category.objects.create(name=name)
        return category_list(status=201)
    except ValueError as error:
        return JsonResponse({'error': str(error)}, status=400)
    except IntegrityError:
        return JsonResponse({'error': 'A category with that name already exists.'}, status=409)


@require_http_methods(['PATCH', 'DELETE'])
def category_detail(request, category_id):
    try:
        name = read_name(request) if request.method == 'PATCH' else None
        with transaction.atomic():
            category = Category.objects.select_for_update().filter(pk=category_id, is_active=True).first()
            if category is None:
                return JsonResponse({'error': 'This category no longer exists. Refresh the list.'}, status=404)
            if request.method == 'DELETE':
                category.is_active = False
                category.save(update_fields=['is_active'])
            else:
                if Category.objects.filter(name__iexact=name).exclude(pk=category_id).exists():
                    return JsonResponse({'error': 'A category with that name already exists.'}, status=409)
                # Entries keep their readable label, including after category removal.
                Entry.objects.filter(category=category.name).update(category=name)
                category.name = name
                category.save(update_fields=['name'])
        return category_list()
    except ValueError as error:
        return JsonResponse({'error': str(error)}, status=400)
    except IntegrityError:
        return JsonResponse({'error': 'A category with that name already exists.'}, status=409)
