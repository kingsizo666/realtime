from django.urls import path
from . import views
from . import spotify_views

urlpatterns = [
    path('notepad/', views.notepad),
    path('spotify/status/', spotify_views.status),
    path('spotify/connect/', spotify_views.connect),
    path('spotify/control/', spotify_views.control),
    path('spotify/disconnect/', spotify_views.disconnect),
    path('shutdown/', views.shutdown),
    path('entries/', views.entries),
    path('entries/<int:entry_id>/', views.entry_detail),
    path('entries/<int:entry_id>/finish/', views.finish),
]
