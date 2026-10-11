from django.urls import path
from .views import spotify
from .views.entry import entries, entry_detail, finish
from .views.notepad import notepad
from .views.shutdown import shutdown

urlpatterns = [
    path('notepad/', notepad),
    path('spotify/status/', spotify.status),
    path('spotify/connect/', spotify.connect),
    path('spotify/control/', spotify.control),
    path('spotify/disconnect/', spotify.disconnect),
    path('shutdown/', shutdown),
    path('entries/', entries),
    path('entries/<int:entry_id>/', entry_detail),
    path('entries/<int:entry_id>/finish/', finish),
]
