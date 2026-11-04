import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('configure_oidc', Path(__file__).with_name('configure-oidc.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConfigTests(unittest.TestCase):
    def test_append_and_repeat(self):
        block = module.managed_config('login.localhost', 'sdlc')
        result = module.updated_config('default_config:\n', block)
        self.assertIn('user: home-assistant-users', result)
        self.assertEqual(module.updated_config(result, block), result)

    def test_conflicts_and_nonlocal_hosts_are_rejected(self):
        block = module.managed_config('login.localhost', 'sdlc')
        with self.assertRaises(ValueError):
            module.updated_config('auth_oidc:\n  client_id: other\n', block)
        with self.assertRaises(ValueError):
            module.updated_config('# BEGIN SDLC HOME ASSISTANT OIDC\n', block)
        with self.assertRaises(ValueError):
            module.managed_config('external.example', 'sdlc')

    def test_identity_component_is_idempotent_and_rejects_conflicts(self):
        result = module.add_identity_component('default_config:\n')
        self.assertIn('sdlc_mcp_identity:', result)
        self.assertEqual(module.add_identity_component(result), result)
        with self.assertRaises(ValueError):
            module.add_identity_component('sdlc_mcp_identity:\n')


if __name__ == '__main__':
    unittest.main()
