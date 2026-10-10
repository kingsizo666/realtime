from django.urls import path
from . import views

urlpatterns = [
    path('shutdown/', views.shutdown),
    path('entries/', views.entries),
    path('entries/<int:entry_id>/', views.entry_detail),
    path('entries/<int:entry_id>/finish/', views.finish),
]
