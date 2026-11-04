#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { rpc } from '../gateway/test-identity.mjs'
import { waitForRegistrationScan } from '../gateway/registration-scan.mjs'
import { mcpTlsEnabled, mcpUpstream } from '../gateway/mcp-upstreams.mjs'
import { gatewayBase } from '../gateway/gateway-url.mjs'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const base = gatewayBase()
const issuer = `https://${required('KEYCLOAK_HOSTNAME')}/realms/${required('KEYCLOAK_REALM')}/protocol/openid-connect`
const audience = process.env.HOMEASSISTANT_MCP_SERVER_CLIENT_ID || 'homeassistant-mcp-server'
const secret = required('GATEWAY_DISCOVERY_CLIENT_SECRET')
const adminToken = required('GATEWAY_BOOTSTRAP_TOKEN')
const path = '/sdlc-home-assistant'
const upstream = mcpUpstream('homeassistant', process.env.ENABLE_TLS ?? process.env.SDLC_MCP_TLS)
const methods = ['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get']
const scope = {
  scope_name: 'sdlc-home-assistant-access', description: 'Access Home Assistant MCP tools',
  group_mappings: ['home-assistant-users'],
  server_access: [{ server: path, methods, tools: ['*'] }],
  ui_permissions: { list_service: ['sdlc-home-assistant'] }, create_in_idp: false
}

async function request(pathname, options = {}, optional = false) {
  const headers = new Headers(options.headers)
  headers.set('authorization', `Bearer ${adminToken}`)
  const response = await fetch(`${base}${pathname}`, { ...options, headers, signal: options.signal ?? AbortSignal.timeout(30_000) })
  if (optional && response.status === 404) return undefined
  const body = await response.text()
  let value
  try { value = body ? JSON.parse(body) : undefined } catch { throw new Error(`Gateway returned invalid JSON for ${pathname}`) }
  if (!response.ok) throw new Error(`Gateway ${options.method || 'GET'} ${pathname} failed (HTTP ${response.status}): ${value?.detail ?? value?.error ?? 'unknown error'}`)
  return value
}
const post = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const tokenResponse = await fetch(`${issuer}/token`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'mcp-gateway-discovery', client_secret: secret, scope: audience }),
  signal: AbortSignal.timeout(10_000)
})
if (!tokenResponse.ok) throw new Error(`Keycloak discovery token request failed (HTTP ${tokenResponse.status})`)
const discoveryToken = (await tokenResponse.json()).access_token
if (!discoveryToken) throw new Error('Keycloak did not issue a discovery token')
const catalog = await rpc('http://localhost/internal/homeassistant/mcp', discoveryToken, 'tools/list')
if (!Array.isArray(catalog.tools) || !catalog.tools.length) throw new Error('Home Assistant MCP returned no tools')

const existingScope = await request('/api/servers/groups/sdlc-home-assistant-access', {}, true)
if (!existingScope) await request('/api/servers/groups/import', post(scope))
else {
  assert.deepEqual(existingScope.group_mappings, scope.group_mappings, 'Home Assistant group mapping differs')
  assert.deepEqual(existingScope.server_access, scope.server_access, 'Home Assistant gateway permissions differ')
  assert.deepEqual(existingScope.ui_permissions, scope.ui_permissions, 'Home Assistant UI permissions differ')
}

const servers = await request('/api/servers?limit=100')
const existing = servers.servers.find((entry) => entry.path.replace(/\/+$/, '') === path)
if (!existing) {
  const body = new URLSearchParams({
    name: 'Home Assistant', description: 'Home Assistant tools with per-user Keycloak and provider authorization',
    path, proxy_pass_url: upstream, transport: 'streamable-http', supported_transports: 'streamable-http',
    tool_list_json: JSON.stringify(catalog.tools), tags: 'sdlc-local-managed',
    visibility: 'group-restricted', allowed_groups: 'home-assistant-users', overwrite: 'false'
  })
  await request('/api/servers/register', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  await waitForRegistrationScan(path, {
    getScan: () => request(`/api/servers/${path.slice(1)}/security-scan`, {}, true),
    getServer: () => request(`/api/servers/${path.slice(1)}`)
  })
} else {
  assert.equal(existing.proxy_pass_url, upstream, 'Home Assistant backend points to a different upstream')
  assert(existing.tags?.includes('sdlc-local-managed'), 'Home Assistant backend is not managed by this setup')
}
await request(`/api/servers/${path.slice(1)}/oauth-config`, {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    token_url: `https://gateway-idp-tls/realms/${required('KEYCLOAK_REALM')}/protocol/openid-connect/token`,
    client_id: 'mcp-gateway-discovery', client_secret: secret, scopes: [audience], token_auth_style: 'post_body'
  })
})
const egress = await request(`/api/servers/${path.slice(1)}/egress-auth`)
if (!egress.egress_auth_mode || egress.egress_auth_mode === 'none') {
  await request(`/api/servers/${path.slice(1)}/egress-auth`, post({ egress_auth_mode: 'obo_exchange', target_audience: audience, scopes: [audience] }))
} else {
  assert.equal(egress.egress_auth_mode, 'obo_exchange', 'Home Assistant uses a different egress authentication mode')
  assert.equal(egress.target_audience ?? egress.egress_oauth?.target_audience, audience, 'Home Assistant exchange audience differs')
}
const scan = await request(`/api/servers/${path.slice(1)}/rescan`, { method: 'POST', signal: AbortSignal.timeout(120_000) })
assert.equal(scan.scan_failed, false, 'Home Assistant security scan failed')
assert.equal(scan.is_safe, true, 'Home Assistant security scan found unsafe tools')
const recorded = await request(`/api/servers/${path.slice(1)}/security-scan`)
assert.equal(recorded.scan_failed, false)
assert.equal(recorded.is_safe, true)
assert.equal(recorded.scan_timestamp, scan.scan_timestamp, 'Home Assistant scan changed during setup')
assert.equal(typeof recorded.scan_timestamp, 'string', 'Home Assistant scan timestamp is unavailable')
execFileSync('docker', [
  'compose', '--env-file', '.env', '--env-file', required('SDLC_RUNTIME_ENV_FILE'),
  '-f', 'compose.yaml', '-f', 'compose.gateway.yaml', '-f', 'compose.homeassistant.yaml', '-f', 'compose.runtime.yaml',
  ...(mcpTlsEnabled(process.env.ENABLE_TLS ?? process.env.SDLC_MCP_TLS) ? ['-f', 'compose.mcp-tls.yaml'] : []),
  ...(gatewayBase().startsWith('https://') ? ['-f', 'compose.gateway-https.yaml'] : []),
  '--profile', 'mcp', '--profile', 'gateway', '--profile', 'homeassistant', '--profile', 'runtime',
  ...(mcpTlsEnabled(process.env.ENABLE_TLS ?? process.env.SDLC_MCP_TLS) ? ['--profile', 'mcp-tls'] : []),
  'exec', '-T', 'gateway-registry', '/app/.venv/bin/python', '/gateway-scripts/reconcile-security.py', path, recorded.scan_timestamp, upstream
], { stdio: 'inherit' })
const registered = await request(`/api/servers/${path.slice(1)}`)
assert.equal(registered.visibility, 'group-restricted')
assert.deepEqual(registered.allowed_groups, ['home-assistant-users'])
if (!registered.is_enabled) {
  await request('/api/servers/toggle', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ path, new_state: 'true' })
  })
}

const virtual = await request('/api/virtual-servers/virtual/sdlc')
assert(virtual.tags?.includes('sdlc-local-managed'), 'The SDLC virtual server is not managed by this setup')
const core = virtual.tool_mappings
  .filter((mapping) => mapping.backend_server_path !== path)
  .map(({ tool_name, backend_server_path, alias }) => ({ tool_name, backend_server_path, ...(alias ? { alias } : {}) }))
assert(core.length > 0 && core.every((mapping) => ['/sdlc-forgejo', '/sdlc-wikijs'].includes(mapping.backend_server_path)), 'Unexpected virtual server mappings')
const used = new Set(core.map((mapping) => mapping.alias || mapping.tool_name))
const home = catalog.tools.map((tool) => {
  if (typeof tool.name !== 'string' || !tool.name) throw new Error('Invalid Home Assistant tool name')
  const alias = used.has(tool.name) ? `homeassistant_${tool.name}` : undefined
  const exposed = alias || tool.name
  if (used.has(exposed)) throw new Error(`Home Assistant tool alias conflicts: ${exposed}`)
  used.add(exposed)
  return { tool_name: tool.name, backend_server_path: path, ...(alias ? { alias } : {}) }
})
const desired = [...core, ...home]
const current = virtual.tool_mappings.map(({ tool_name, backend_server_path, alias }) => ({ tool_name, backend_server_path, ...(alias ? { alias } : {}) }))
if (JSON.stringify(current) !== JSON.stringify(desired)) {
  await request('/api/virtual-servers/virtual/sdlc', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool_mappings: desired }) })
}
const deadline = Date.now() + 120_000
let ready = false
while (Date.now() < deadline) {
  const inventory = await request('/api/servers?limit=100')
  const entry = inventory.servers.find((item) => item.path.replace(/\/+$/, '') === path)
  if (entry?.is_enabled && entry.health_status === 'healthy') { ready = true; break }
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
assert(ready, 'Home Assistant gateway backend did not become healthy')
console.log(`Home Assistant gateway configured with ${home.length} scanned tools and per-user token exchange.`)
