export function unavailableUnscannedBuiltin(entry, scan) {
  return entry?.is_enabled === true &&
    entry.path?.replace(/\/+$/, '') === '/airegistry-tools' &&
    entry.proxy_pass_url === 'http://mcpgw-server:8003/' &&
    entry.health_status !== 'healthy' &&
    (!scan || scan.scan_failed !== false || scan.is_safe !== true)
}
