#!/usr/bin/env node
import assert from 'node:assert/strict'
import { rpc, testUserToken } from '../gateway/test-identity.mjs'
import { gatewayBase } from '../gateway/gateway-url.mjs'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const issuer = `https://${required('KEYCLOAK_HOSTNAME')}/realms/${required('KEYCLOAK_REALM')}/protocol/openid-connect`
const url = `${gatewayBase()}/virtual/sdlc/mcp`
const direct = 'http://localhost/internal/homeassistant/mcp'
const audience = process.env.HOMEASSISTANT_MCP_SERVER_CLIENT_ID || 'homeassistant-mcp-server'
const response = await fetch(`${issuer}/token`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials', client_id: 'mcp-gateway-discovery',
    client_secret: required('GATEWAY_DISCOVERY_CLIENT_SECRET'), scope: audience
  }),
  signal: AbortSignal.timeout(10_000)
})
if (!response.ok) throw new Error(`Keycloak discovery token request failed (HTTP ${response.status})`)
const discoveryToken = (await response.json()).access_token
assert(discoveryToken, 'Keycloak did not issue a discovery token')
const tools = (await rpc(direct, discoveryToken, 'tools/list')).tools
assert(Array.isArray(tools) && tools.some((tool) => tool.name === 'connect_home_assistant'), 'Discovery catalog is incomplete')
const discoveryCall = await fetch(direct, {
  method: 'POST',
  headers: { authorization: `Bearer ${discoveryToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'connect_home_assistant', arguments: {} } }),
  signal: AbortSignal.timeout(10_000)
})
assert.equal(discoveryCall.status, 403, 'Discovery credentials must not invoke tools')

const token = await testUserToken({
  issuer, clientId: 'mcp-gateway-vscode', resource: url,
  username: process.env.KEYCLOAK_AUTOMATION_USERNAME || 'mcp-tester', password: required('KEYCLOAK_TEST_PASSWORD')
})
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
assert(Array.isArray(claims.groups) && claims.groups.includes('mcp-users'), 'The nonmember test account must belong to the MCP group')
assert(!claims.groups.includes('home-assistant-users'), 'The nonmember test account must not belong to the Home Assistant group')
async function gateway(method, params, session) {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000)
  })
}
const initialized = await gateway('initialize', {
  protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'home-assistant-access-test', version: '1.0' }
})
assert.equal(initialized.status, 200, 'Nonmember gateway initialization failed')
const session = initialized.headers.get('mcp-session-id')
assert(session, 'Gateway did not create an MCP session')
const deadline = Date.now() + 30_000
let denied
do {
  denied = await gateway('tools/call', { name: 'connect_home_assistant', arguments: {} }, session)
  if (![502, 503].includes(denied.status) || Date.now() >= deadline) break
  await new Promise((resolve) => setTimeout(resolve, 1000))
} while (true)
assert.equal(denied.status, 403, 'Nonmembers must not invoke Home Assistant tools')
console.log('PASS discovery credentials and nonmembers cannot invoke Home Assistant tools')
