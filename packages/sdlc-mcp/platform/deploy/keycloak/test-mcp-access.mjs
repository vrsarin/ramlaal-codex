#!/usr/bin/env node
// Read-only access checks for the configured group, including an out-of-group account.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const host = `https://${required('KEYCLOAK_HOSTNAME')}`
const realm = required('KEYCLOAK_REALM')
const issuer = `${host}/realms/${realm}/protocol/openid-connect`
const redirectUri = 'http://127.0.0.1:33418/'
const resources = [
  { url: required('FORGEJO_MCP_PUBLIC_URL'), client: required('FORGEJO_MCP_OAUTH_CLIENT_ID') },
  { url: required('WIKIJS_SDLC_MCP_PUBLIC_URL'), client: required('WIKIJS_SDLC_MCP_OAUTH_CLIENT_ID') }
]
const developer = required('KEYCLOAK_TEST_USERNAME')
const automation = process.env.KEYCLOAK_AUTOMATION_USERNAME || 'mcp-tester'
const outsider = required('KEYCLOAK_SSO_ADMIN_USERNAME')
const testPassword = required('KEYCLOAK_TEST_PASSWORD')
const outsiderPassword = required('KEYCLOAK_SSO_ADMIN_PASSWORD')
assert.notEqual(outsider, developer, 'The negative-test account must differ from the developer')
assert.notEqual(outsider, automation, 'The negative-test account must differ from the automation user')

const adminResponse = await fetch(`${host}/realms/master/protocol/openid-connect/token`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: required('KEYCLOAK_ADMIN_USERNAME'), password: required('KEYCLOAK_ADMIN_PASSWORD') })
})
assert.equal(adminResponse.status, 200, 'Keycloak administration login')
const adminToken = (await adminResponse.json()).access_token
assert(adminToken, 'Keycloak administration token')
async function admin(path) {
  const response = await fetch(`${host}/admin/realms/${realm}/${path}`, { headers: { authorization: `Bearer ${adminToken}` } })
  assert.equal(response.status, 200, `Keycloak admin GET ${path.split('?')[0]}`)
  return response.json()
}
const groups = await admin('groups?search=mcp-users')
const matches = groups.filter((group) => group.name === 'mcp-users')
assert.equal(matches.length, 1, 'Expected one MCP users group')
assert.equal(matches[0].path, '/mcp-users', 'MCP users group must be top-level')
const groupRoles = await admin(`groups/${matches[0].id}/role-mappings`)
assert.deepEqual((groupRoles.realmMappings ?? []).map((role) => role.name), ['mcp-user'])
assert.equal(groupRoles.realmMappings[0].composite, false)
assert.deepEqual(Object.keys(groupRoles.clientMappings ?? {}), ['mcp-wiki-group-source'])
const wikiRoles = groupRoles.clientMappings['mcp-wiki-group-source'].mappings
assert.deepEqual(wikiRoles.map((role) => role.name), ['mcp-users'])
assert.equal(wikiRoles[0].composite, false)
const members = await admin(`groups/${matches[0].id}/members?max=100`)
for (const username of [developer, automation]) assert(members.some((user) => user.username === username), 'Configured account must belong to MCP users')
assert(!members.some((user) => user.username === outsider), 'Negative-test account must not belong to MCP users')

const developerGroups = (await admin('groups?search=developers')).filter((group) => group.name === 'developers')
assert.equal(developerGroups.length, 1, 'Expected one developers group')
assert.equal(developerGroups[0].path, '/developers', 'Developers group must be top-level')
const developerGroupRoles = await admin(`groups/${developerGroups[0].id}/role-mappings`)
assert.deepEqual(developerGroupRoles.realmMappings ?? [], [], 'Developers must not receive realm roles')
assert.deepEqual(Object.keys(developerGroupRoles.clientMappings ?? {}), ['mcp-wiki-group-source'])
const developerProviderRoles = developerGroupRoles.clientMappings['mcp-wiki-group-source'].mappings
assert.deepEqual(developerProviderRoles.map((role) => role.name), ['developers'])
assert.equal(developerProviderRoles[0].composite, false)
const developerMembers = await admin(`groups/${developerGroups[0].id}/members?max=100`)
for (const username of [developer, outsider]) assert(developerMembers.some((user) => user.username === username), 'Human development account must belong to developers')
assert(!developerMembers.some((user) => user.username === automation), 'Automation account must not belong to developers')
for (const username of [developer, automation, outsider]) {
  const users = await admin(`users?${new URLSearchParams({ username, exact: 'true' })}`)
  assert.equal(users.length, 1, 'Expected one account for role verification')
  const roles = await admin(`users/${users[0].id}/role-mappings/realm`)
  assert(!roles.some((role) => role.name === 'mcp-user'), 'MCP access must come from the group rather than a direct realm role')
}

async function tokenFor(username, password, target) {
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(16).toString('hex')
  const query = new URLSearchParams({
    client_id: target.client, redirect_uri: redirectUri, response_type: 'code', scope: 'openid',
    resource: target.url, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256'
  })
  const page = await fetch(`${issuer}/auth-upstream?${query}`, { redirect: 'manual' })
  const html = await page.text()
  const action = html.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&')
  assert(action, 'Keycloak login form')
  const login = await fetch(action, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: page.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ') },
    body: new URLSearchParams({ username, password, credentialId: '' })
  })
  const redirect = new URL(login.headers.get('location') ?? '')
  assert.equal(redirect.origin + redirect.pathname, redirectUri, 'Keycloak authorization callback')
  assert.equal(redirect.searchParams.get('state'), state)
  const code = redirect.searchParams.get('code')
  assert(code, 'Keycloak authorization code')
  const tokenResponse = await fetch(`${issuer}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: target.client, redirect_uri: redirectUri, grant_type: 'authorization_code', code, code_verifier: verifier, resource: target.url })
  })
  assert.equal(tokenResponse.status, 200, 'Keycloak resource token exchange')
  const token = (await tokenResponse.json()).access_token
  assert(token, 'Keycloak access token')
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  assert([claims.aud].flat().includes(target.url), 'Token must be bound to the requested MCP resource')
  return { token, claims }
}

async function status(target, token) {
  const response = await fetch(target.url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  })
  return response.status
}

let developerTokens
for (const [label, username, password, allowed] of [
  ['developer', developer, testPassword, true],
  ['automation', automation, testPassword, true],
  ['nonmember', outsider, outsiderPassword, false]
]) {
  const tokens = []
  for (const target of resources) {
    const result = await tokenFor(username, password, target)
    assert.equal(result.claims.realm_access?.roles?.includes('mcp-user') ?? false, allowed, `${label} group role`)
    const code = await status(target, result.token)
    assert(allowed ? code === 200 : [401, 403].includes(code), `${label} MCP access returned HTTP ${code}`)
    tokens.push(result.token)
  }
  if (label === 'developer') developerTokens = tokens
  console.log(`PASS ${label}: ${allowed ? 'both MCP servers allowed' : 'both MCP servers refused'}`)
}
assert([401, 403].includes(await status(resources[1], developerTokens[0])), 'Forgejo token must not access Wiki.js MCP')
assert([401, 403].includes(await status(resources[0], developerTokens[1])), 'Wiki.js token must not access Forgejo MCP')
console.log('PASS tokens remain bound to their individual MCP audiences')

const wiki = `https://${required('WIKIJS_HOSTNAME')}/_api`
const bootstrap = await (await fetch(`${wiki}/bootstrap`)).json()
const site = bootstrap.site?.id
assert(site, 'Wiki.js site ID')
const strategies = await (await fetch(`${wiki}/sites/${site}/auth/strategies`)).json()
const local = strategies.find((strategy) => strategy.activeStrategy?.strategy?.key === 'local')?.id
assert(local, 'Wiki.js local administrator strategy')
const login = await fetch(`${wiki}/sites/${site}/auth/login`, {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ strategyId: local, username: required('WIKIJS_ADMIN_EMAIL'), password: required('WIKIJS_ADMIN_PASSWORD') })
})
assert.equal(login.status, 200, 'Wiki.js administrator login')
assert((await login.json()).authenticated, 'Wiki.js administrator authentication')
const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
const wikiGroupsResponse = await fetch(`${wiki}/groups`, { headers: { cookie } })
assert.equal(wikiGroupsResponse.status, 200, 'Wiki.js groups lookup')
const wikiGroups = await wikiGroupsResponse.json()
for (const [name, permissions] of [['mcp-users', ['use:mcp']], ['developers', ['manage:system']]]) {
  const matches = wikiGroups.filter((group) => group.name === name)
  assert.equal(matches.length, 1, `Expected one mapped Wiki.js ${name} group`)
  const groupResponse = await fetch(`${wiki}/groups/${matches[0].id}`, { headers: { cookie } })
  assert.equal(groupResponse.status, 200, `Wiki.js ${name} permissions lookup`)
  const wikiGroup = await groupResponse.json()
  assert.deepEqual(wikiGroup.permissions, permissions)
  assert.deepEqual(wikiGroup.rules, [])
}
console.log('PASS mapped Wiki.js groups keep narrow MCP and full local developer permissions')
