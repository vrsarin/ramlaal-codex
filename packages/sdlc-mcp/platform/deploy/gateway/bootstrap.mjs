#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { rpc, testUserToken } from './test-identity.mjs'
import { unavailableUnscannedBuiltin } from './builtin-scan-policy.mjs'
import { waitForRegistrationScan } from './registration-scan.mjs'
import { mcpTlsEnabled, mcpUpstream } from './mcp-upstreams.mjs'
import { gatewayBase } from './gateway-url.mjs'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const base = gatewayBase()
const issuer = `https://${required('KEYCLOAK_HOSTNAME')}/realms/${required('KEYCLOAK_REALM')}/protocol/openid-connect`
const username = process.env.KEYCLOAK_AUTOMATION_USERNAME || 'mcp-tester'
const password = required('KEYCLOAK_TEST_PASSWORD')
const adminToken = required('GATEWAY_BOOTSTRAP_TOKEN')
const discoverySecret = required('GATEWAY_DISCOVERY_CLIENT_SECRET')
const backends = [
  { path: '/sdlc-forgejo', name: 'SDLC Forgejo', direct: required('FORGEJO_MCP_PUBLIC_URL'), client: required('FORGEJO_MCP_OAUTH_CLIENT_ID'), target: process.env.FORGEJO_MCP_SERVER_CLIENT_ID || 'forgejo-mcp-server', upstream: mcpUpstream('forgejo', process.env.ENABLE_TLS ?? process.env.SDLC_MCP_TLS), prefix: 'forgejo' },
  { path: '/sdlc-wikijs', name: 'SDLC Wiki.js', direct: required('WIKIJS_SDLC_MCP_PUBLIC_URL'), client: required('WIKIJS_SDLC_MCP_OAUTH_CLIENT_ID'), target: process.env.WIKIJS_SDLC_MCP_SERVER_CLIENT_ID || 'wikijs-sdlc-mcp-server', upstream: mcpUpstream('wikijs', process.env.ENABLE_TLS ?? process.env.SDLC_MCP_TLS), prefix: 'wikijs' }
]
const methods = ['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get']
const scope = {
  scope_name: 'sdlc-mcp-access',
  description: 'Access the SDLC virtual server and its two backends',
  group_mappings: ['mcp-users'],
  server_access: ['/virtual/sdlc', ...backends.map((backend) => backend.path)].map((server) => ({ server, methods, tools: ['*'] })),
  ui_permissions: { list_service: ['sdlc-forgejo', 'sdlc-wikijs'], list_virtual_server: ['virtual/sdlc'] },
  create_in_idp: false
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers)
  headers.set('authorization', `Bearer ${adminToken}`)
  const response = await fetch(`${base}${path}`, { ...options, headers, signal: options.signal ?? AbortSignal.timeout(30_000) })
  const raw = await response.text()
  let result
  try { result = raw ? JSON.parse(raw) : undefined } catch { throw new Error(`Gateway returned invalid JSON for ${path}`) }
  if (!response.ok) throw new Error(`Gateway ${options.method || 'GET'} ${path} failed (HTTP ${response.status}): ${result?.detail ?? result?.error ?? 'unknown error'}`)
  return result
}
async function optional(path) {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(30_000) })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`Gateway GET ${path} failed (HTTP ${response.status})`)
  return response.json()
}
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const existingScope = await optional('/api/servers/groups/sdlc-mcp-access')
if (!existingScope) {
  await api('/api/servers/groups/import', json(scope))
} else {
  assert.deepEqual(existingScope.group_mappings, scope.group_mappings, 'Existing gateway group mappings differ')
  assert.deepEqual(existingScope.server_access, scope.server_access, 'Existing gateway permissions differ')
  assert.deepEqual(existingScope.ui_permissions, scope.ui_permissions, 'Existing gateway UI permissions differ')
}

const inventory = await api('/api/servers?limit=100')
const builtin = inventory.servers.find((entry) => entry.path.replace(/\/+$/, '') === '/airegistry-tools')
if (builtin?.is_enabled && builtin.proxy_pass_url === 'http://mcpgw-server:8003/' && builtin.health_status !== 'healthy') {
  const scan = await optional('/api/servers/airegistry-tools/security-scan')
  if (unavailableUnscannedBuiltin(builtin, scan)) {
    await api('/api/servers/toggle', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ path: builtin.path, new_state: 'false' })
    })
    console.log('Disabled unavailable built-in registry MCP server without a successful scan.')
  }
}
const names = new Map()
for (const backend of backends) {
  const token = await testUserToken({ issuer, clientId: backend.client, resource: backend.direct, username, password })
  const catalog = await rpc(backend.direct, token, 'tools/list')
  if (!Array.isArray(catalog.tools) || catalog.tools.length === 0) throw new Error(`${backend.name} returned no tools`)
  backend.tools = catalog.tools
  for (const tool of backend.tools) names.set(tool.name, (names.get(tool.name) ?? 0) + 1)
  const existing = inventory.servers.find((entry) => entry.path.replace(/\/$/, '') === backend.path)
  if (!existing) {
    const body = new URLSearchParams({
      name: backend.name, description: `${backend.name} MCP server`, path: backend.path, proxy_pass_url: backend.upstream,
      transport: 'streamable-http', supported_transports: 'streamable-http',
      tool_list_json: JSON.stringify(backend.tools), tags: 'sdlc-local-managed',
      visibility: 'group-restricted', allowed_groups: 'mcp-users', overwrite: 'false'
    })
    await api('/api/servers/register', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
    await waitForRegistrationScan(backend.path, {
      getScan: () => optional(`/api/servers/${backend.path.slice(1)}/security-scan`),
      getServer: () => api(`/api/servers/${backend.path.slice(1)}`)
    })
  } else {
    assert.equal(existing.proxy_pass_url, backend.upstream, `${backend.path} points to a different upstream`)
    assert(existing.tags?.includes('sdlc-local-managed'), `${backend.path} is not managed by this setup`)
  }
  await api(`/api/servers/${backend.path.slice(1)}/oauth-config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token_url: `https://gateway-idp-tls/realms/${required('KEYCLOAK_REALM')}/protocol/openid-connect/token`,
      client_id: 'mcp-gateway-discovery', client_secret: discoverySecret,
      scopes: [backend.target], token_auth_style: 'post_body'
    })
  })
  const current = await api(`/api/servers/${backend.path.slice(1)}/egress-auth`)
  if (current.egress_auth_mode === 'none' || !current.egress_auth_mode) {
    await api(`/api/servers/${backend.path.slice(1)}/egress-auth`, json({ egress_auth_mode: 'obo_exchange', target_audience: backend.target, scopes: [backend.target] }))
  } else {
    assert.equal(current.egress_auth_mode, 'obo_exchange', `${backend.path} uses a different egress authentication mode`)
    assert.equal(current.target_audience ?? current.egress_oauth?.target_audience, backend.target, `${backend.path} uses a different exchange audience`)
  }
  const scan = await api(`/api/servers/${backend.path.slice(1)}/rescan`, { method: 'POST', signal: AbortSignal.timeout(120_000) })
  assert.equal(scan.scan_failed, false, `${backend.path} security scan failed`)
  assert.equal(scan.is_safe, true, `${backend.path} security scan found unsafe tools`)
  const scanned = await api(`/api/servers/${backend.path.slice(1)}/security-scan`)
  assert.equal(scanned.scan_failed, false, `${backend.path} has no successful recorded security scan`)
  assert.equal(scanned.is_safe, true, `${backend.path} has no safe recorded security scan`)
  assert.equal(scanned.scan_timestamp, scan.scan_timestamp, `${backend.path} scan changed after rescan`)
  assert.equal(typeof scanned.scan_timestamp, 'string', `${backend.path} scan timestamp is unavailable`)
  execFileSync('docker', [
    'compose', '--env-file', '.env', '--env-file', process.env.SDLC_RUNTIME_ENV_FILE || 'gateway.env', '-f', 'compose.yaml',
    '-f', 'compose.gateway.yaml',
    ...(process.env.SDLC_RUNTIME_ENV_FILE ? ['-f', 'compose.homeassistant.yaml', '-f', 'compose.runtime.yaml', '--profile', 'homeassistant', '--profile', 'runtime'] : []),
    ...(mcpTlsEnabled(process.env.ENABLE_TLS ?? process.env.SDLC_MCP_TLS) ? ['-f', 'compose.mcp-tls.yaml', '--profile', 'mcp-tls'] : []),
    ...(gatewayBase().startsWith('https://') ? ['-f', 'compose.gateway-https.yaml'] : []),
    '--profile', 'mcp', '--profile', 'gateway',
    'exec', '-T', 'gateway-registry', '/app/.venv/bin/python',
    '/gateway-scripts/reconcile-security.py', backend.path, scanned.scan_timestamp, backend.upstream
  ], { stdio: 'inherit' })
  const updated = await api(`/api/servers/${backend.path.slice(1)}`)
  assert(!updated.tags?.includes('security-pending'), `${backend.path} still has a pending security tag`)
}

const mappings = backends.flatMap((backend) => backend.tools.map((tool) => ({
  tool_name: tool.name, backend_server_path: backend.path,
  ...(names.get(tool.name) > 1 ? { alias: `${backend.prefix}_${tool.name}` } : {})
})))
const virtuals = await api('/api/virtual-servers')
const existingVirtual = virtuals.virtual_servers.find((item) => item.path.replace(/\/$/, '') === '/virtual/sdlc')
if (!existingVirtual) {
  await api('/api/virtual-servers', json({
    path: '/virtual/sdlc', server_name: 'SDLC tools', description: 'Forgejo and Wiki.js tools',
    tags: ['sdlc-local-managed'], required_scopes: ['sdlc-mcp-access'], tool_mappings: mappings
  }))
} else {
  const current = await api('/api/virtual-servers/virtual/sdlc')
  assert(current.tags?.includes('sdlc-local-managed'), 'The SDLC virtual server is not managed by this setup')
  const normalized = current.tool_mappings.map(({ tool_name, backend_server_path, alias }) => ({ tool_name, backend_server_path, ...(alias ? { alias } : {}) }))
  const coreMappings = normalized.filter((mapping) => mapping.backend_server_path !== '/sdlc-home-assistant')
  assert.deepEqual(coreMappings, mappings, 'The SDLC virtual server mappings differ; reconcile them explicitly')
}
const after = await api('/api/servers?limit=100')
for (const backend of backends) {
  const entry = after.servers.find((item) => item.path.replace(/\/$/, '') === backend.path)
  assert(entry, `${backend.path} was not registered`)
  if (!entry.is_enabled) {
    await api('/api/servers/toggle', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ path: backend.path, new_state: 'true' })
    })
  }
}
const virtual = await api('/api/virtual-servers/virtual/sdlc')
if (!virtual.is_enabled) await api('/api/virtual-servers/virtual/sdlc/toggle', json({ enabled: true }))
const deadline = Date.now() + 120_000
let health = []
while (Date.now() < deadline) {
  const state = await api('/api/servers?limit=100')
  health = backends.map((backend) => state.servers.find((item) => item.path.replace(/\/$/, '') === backend.path))
  if (health.every((entry) => entry?.is_enabled && entry.health_status === 'healthy')) break
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
assert(health.every((entry) => entry?.is_enabled && entry.health_status === 'healthy'), 'Gateway backends did not become enabled and healthy')
console.log(`Gateway configured: one virtual server, ${mappings.length} mapped tools, and per-user token exchange.`)
