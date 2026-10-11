from pathlib import Path
from tempfile import TemporaryDirectory

from django.test import SimpleTestCase, override_settings


class FrontendTests(SimpleTestCase):
    def test_frontend_rebuild_uses_latest_asset_references(self):
        with TemporaryDirectory() as directory, override_settings(PROJECT_DIR=Path(directory)):
            index = Path(directory) / 'frontend' / 'dist' / 'index.html'
            index.parent.mkdir(parents=True)
            index.write_text('<script src="/assets/first.js"></script>', encoding='utf-8')
            self.assertContains(self.client.get('/'), 'first.js')
            index.write_text('<script src="/assets/second.js"></script>', encoding='utf-8')
            self.assertContains(self.client.get('/'), 'second.js')
