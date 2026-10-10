from django.db import models

CATEGORIES = [
    'Research',
    'System Validation',
    'Automated Reasoning',
    'Networked Embedded Systems',
]


def category_choices():
    return [(name, name) for name in CATEGORIES]


class Notepad(models.Model):
    notes = models.TextField(blank=True, default='')


class Entry(models.Model):
    category = models.CharField(max_length=40, choices=category_choices)
    description = models.CharField(max_length=1000, blank=True)
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField(null=True, blank=True)
    is_submitted = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-started_at', '-id']
        constraints = [
            models.UniqueConstraint(fields=['is_submitted'], condition=models.Q(is_submitted=False), name='one_unfinished_entry'),
            models.CheckConstraint(condition=models.Q(ended_at__isnull=True) | models.Q(ended_at__gte=models.F('started_at')), name='end_after_start'),
            models.CheckConstraint(condition=models.Q(is_submitted=False) | models.Q(ended_at__isnull=False), name='submitted_has_end'),
        ]

    def as_dict(self):
        return {
            'id': self.pk,
            'category': self.category,
            'description': self.description,
            'started_at': self.started_at.isoformat(),
            'ended_at': self.ended_at.isoformat() if self.ended_at else None,
            'is_submitted': self.is_submitted,
        }
