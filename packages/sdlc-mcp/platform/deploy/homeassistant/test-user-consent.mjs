#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { completeBrowserLogin } from './browser-login.mjs'
import { testUserToken } from '../gateway/test-identity.mjs'
import { gatewayBase } from '../gateway/gateway-url.mjs'

if (process.env.COMPOSE_PROJECT_NAME !== 'sdlc-ha-test-20261102') {
  throw new Error('This destructive identity test is limited to the approved disposable project')
}
const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const keycloak = `https://${required('KEYCLOAK_HOSTNAME')}`
const homeAssistant = `https://${required('HOMEASSISTANT_HOSTNAME')}`
const realm = required('KEYCLOAK_REALM')
const issuer = `${keycloak}/realms/${realm}/protocol/openid-connect`
const url = `${gatewayBase()}/virtual/sdlc/mcp`
const username = process.env.KEYCLOAK_AUTOMATION_USERNAME || 'mcp-tester'
const password = required('KEYCLOAK_TEST_PASSWORD')
const tokenResponse = await fetch(`${keycloak}/realms/master/protocol/openid-connect/token`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'password', client_id: 'admin-cli', username: required('KEYCLOAK_ADMIN_USERNAME'),
    password: required('KEYCLOAK_ADMIN_PASSWORD')
  })
})
if (!tokenResponse.ok) throw new Error(`Keycloak administrator authentication failed (HTTP ${tokenResponse.status})`)
const adminToken = (await tokenResponse.json()).access_token
async function admin(path, options = {}) {
  const response = await fetch(`${keycloak}/admin/realms/${encodeURIComponent(realm)}${path}`, {
    ...options, headers: { authorization: `Bearer ${adminToken}`, ...options.headers },
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error(`Keycloak administration failed (${options.method || 'GET'} ${response.status})`)
  return response
}
const users = await (await admin(`/users?username=${encodeURIComponent(username)}&exact=true`)).json()
assert.equal(users.length, 1, 'Expected exactly one automation user')
const groups = await (await admin('/groups')).json()
const group = (name) => {
  const matching = groups.filter((entry) => entry.path === `/${name}`)
  assert.equal(matching.length, 1, `Expected exactly one ${name} group`)
  return matching[0].id
}
const homeGroup = group('home-assistant-users')
const mcpGroup = group('mcp-users')
const userPath = `/users/${encodeURIComponent(users[0].id)}`
const initialGroups = await (await admin(`${userPath}/groups`)).json()
assert(!initialGroups.some((entry) => entry.id === homeGroup), 'Automation user already has Home Assistant membership')
const membership = `${userPath}/groups/${encodeURIComponent(homeGroup)}`

async function sessionFor(name, secret) {
  const token = await testUserToken({ issuer, clientId: 'mcp-gateway-vscode', resource: url, username: name, password: secret })
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
    if (!response.ok || body.error) throw new Error(`${method} failed (HTTP ${response.status}): ${body.error?.message ?? 'no result'}`)
    return body.result
  }
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'home-assistant-consent-test', version: '1' } })
  assert(session, 'Gateway did not create an MCP session')
  await rpc('notifications/initialized', {}, true)
  return rpc
}

function content(result) {
  assert(Array.isArray(result?.content) && typeof result.content[0]?.text === 'string', 'Invalid MCP tool result')
  return result.content[0].text
}
async function connectLink(rpc) {
  const result = await rpc('tools/call', { name: 'connect_home_assistant', arguments: {} })
  assert(!result.isError, 'Home Assistant connect tool failed')
  const state = JSON.parse(content(result))
  assert.equal(state.connected, false, 'Refusing to overwrite an existing Home Assistant user grant')
  assert.equal(typeof state.authorizeUrl, 'string')
  return state.authorizeUrl
}

let added = false
let temporaryUser
let connected = false
let userRpc
let failure
try {
  await admin(membership, { method: 'PUT' })
  added = true
  userRpc = await sessionFor(username, password)
  let link = await connectLink(userRpc)
  const mismatch = await completeBrowserLogin({
    authorizeUrl: link, keycloak: issuer, homeAssistant, username: 'home-assistant-discovery',
    password: required('GATEWAY_HOME_DISCOVERY_PASSWORD')
  })
  assert.equal(mismatch.status, 502, 'The wrong Home Assistant account must be rejected')
  link = await connectLink(userRpc)
  const accepted = await completeBrowserLogin({ authorizeUrl: link, keycloak: issuer, homeAssistant, username, password })
  assert.equal(accepted.status, 200, 'The matching Home Assistant account must connect')
  connected = true
  const state = JSON.parse(content(await userRpc('tools/call', { name: 'connect_home_assistant', arguments: {} })))
  assert.equal(state.connected, true, 'Connected user must retain their own grant')
  const readOnly = await userRpc('tools/call', { name: 'homeassistant__GetLiveContext', arguments: {} })
  const resultText = content(readOnly)
  assert(!resultText.includes('/oauth/homeassistant/start'), 'Connected user must reach Home Assistant without another consent prompt')
  if (readOnly.isError) assert.match(resultText, /exposed|entities/i, 'Unexpected read-only Home Assistant error')

  const otherName = `sdlc-consent-test-${randomBytes(8).toString('hex')}`
  const otherPassword = randomBytes(24).toString('base64url')
  const created = await admin('/users', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: otherName, firstName: 'Temporary', lastName: 'Consent Test', email: `${otherName}@example.test`,
      enabled: true, emailVerified: true, credentials: [{ type: 'password', value: otherPassword, temporary: false }]
    })
  })
  const createdUrl = new URL(created.headers.get('location') ?? '')
  assert.equal(createdUrl.origin, keycloak)
  assert(createdUrl.pathname.startsWith(`/admin/realms/${encodeURIComponent(realm)}/users/`), 'Unexpected created user location')
  temporaryUser = createdUrl.pathname.split('/').pop()
  assert.match(temporaryUser, /^[0-9a-f-]{36}$/i)
  for (const id of [mcpGroup, homeGroup]) await admin(`/users/${temporaryUser}/groups/${id}`, { method: 'PUT' })
  const otherRpc = await sessionFor(otherName, otherPassword)
  await connectLink(otherRpc)
  const otherCall = await otherRpc('tools/call', { name: 'homeassistant__GetLiveContext', arguments: {} })
  assert(otherCall.isError && content(otherCall).includes('/oauth/homeassistant/start'), 'A second user must not inherit the first user grant')
  console.log('PASS matching consent, wrong-account rejection, read-only call, and cross-user grant isolation')
} catch (error) {
  failure = error
} finally {
  const cleanupErrors = []
  for (const cleanup of [
    async () => {
      if (!connected) return
      const result = JSON.parse(content(await userRpc('tools/call', { name: 'disconnect_home_assistant', arguments: {} })))
      assert.equal(result.disconnected, true, 'Test grant must be revoked')
    },
    async () => { if (temporaryUser) await admin(`/users/${temporaryUser}`, { method: 'DELETE' }) },
    async () => {
      if (!added) return
      await admin(membership, { method: 'DELETE' })
      const after = await (await admin(`${userPath}/groups`)).json()
      assert(!after.some((entry) => entry.id === homeGroup), 'Temporary group membership was not removed')
    }
  ]) {
    try { await cleanup() } catch (error) { cleanupErrors.push(error) }
  }
  if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Identity test cleanup failed')
}
if (failure) throw failure
