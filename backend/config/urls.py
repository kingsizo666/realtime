from django.urls import include, path, re_path
from tracking.views import frontend, frontend_asset
from tracking.spotify_views import callback as spotify_callback

urlpatterns = [
    path('spotify/callback', spotify_callback),
    path('api/', include('tracking.urls')),
    path('', frontend),
    re_path(r'^assets/(?P<path>.*)$', frontend_asset),
]
