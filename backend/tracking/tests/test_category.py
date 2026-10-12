import importlib
import json
from datetime import timedelta
from types import SimpleNamespace

from django.apps import apps
from django.db import connection
from django.test import Client, TestCase
from django.utils import timezone

from ..models import Category, Entry


class CategoryTests(TestCase):
    def write(self, method, path, name):
        return getattr(self.client, method)(path, json.dumps({'name': name}), content_type='application/json')

    def test_add_categories_persist_and_reject_case_insensitive_duplicates(self):
        response = self.write('post', '/api/categories/', '  Documentation  ')
        self.assertEqual(response.status_code, 201)
        self.assertEqual(Client().get('/api/categories/').json()['categories'][-1]['name'], 'Documentation')
        self.assertIn('Documentation', self.client.get('/api/entries/').json()['categories'])
        self.assertEqual(self.write('post', '/api/categories/', 'documentation').status_code, 409)
        self.assertEqual(response['Cache-Control'], 'no-store')

    def test_rename_updates_pending_and_submitted_entries_atomically(self):
        now = timezone.now()
        pending = Entry.objects.create(category='Research', started_at=now - timedelta(hours=1))
        submitted = Entry.objects.create(category='Research', started_at=now - timedelta(hours=2), ended_at=now - timedelta(hours=1), is_submitted=True)
        category = Category.objects.get(name='Research')
        path = f'/api/categories/{category.pk}/'
        self.assertEqual(self.write('patch', path, 'System Validation').status_code, 409)
        pending.refresh_from_db()
        self.assertEqual(pending.category, 'Research')
        self.assertEqual(self.write('patch', path, 'Deep Research').status_code, 200)
        for entry in (pending, submitted):
            entry.refresh_from_db()
            self.assertEqual(entry.category, 'Deep Research')
        self.assertTrue(submitted.is_submitted)
        self.assertEqual(submitted.ended_at, now - timedelta(hours=1))

    def test_remove_keeps_history_and_allows_finishing_when_no_categories_remain(self):
        entry = Entry.objects.create(category='Research', started_at=timezone.now() - timedelta(hours=1))
        for category in Category.objects.all():
            self.assertEqual(self.client.delete(f'/api/categories/{category.pk}/').status_code, 200)
        self.assertEqual(self.client.get('/api/entries/').json()['categories'], [])
        response = self.client.post('/api/entries/', json.dumps({'category': 'Research', 'started_at': entry.started_at.isoformat()}), content_type='application/json')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.post(f'/api/entries/{entry.pk}/finish/').status_code, 200)
        response = self.client.patch(f'/api/entries/{entry.pk}/', '{"description":"Still editable"}', content_type='application/json')
        self.assertEqual(response.status_code, 200)
        entry.refresh_from_db()
        self.assertEqual(entry.category, 'Research')
        self.assertTrue(entry.is_submitted)

    def test_removed_category_can_be_added_again_without_duplicate_records(self):
        original = Category.objects.get(name='Research')
        self.client.delete(f'/api/categories/{original.pk}/')
        self.assertEqual(self.write('post', '/api/categories/', 'research').status_code, 201)
        original.refresh_from_db()
        self.assertTrue(original.is_active)
        self.assertEqual(Category.objects.filter(name__iexact='research').count(), 1)

    def test_invalid_names_and_missing_categories_do_not_change_data(self):
        count = Category.objects.count()
        for name in ['', '   ', None, 42, [], 'x' * 41]:
            self.assertEqual(self.write('post', '/api/categories/', name).status_code, 400)
        self.assertEqual(self.client.post('/api/categories/', '{', content_type='application/json').status_code, 400)
        self.assertEqual(self.write('patch', '/api/categories/999/', 'Missing').status_code, 404)
        self.assertEqual(self.client.delete('/api/categories/999/').status_code, 404)
        self.assertEqual(Category.objects.count(), count)

    def test_mutations_require_csrf_and_correct_methods(self):
        client = Client(enforce_csrf_checks=True)
        client.get('/api/categories/')
        category = Category.objects.first()
        path = f'/api/categories/{category.pk}/'
        self.assertEqual(client.post('/api/categories/', '{"name":"New"}', content_type='application/json').status_code, 403)
        self.assertEqual(client.patch(path, '{"name":"New"}', content_type='application/json').status_code, 403)
        self.assertEqual(client.delete(path).status_code, 403)
        self.assertEqual(client.post('/api/categories/', '{"name":"New"}', content_type='application/json', HTTP_X_CSRFTOKEN=client.cookies['csrftoken'].value).status_code, 201)
        self.assertEqual(self.client.delete('/api/categories/').status_code, 405)
        self.assertEqual(self.client.get(path).status_code, 405)

    def test_upgrade_seeds_defaults_and_existing_custom_labels_only_once(self):
        Category.objects.all().delete()
        Entry.objects.create(category='My previous category', started_at=timezone.now() - timedelta(hours=1))
        migration = importlib.import_module('tracking.migrations.0005_alter_entry_category_category')
        editor = SimpleNamespace(connection=connection)
        migration.seed_categories(apps, editor)
        migration.seed_categories(apps, editor)
        self.assertEqual(Category.objects.count(), 5)
        self.assertTrue(Category.objects.filter(name='My previous category').exists())
        self.assertTrue(Category.objects.filter(name='Research').exists())
