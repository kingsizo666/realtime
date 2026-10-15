from django.db import models


class BlockedApp(models.Model):
    name = models.CharField(max_length=200)
    path = models.CharField(max_length=1024, unique=True)

    class Meta:
        ordering = ['name', 'id']

    def as_dict(self):
        return {'id': self.pk, 'name': self.name, 'path': self.path}
