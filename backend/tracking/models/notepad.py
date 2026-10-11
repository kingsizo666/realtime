from django.db import models


class Notepad(models.Model):
    notes = models.TextField(blank=True, default='')
