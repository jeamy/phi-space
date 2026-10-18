"""Real SQLite backup/deletion checks; SSH inventory is mocked, no server needed."""
import contextlib
import importlib.util
import io
import json
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('erasure_driver', pathlib.Path(__file__).with_name('erasure-driver.py'))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class BackupDriverTest(unittest.TestCase):
    def setUp(self):
        parent = pathlib.Path.home() / '.local/share/phi-spaces-ops'
        parent.mkdir(parents=True, exist_ok=True)
        self.base = pathlib.Path(tempfile.mkdtemp(prefix='ap2-remaining-driver-test-', dir=parent))
        self.home = self.base / 'd'
        self.home.mkdir(mode=0o700)
        (self.home / 'restart.lock').write_text('exclusive test maintenance\n')
        self.state = self.base / 'state.json'
        self.state.write_text(json.dumps({'tag': self.base.name, 'base': '/home/mux/.local/share/phi-spaces-operations/' + self.base.name, 'members': {'d': {}}, 'localHome': str(self.home), 'running': {}}))
        self.db = sqlite3.connect(self.home / 'harness.sqlite')
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA wal_autocheckpoint=0')
        self.db.execute('CREATE TABLE entries(value TEXT)')
        self.db.execute("INSERT INTO entries VALUES('personal-content-in-WAL')")
        self.db.commit()
        self.real_run = subprocess.run

    def tearDown(self):
        self.db.close()
        shutil.rmtree(self.base)

    def action(self, action, **kwargs):
        def run(args, **options):
            if args[0] == 'ssh':
                # Only the remote process inventory is replaced; local backup code runs unchanged.
                return subprocess.CompletedProcess(args, 0, '{}', '')
            return self.real_run(args, **options)
        output = io.StringIO()
        with patch.object(sys, 'argv', ['erasure-driver.py', '--state', str(self.state)]), patch.object(sys, 'stdin', io.StringIO(json.dumps({'action': action, 'member': 'd', 'id': 'erase-driver-test', **kwargs}))), contextlib.redirect_stdout(output), patch.object(driver.subprocess, 'run', side_effect=run):
            driver.main()
        return json.loads(output.getvalue())

    def test_backup_captures_wal_and_preserves_original_binding_on_replay(self):
        receipt = self.action('backup')
        path = self.home / 'erasure-backups/erase-driver-test-d.sqlite'
        copy = sqlite3.connect(path)
        try:
            self.assertEqual(copy.execute('SELECT value FROM entries').fetchall(), [('personal-content-in-WAL',)])
        finally:
            copy.close()
        self.db.execute("INSERT INTO entries VALUES('later-content')")
        self.db.commit()
        self.assertEqual(self.action('backup'), receipt)
        self.assertEqual(sorted(p.name for p in path.parent.iterdir()), [path.name])
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_wrong_hash_cannot_destroy_and_correct_retry_only_removes_owned_archive(self):
        receipt = self.action('backup')
        path = self.home / 'erasure-backups/erase-driver-test-d.sqlite'
        with self.assertRaisesRegex(RuntimeError, 'maintenance failed'):
            self.action('destroy', sha256='0' * 64)
        self.assertTrue(path.exists())
        self.action('destroy', sha256=receipt['sha256'])
        self.action('destroy', sha256=receipt['sha256'])
        self.assertFalse(path.exists())
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM entries').fetchone()[0], 1)


if __name__ == '__main__':
    unittest.main()
