#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { rpc as directRpc, testUserToken } from './test-identity.mjs'
import { gatewayBase } from './gateway-url.mjs'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const username = process.env.KEYCLOAK_AUTOMATION_USERNAME || 'mcp-tester'
const issuer = `https://${required('KEYCLOAK_HOSTNAME')}/realms/${required('KEYCLOAK_REALM')}/protocol/openid-connect`
const url = `${gatewayBase()}/virtual/sdlc/mcp`
const vscode = JSON.parse(await readFile(new URL('../../.vscode/mcp.json', import.meta.url), 'utf8'))
assert.deepEqual(Object.keys(vscode.servers), ['sdlcGateway'], 'VS Code must configure one gateway server')
assert.equal(vscode.servers.sdlcGateway.url, url, 'VS Code gateway URL must match the configured host')
assert.equal(vscode.servers.sdlcGateway.oauth?.clientId, 'mcp-gateway-vscode', 'VS Code must use the registered gateway client')
const token = await testUserToken({ issuer, clientId: 'mcp-gateway-vscode', resource: url, username, password: required('KEYCLOAK_TEST_PASSWORD') })
for (const path of ['sdlc-forgejo', 'sdlc-wikijs']) {
  const response = await fetch(`${gatewayBase()}/api/servers/${path}`, {
    headers: { authorization: `Bearer ${required('GATEWAY_BOOTSTRAP_TOKEN')}` }, signal: AbortSignal.timeout(30_000)
  })
  assert(response.ok, `Gateway server lookup for ${path} failed (HTTP ${response.status})`)
  const server = await response.json()
  assert(!server.tags?.includes('security-pending'), `${path} still displays a pending security badge`)
}
const directBackends = [
  { url: required('FORGEJO_MCP_PUBLIC_URL'), client: required('FORGEJO_MCP_OAUTH_CLIENT_ID'), prefix: 'forgejo' },
  { url: required('WIKIJS_SDLC_MCP_PUBLIC_URL'), client: required('WIKIJS_SDLC_MCP_OAUTH_CLIENT_ID'), prefix: 'wikijs' }
]
for (const backend of directBackends) {
  const directToken = await testUserToken({ issuer, clientId: backend.client, resource: backend.url, username, password: required('KEYCLOAK_TEST_PASSWORD') })
  backend.tools = (await directRpc(backend.url, directToken, 'tools/list')).tools
}
const counts = new Map()
for (const backend of directBackends) for (const tool of backend.tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
const expected = directBackends.flatMap((backend) => backend.tools.map((tool) => counts.get(tool.name) > 1 ? `${backend.prefix}_${tool.name}` : tool.name)).sort()
let session
let id = 0
async function rpc(method, params = {}, notification = false) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++id }), method, params }),
    signal: AbortSignal.timeout(60_000)
  })
  if (method === 'initialize') session = response.headers.get('mcp-session-id')
  if (notification && response.ok) return
  const raw = await response.text()
  const body = JSON.parse(raw.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? raw)
  if (!response.ok || body.error) throw new Error(`${method} failed (HTTP ${response.status}): ${body.error?.message ?? raw}`)
  return body.result
}

await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'sdlc-gateway-test', version: '1.0' } })
assert(session, 'Gateway initialize must create a session')
await rpc('notifications/initialized', {}, true)
const deadline = Date.now() + 60_000
let catalog = await rpc('tools/list')
while (catalog.tools.length !== expected.length && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2000))
  catalog = await rpc('tools/list')
}
assert.deepEqual(catalog.tools.map((tool) => tool.name).sort(), expected, 'Virtual server must expose exactly the configured backend tools')
for (const name of ['get_service_status', 'get_forgejo_connection', 'connect_wikijs', 'connect_forgejo']) {
  assert(catalog.tools.some((tool) => tool.name === name), `Missing ${name}`)
}
const statuses = {}
for (const name of ['get_service_status', 'get_forgejo_connection']) {
  const result = await rpc('tools/call', { name, arguments: {} })
  assert(!result.isError, `${name} failed: ${JSON.stringify(result.content)}`)
  const status = JSON.parse(result.content[0].text)
  assert.equal(status.caller, username, `${name} must preserve the calling user`)
  statuses[name] = status
  console.log(`PASS ${name}: caller identity preserved`)
}
for (const { status, field, method, args, provider } of [
  { status: statuses.get_service_status, field: 'wikiJsConnection', method: 'discover_wikijs_capabilities', args: {}, provider: 'wikijs' },
  { status: statuses.get_forgejo_connection, field: 'forgejoConnection', method: 'list_organizations', args: {}, provider: 'forgejo' }
]) {
  if (status[field] === 'connected') {
    const result = await rpc('tools/call', { name: method, arguments: args })
    assert(!result.isError, `${provider} authenticated call failed: ${JSON.stringify(result.content)}`)
    const data = JSON.parse(result.content[0].text)
    if (provider === 'wikijs') assert(Array.isArray(data.tools) && data.tools.length > 0, 'Wiki.js must return its downstream tools')
    else assert(Array.isArray(data), 'Forgejo must return organizations')
    console.log(`PASS ${provider}: connected user can access provider data`)
    continue
  }
  if (process.env.GATEWAY_REQUIRE_CONNECTED === 'true') throw new Error(`${provider} automation grant is not connected`)
  assert.equal(status[field], 'not-connected', `${provider} returned an unexpected connection status`)
  const result = await rpc('tools/call', { name: method, arguments: args })
  const message = result.content?.[0]?.text ?? ''
  assert(result.isError, `${method} must report missing consent`)
  assert(message.includes(`/oauth/${provider}/start?state=`), `${method} must provide a provider consent link`)
  console.log(`PASS ${provider}: missing grant produces a consent link`)
}
console.log(`PASS gateway session and ${catalog.tools.length} tools`)
