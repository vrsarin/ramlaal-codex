#!/usr/bin/env node
import assert from 'node:assert/strict'
import { gatewayBase } from './gateway-url.mjs'
import { rpc, testUserToken } from './test-identity.mjs'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const issuer = `https://${required('KEYCLOAK_HOSTNAME')}/realms/${required('KEYCLOAK_REALM')}/protocol/openid-connect`
const url = `${gatewayBase()}/virtual/sdlc/mcp`
const password = required('KEYCLOAK_TEST_PASSWORD')
const users = [process.env.KEYCLOAK_AUTOMATION_USERNAME || 'mcp-tester', required('KEYCLOAK_TEST_USERNAME')]
assert.notEqual(users[0], users[1], 'Two distinct test users are required')
const backends = [
  { url: required('FORGEJO_MCP_PUBLIC_URL'), client: required('FORGEJO_MCP_OAUTH_CLIENT_ID'), tool: 'get_forgejo_connection', field: 'forgejoConnection' },
  { url: required('WIKIJS_SDLC_MCP_PUBLIC_URL'), client: required('WIKIJS_SDLC_MCP_OAUTH_CLIENT_ID'), tool: 'get_service_status', field: 'wikiJsConnection' }
]
const subjects = new Set()
const results = []
for (const username of users) {
  const token = await testUserToken({ issuer, clientId: 'mcp-gateway-vscode', resource: url, username, password })
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  subjects.add(claims.sub)
  let session
  let id = 0
  async function gatewayRpc(method, params = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(30_000)
    })
    if (method === 'initialize') session = response.headers.get('mcp-session-id')
    const raw = await response.text()
    const body = JSON.parse(raw.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? raw)
    if (!response.ok || body.error) throw new Error(`${method} failed (HTTP ${response.status}): ${body.error?.message ?? 'no result'}`)
    return body.result
  }
  await gatewayRpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'isolation-test', version: '1' } })
  assert(session, 'Gateway must issue an MCP session')
  const userResults = []
  for (const backend of backends) {
    const directToken = await testUserToken({ issuer, clientId: backend.client, resource: backend.url, username, password })
    const directClaims = JSON.parse(Buffer.from(directToken.split('.')[1], 'base64url').toString('utf8'))
    assert.equal(directClaims.sub, claims.sub, 'Direct and gateway identity must match')
    const direct = await rpc(backend.url, directToken, 'tools/call', { name: backend.tool, arguments: {} })
    const delegated = await gatewayRpc('tools/call', { name: backend.tool, arguments: {} })
    assert(!direct.isError && !delegated.isError, 'Status call failed')
    const directStatus = JSON.parse(direct.content[0].text)
    const gatewayStatus = JSON.parse(delegated.content[0].text)
    assert.equal(gatewayStatus.caller, username, 'Gateway must preserve the calling user')
    assert.equal(gatewayStatus[backend.field], directStatus[backend.field], 'Gateway must use the same user grant as the direct endpoint')
    userResults.push(gatewayStatus[backend.field])
  }
  results.push(userResults)
}
assert.equal(subjects.size, 2, 'The callers must have distinct Keycloak subjects')
console.log(`PASS two distinct users retain their own direct-endpoint grants through the gateway${JSON.stringify(results[0]) !== JSON.stringify(results[1]) ? ' (including differing connection states)' : ''}`)
const nonmember = await testUserToken({
  issuer, clientId: 'mcp-gateway-vscode', resource: url,
  username: required('KEYCLOAK_SSO_ADMIN_USERNAME'), password: required('KEYCLOAK_SSO_ADMIN_PASSWORD')
})
const claims = JSON.parse(Buffer.from(nonmember.split('.')[1], 'base64url').toString('utf8'))
assert(!claims.groups?.includes('mcp-users'), 'The nonmember test account must not belong to mcp-users')
const denied = await fetch(url, {
  method: 'POST',
  headers: { authorization: `Bearer ${nonmember}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'nonmember-test', version: '1' } } })
})
assert([401, 403].includes(denied.status), `Nonmember was not denied (HTTP ${denied.status})`)
console.log('PASS Keycloak nonmember denied gateway access')
