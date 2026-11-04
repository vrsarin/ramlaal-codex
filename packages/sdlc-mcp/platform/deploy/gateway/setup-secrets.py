#!/usr/bin/env python3
"""Initialize isolated local gateway secrets without replacing existing values."""
import os
from pathlib import Path
import re
import secrets
import tempfile

base = Path('.env')
path = Path('gateway.env')
if not base.is_file():
    raise SystemExit('Create .env from .env.example before setting up the gateway.')

keys = (
    'GATEWAY_MONGO_PASSWORD',
    'GATEWAY_SECRET_KEY',
    'GATEWAY_MARKER_SECRET',
    'GATEWAY_WEB_CLIENT_SECRET',
    'GATEWAY_M2M_CLIENT_SECRET',
    'GATEWAY_DISCOVERY_CLIENT_SECRET',
    'GATEWAY_HOME_DISCOVERY_PASSWORD',
    'GATEWAY_BOOTSTRAP_TOKEN',
)
base_text = base.read_text()
text = path.read_text() if path.exists() else ''


def setting(name: str, default: str) -> str:
    value = os.environ.get(name)
    if value is not None:
        return value
    values = re.findall(rf'^{name}=(.*)$', base_text, flags=re.MULTILINE)
    if len(values) > 1:
        raise SystemExit(f'{name} is defined more than once in .env.')
    return values[0] if values else default


if setting('BIND_ADDRESS', '127.0.0.1') != '127.0.0.1':
    raise SystemExit('The local gateway requires BIND_ADDRESS=127.0.0.1; use HTTPS infrastructure for remote access.')
for name, default in (('KEYCLOAK_HOSTNAME', 'auth.localhost'), ('GATEWAY_HOSTNAME', 'mcp-gateway.localhost')):
    hostname = setting(name, default)
    if not re.fullmatch(r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.localhost|localhost', hostname):
        raise SystemExit(f'{name} must be a localhost hostname for the local gateway.')

legacy = {}
for key in keys:
    values = re.findall(rf'^{key}=(.*)$', base_text, flags=re.MULTILINE)
    if len(values) > 1:
        raise SystemExit(f'{key} is defined more than once in .env.')
    if values:
        if '# Local MCP gateway secrets' not in base_text:
            raise SystemExit(f'Move {key} from .env to gateway.env manually.')
        legacy[key] = values[0]

missing = []
for key in keys:
    values = re.findall(rf'^{key}=(.*)$', text, flags=re.MULTILINE)
    if len(values) > 1:
        raise SystemExit(f'{key} is defined more than once in gateway.env.')
    if values and key in legacy and values[0] != legacy[key]:
        raise SystemExit(f'{key} differs between .env and gateway.env.')
    if values and (not values[0] or 'change' in values[0].lower() or len(values[0]) < 32):
        raise SystemExit(f'{key} must contain a secure existing value or be removed from gateway.env.')
    if not values:
        missing.append(key)

def replace_if_unchanged(target: Path, expected: str, replacement: str) -> None:
    with tempfile.NamedTemporaryFile(mode='w', dir=target.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(replacement)
            stream.flush()
            os.fsync(stream.fileno())
            os.chmod(temporary, 0o600)
            current = target.read_text() if target.exists() else ''
            if current != expected:
                raise SystemExit(f'{target} changed during setup; retry without concurrent edits.')
            os.replace(temporary, target)
        finally:
            if temporary.exists():
                temporary.unlink()


if missing:
    additions = []
    for key in missing:
        value = legacy.get(key) or secrets.token_urlsafe(48)
        if len(value) < 32 or 'change' in value.lower():
            raise SystemExit(f'{key} has an invalid existing value.')
        additions.append(f'{key}={value}\n')
    prefix = '' if not text or text.endswith('\n') else '\n'
    replace_if_unchanged(path, text, text + prefix + '\n# Local MCP gateway secrets\n' + ''.join(additions))
if legacy:
    lines = base_text.splitlines(keepends=True)
    replace_if_unchanged(base, base_text, ''.join(
        line for line in lines
        if line.strip() != '# Local MCP gateway secrets' and not any(line.startswith(f'{key}=') for key in legacy)
    ))
print('Local gateway secrets are configured.')
