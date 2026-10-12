from django.db import models
from django.db.models.functions import Lower


class Category(models.Model):
    name = models.CharField(max_length=40, unique=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ['id']
        constraints = [models.UniqueConstraint(Lower('name'), name='unique_category_name_case_insensitive')]

    def as_dict(self):
        return {'id': self.pk, 'name': self.name}
