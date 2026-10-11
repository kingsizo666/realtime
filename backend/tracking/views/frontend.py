from django.conf import settings
from django.http import HttpResponse
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.static import serve


@ensure_csrf_cookie
def frontend(request):
    index = settings.PROJECT_DIR / 'frontend' / 'dist' / 'index.html'
    if not index.exists():
        return HttpResponse('Build the frontend with npm.cmd run build in frontend/, or use the Vite development server.', status=503)
    return HttpResponse(index.read_text(encoding='utf-8'))


def frontend_asset(request, path):
    return serve(request, path, document_root=settings.PROJECT_DIR / 'frontend' / 'dist' / 'assets')
