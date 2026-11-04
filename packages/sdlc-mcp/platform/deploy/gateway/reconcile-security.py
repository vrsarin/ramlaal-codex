#!/usr/bin/env python3
"""Clear a stale pending tag only for managed backends with the verified scan."""
import asyncio
import sys

from registry.repositories.factory import get_security_scan_repository, get_server_repository

TARGETS = {
    '/sdlc-forgejo': 'http://forgejo-mcp:3000/mcp',
    '/sdlc-wikijs': 'http://wikijs-sdlc-mcp:3000/mcp',
    '/sdlc-home-assistant': 'http://homeassistant-mcp:3000/mcp',
}
TLS_TARGETS = {
    '/sdlc-forgejo': 'https://forgejo-mcp-tls:3000/mcp',
    '/sdlc-wikijs': 'https://wikijs-mcp-tls:3000/mcp',
    '/sdlc-home-assistant': 'https://homeassistant-mcp-tls:3000/mcp',
}
PENDING = 'security-pending'


def verified_scan(scan, path, timestamp, target=None):
    target = TARGETS[path] if target is None else target
    return bool(
        scan and scan.get('server_path') == path
        and scan.get('server_url') == target
        and scan.get('scan_timestamp') == timestamp
        and scan.get('is_safe') is True
        and scan.get('scan_failed') is False
    )


async def reconcile(path, timestamp, servers, scans, target=None):
    if path not in TARGETS or not timestamp:
        raise ValueError('Unknown managed backend or missing scan timestamp')
    target = TARGETS[path] if target is None else target
    if target not in (TARGETS[path], TLS_TARGETS[path]):
        raise ValueError('Unknown managed backend target')
    scan = await scans.get_latest(path)
    if not verified_scan(scan, path, timestamp, target):
        raise RuntimeError(f'{path}: the expected successful security scan is not current')
    server = await servers.get(path)
    if not server or server.get('proxy_pass_url') != target:
        raise RuntimeError(f'{path}: server target differs from the managed backend')
    tags = server.get('tags')
    if not isinstance(tags, list) or 'sdlc-local-managed' not in tags:
        raise RuntimeError(f'{path}: server is not managed by this setup')
    if PENDING not in tags:
        return False
    revision = server.get('updated_at')
    if not isinstance(revision, str) or not revision:
        raise RuntimeError(f'{path}: server revision is unavailable')
    if not verified_scan(await scans.get_latest(path), path, timestamp, target):
        raise RuntimeError(f'{path}: security scan changed during reconciliation')
    if not await servers.update(path, {**server, 'tags': [tag for tag in tags if tag != PENDING]},
                                updated_fields=['tags'], expected_updated_at=revision):
        raise RuntimeError(f'{path}: server changed during reconciliation; retry setup')
    if not verified_scan(await scans.get_latest(path), path, timestamp, target):
        current = await servers.get(path)
        if not current or not isinstance(current.get('updated_at'), str) or not isinstance(current.get('tags'), list):
            raise RuntimeError(f'{path}: scan changed and the pending tag could not be restored')
        if PENDING not in current['tags']:
            restored = await servers.update(path, {**current, 'tags': [*current['tags'], PENDING]},
                                            updated_fields=['tags'], expected_updated_at=current['updated_at'])
            if not restored:
                raise RuntimeError(f'{path}: scan changed and the pending tag could not be restored; inspect it immediately')
        raise RuntimeError(f'{path}: security scan changed during reconciliation; pending status retained')
    return True


async def main():
    if len(sys.argv) not in (3, 4):
        raise SystemExit('Usage: reconcile-security.py <managed-path> <verified-scan-timestamp> [managed-target]')
    target = sys.argv[3] if len(sys.argv) == 4 else None
    changed = await reconcile(sys.argv[1], sys.argv[2], get_server_repository(), get_security_scan_repository(), target)
    print('Cleared stale pending status.' if changed else 'No stale pending status.')


if __name__ == '__main__':
    asyncio.run(main())
