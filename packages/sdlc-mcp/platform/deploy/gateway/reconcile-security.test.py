import importlib.util
from pathlib import Path
import sys
import types
import unittest

registry = types.ModuleType('registry')
repositories = types.ModuleType('registry.repositories')
factory = types.ModuleType('registry.repositories.factory')
factory.get_security_scan_repository = lambda: None
factory.get_server_repository = lambda: None
sys.modules.update({
    'registry': registry,
    'registry.repositories': repositories,
    'registry.repositories.factory': factory,
})
spec = importlib.util.spec_from_file_location('reconcile_security', Path(__file__).with_name('reconcile-security.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

PATH = '/sdlc-forgejo'
SCAN = {
    'server_path': PATH, 'server_url': module.TARGETS[PATH],
    'scan_timestamp': '2026-01-01T00:00:00Z', 'is_safe': True, 'scan_failed': False,
}


class Servers:
    def __init__(self):
        self.item = {
            'proxy_pass_url': module.TARGETS[PATH], 'updated_at': 'revision',
            'tags': ['sdlc-local-managed', 'security-pending', 'other'],
            'auth_scheme': 'oauth',
        }
        self.writes = []

    async def get(self, path):
        return dict(self.item)

    async def update(self, path, item, *, updated_fields, expected_updated_at):
        self.writes.append((updated_fields, expected_updated_at))
        if self.item['updated_at'] != expected_updated_at:
            return False
        self.item['tags'] = item['tags']
        self.item['updated_at'] += '-new'
        return True


class Scans:
    def __init__(self, values):
        self.values = values

    async def get_latest(self, path):
        return self.values.pop(0) if len(self.values) > 1 else self.values[0]


class ReconcileTests(unittest.IsolatedAsyncioTestCase):
    async def test_clears_only_pending_tag_after_safe_scan(self):
        servers = Servers()
        self.assertTrue(await module.reconcile(PATH, SCAN['scan_timestamp'], servers, Scans([SCAN])))
        self.assertEqual(servers.item['tags'], ['sdlc-local-managed', 'other'])
        self.assertEqual(servers.item['auth_scheme'], 'oauth')
        self.assertEqual(servers.writes, [(['tags'], 'revision')])
        self.assertFalse(await module.reconcile(PATH, SCAN['scan_timestamp'], servers, Scans([SCAN])))

    async def test_failed_or_changed_scan_is_not_cleared(self):
        for scan in [None, {**SCAN, 'is_safe': False}, {**SCAN, 'scan_failed': True}, {**SCAN, 'scan_timestamp': 'other'}]:
            servers = Servers()
            with self.assertRaises(RuntimeError):
                await module.reconcile(PATH, SCAN['scan_timestamp'], servers, Scans([scan]))
            self.assertEqual(servers.writes, [])

    async def test_scan_race_restores_pending_tag(self):
        servers = Servers()
        scans = Scans([SCAN, SCAN, {**SCAN, 'is_safe': False}])
        with self.assertRaisesRegex(RuntimeError, 'pending status retained'):
            await module.reconcile(PATH, SCAN['scan_timestamp'], servers, scans)
        self.assertIn('security-pending', servers.item['tags'])

    async def test_unmanaged_or_repointed_server_is_untouched(self):
        servers = Servers()
        servers.item['proxy_pass_url'] = 'http://other/mcp'
        with self.assertRaises(RuntimeError):
            await module.reconcile(PATH, SCAN['scan_timestamp'], servers, Scans([SCAN]))
        self.assertEqual(servers.writes, [])
        with self.assertRaises(ValueError):
            await module.reconcile('/other', SCAN['scan_timestamp'], servers, Scans([SCAN]))

    async def test_tls_target_requires_matching_safe_scan_and_server(self):
        target = module.TLS_TARGETS[PATH]
        scan = {**SCAN, 'server_url': target}
        servers = Servers()
        servers.item['proxy_pass_url'] = target
        self.assertTrue(await module.reconcile(PATH, scan['scan_timestamp'], servers, Scans([scan]), target))
        with self.assertRaises(ValueError):
            await module.reconcile(PATH, scan['scan_timestamp'], servers, Scans([scan]), 'https://other/mcp')
        with self.assertRaises(RuntimeError):
            await module.reconcile(PATH, scan['scan_timestamp'], servers, Scans([SCAN]), target)

    async def test_concurrent_server_change_fails_closed(self):
        servers = Servers()

        async def changed_update(path, item, *, updated_fields, expected_updated_at):
            servers.item['updated_at'] = 'changed'
            return False

        servers.update = changed_update
        with self.assertRaisesRegex(RuntimeError, 'server changed'):
            await module.reconcile(PATH, SCAN['scan_timestamp'], servers, Scans([SCAN]))
        self.assertIn('security-pending', servers.item['tags'])


if __name__ == '__main__':
    unittest.main()
