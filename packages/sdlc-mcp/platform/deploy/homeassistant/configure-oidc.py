#!/usr/bin/env python3
"""Append only the managed Home Assistant OIDC configuration."""
import os
from pathlib import Path
import re
import tempfile


def managed_config(host: str, realm: str) -> str:
    if not re.fullmatch(r'(?:[A-Za-z0-9-]+\.)*localhost', host):
        raise ValueError('Keycloak hostname must be a localhost hostname')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', realm):
        raise ValueError('Invalid Keycloak realm')
    return f'''# BEGIN SDLC HOME ASSISTANT OIDC
auth_oidc:
  client_id: home-assistant-oidc
  discovery_url: https://{host}/realms/{realm}/.well-known/openid-configuration
  roles:
    user: home-assistant-users
    admin: home-assistant-admins
  features:
    include_groups_scope: false
    automatic_user_linking: false
    force_https: true
# END SDLC HOME ASSISTANT OIDC
'''


def updated_config(current: str, block: str) -> str:
    marker = '# BEGIN SDLC HOME ASSISTANT OIDC'
    if marker in current:
        if current.count(marker) != 1:
            raise ValueError('Existing managed Home Assistant OIDC configuration differs; reconcile it explicitly')
        if block in current:
            return current
        previous = block.replace('    force_https: true\n', '')
        if current.count(previous) == 1:
            return current.replace(previous, block)
        raise ValueError('Existing managed Home Assistant OIDC configuration differs; reconcile it explicitly')
    if re.search(r'(?m)^auth_oidc\s*:', current):
        raise ValueError('Home Assistant already has an unmanaged auth_oidc configuration')
    return current + ('' if not current or current.endswith('\n') else '\n') + '\n' + block


def add_identity_component(current: str) -> str:
    block = '# BEGIN SDLC MCP IDENTITY\nsdlc_mcp_identity:\n# END SDLC MCP IDENTITY\n'
    if '# BEGIN SDLC MCP IDENTITY' in current:
        if current.count('# BEGIN SDLC MCP IDENTITY') != 1 or block not in current:
            raise ValueError('Existing managed Home Assistant identity configuration differs')
        return current
    if re.search(r'(?m)^sdlc_mcp_identity\s*:', current):
        raise ValueError('Home Assistant already has an unmanaged sdlc_mcp_identity configuration')
    return current + ('' if not current or current.endswith('\n') else '\n') + '\n' + block


def main() -> None:
    path = Path('/config/configuration.yaml')
    if path.is_symlink() or not path.is_file():
        raise SystemExit('Home Assistant configuration.yaml must be an existing regular file')
    current = path.read_text()
    result = add_identity_component(updated_config(current, managed_config(os.environ['KEYCLOAK_HOSTNAME'], os.environ['KEYCLOAK_REALM'])))
    if result == current:
        print('Home Assistant OIDC configuration is already present.')
        return
    stat = path.stat()
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(result)
            stream.flush()
            os.fsync(stream.fileno())
            os.chmod(temporary, stat.st_mode & 0o777)
            os.chown(temporary, stat.st_uid, stat.st_gid)
            if path.read_text() != current:
                raise RuntimeError('Home Assistant configuration changed during setup; retry')
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    print('Home Assistant OIDC configuration was added.')


if __name__ == '__main__':
    main()
