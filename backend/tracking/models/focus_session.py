from django.db import models


class FocusSession(models.Model):
    minutes = models.PositiveSmallIntegerField(default=25)
    remaining_ms = models.PositiveIntegerField(default=1500000)
    deadline = models.DateTimeField(null=True, blank=True)
    completed = models.BooleanField(default=False)
    block_enabled = models.BooleanField(default=False)
    revision = models.PositiveIntegerField(default=0)
