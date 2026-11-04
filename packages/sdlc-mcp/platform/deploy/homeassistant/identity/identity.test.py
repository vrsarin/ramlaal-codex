import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

path = Path(__file__).parent / 'custom_components/sdlc_mcp_identity/identity.py'
spec = importlib.util.spec_from_file_location('sdlc_mcp_identity', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def credential(provider, provider_id, value):
    return SimpleNamespace(auth_provider_type=provider, auth_provider_id=provider_id, data={'sub': value})


class IdentityTests(unittest.TestCase):
    def test_only_valid_default_oidc_subject_hashes_are_returned(self):
        valid = 'a' * 64
        user = SimpleNamespace(credentials=[
            credential('auth_oidc', 'default', valid),
            credential('auth_oidc', 'default', valid),
            credential('auth_oidc', 'other', 'b' * 64),
            credential('homeassistant', None, 'c' * 64),
            credential('auth_oidc', 'default', 'invalid'),
        ])
        self.assertEqual(module.oidc_subject_hashes(user), [valid])

    def test_no_oidc_binding_returns_empty_list(self):
        user = SimpleNamespace(credentials=[credential('homeassistant', None, 'a' * 64)])
        self.assertEqual(module.oidc_subject_hashes(user), [])


if __name__ == '__main__':
    unittest.main()
