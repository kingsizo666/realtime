from django.urls import include, path, re_path
from tracking.views import frontend, frontend_asset

urlpatterns = [
    path('api/', include('tracking.urls')),
    path('', frontend),
    re_path(r'^assets/(?P<path>.*)$', frontend_asset),
]
