#!/usr/bin/env node
import assert from 'node:assert/strict'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const keycloak = `https://${required('KEYCLOAK_HOSTNAME')}`
const home = `https://${required('HOMEASSISTANT_HOSTNAME')}`
const realm = required('KEYCLOAK_REALM')
const discoveryMode = process.argv.includes('--discovery')
const username = discoveryMode ? 'home-assistant-discovery' : (process.env.KEYCLOAK_AUTOMATION_USERNAME || 'mcp-tester')
const password = required(discoveryMode ? 'GATEWAY_HOME_DISCOVERY_PASSWORD' : 'KEYCLOAK_TEST_PASSWORD')
const deadline = Date.now() + 120_000
let ready = false
let lastStatus = 'no response'
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${home}/auth/oidc/welcome`, { signal: AbortSignal.timeout(3000) })
    lastStatus = `HTTP ${response.status}`
    if (response.status === 200) { ready = true; break }
  } catch (error) {
    lastStatus = error instanceof Error ? error.message : 'connection failed'
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
assert(ready, `Home Assistant OIDC did not become ready: ${lastStatus}`)
const adminResponse = await fetch(`${keycloak}/realms/master/protocol/openid-connect/token`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'password', client_id: 'admin-cli', username: required('KEYCLOAK_ADMIN_USERNAME'),
    password: required('KEYCLOAK_ADMIN_PASSWORD')
  })
})
if (!adminResponse.ok) throw new Error(`Keycloak administrator authentication failed (${adminResponse.status})`)
const adminToken = (await adminResponse.json()).access_token
async function admin(path, method = 'GET') {
  const response = await fetch(`${keycloak}/admin/realms/${encodeURIComponent(realm)}${path}`, {
    method, headers: { authorization: `Bearer ${adminToken}` }
  })
  if (!response.ok) throw new Error(`Keycloak administration failed (${method} ${response.status})`)
  return response.status === 204 ? undefined : response.json()
}
const users = await admin(`/users?username=${encodeURIComponent(username)}&exact=true`)
assert.equal(users.length, 1, 'Expected exactly one automation user')
const groups = await admin('/groups?search=home-assistant-users')
const matching = groups.filter((group) => group.path === '/home-assistant-users')
assert.equal(matching.length, 1, 'Expected exactly one Home Assistant group')
const membership = `/users/${encodeURIComponent(users[0].id)}/groups/${encodeURIComponent(matching[0].id)}`
const priorGroups = await admin(`/users/${encodeURIComponent(users[0].id)}/groups`)
if (discoveryMode) {
  assert.deepEqual(priorGroups.map((group) => group.path), ['/home-assistant-users'], 'Discovery identity must have only the Home Assistant group')
} else {
  assert(!priorGroups.some((group) => group.id === matching[0].id), 'Automation user already has membership; refusing to remove it')
}

class Browser {
  cookies = new Map()
  async request(address, options = {}) {
    const url = new URL(address)
    const headers = new Headers(options.headers)
    const cookies = this.cookies.get(url.hostname) ?? new Map()
    if (cookies.size) headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '))
    const response = await fetch(url, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) })
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]
      const index = pair.indexOf('=')
      cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
    this.cookies.set(url.hostname, cookies)
    return response
  }
}
async function signIn() {
  const browser = new Browser()
  assert.equal((await browser.request(`${home}/auth/oidc/welcome`)).status, 200)
  const redirect = await browser.request(`${home}/auth/oidc/redirect`)
  assert.equal(redirect.status, 200, 'Home Assistant OIDC discovery')
  const html = await redirect.text()
  const encoded = html.match(/decodeURIComponent\("([^"]+)"\)/)?.[1]
  assert(encoded, 'Home Assistant authorization redirect')
  const authorization = decodeURIComponent(encoded)
  assert.equal(new URL(authorization).origin, keycloak, 'OIDC must redirect to the configured Keycloak')
  const page = await browser.request(authorization)
  const login = (await page.text()).match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&')
  assert(login, 'Keycloak login form')
  const submitted = await browser.request(login, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, credentialId: '' })
  })
  const callback = new URL(submitted.headers.get('location') ?? '')
  assert.equal(callback.origin, home)
  assert.equal(callback.pathname, '/auth/oidc/callback')
  return browser.request(callback)
}

if (discoveryMode) {
  const accepted = await signIn()
  assert.equal(accepted.status, 302, 'Discovery identity must pass the Home Assistant OIDC callback')
  assert.equal(new URL(accepted.headers.get('location')).pathname, '/auth/oidc/finish')
  console.log('PASS dedicated Keycloak discovery identity can start Home Assistant SSO')
} else {
  let added = false
  try {
    const denied = await signIn()
    assert.equal(denied.status, 403, 'A nonmember must be denied by Home Assistant OIDC')
    await admin(membership, 'PUT')
    added = true
    const accepted = await signIn()
    assert.equal(accepted.status, 302, 'A group member must pass the Home Assistant OIDC callback')
    assert.equal(new URL(accepted.headers.get('location')).pathname, '/auth/oidc/finish')
    console.log('PASS Home Assistant Keycloak SSO denies nonmembers and accepts the separate group')
  } finally {
    if (added) {
      await admin(membership, 'DELETE')
      const after = await admin(`/users/${encodeURIComponent(users[0].id)}/groups`)
      assert(!after.some((group) => group.id === matching[0].id), 'Temporary group membership was not removed')
      console.log('PASS temporary automation group membership removed')
    }
  }
}
