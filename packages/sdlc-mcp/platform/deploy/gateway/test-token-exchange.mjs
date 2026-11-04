#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { gatewayBase } from './gateway-url.mjs'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const issuer = `https://${required('KEYCLOAK_HOSTNAME')}/realms/${required('KEYCLOAK_REALM')}/protocol/openid-connect`
const resource = process.env.GATEWAY_TEST_RESOURCE || `${gatewayBase()}/virtual/sdlc/mcp`
const clientId = 'mcp-gateway-vscode'
const redirectUri = 'http://127.0.0.1:33418/'
const verifier = randomBytes(32).toString('base64url')
const state = randomBytes(16).toString('hex')
const query = new URLSearchParams({
  client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid', resource, state,
  code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
})
const page = await fetch(`${issuer}/auth?${query}`, { redirect: 'manual' })
const html = await page.text()
const action = html.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&')
assert(action, `Keycloak login form (HTTP ${page.status})`)
const login = await fetch(action, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: page.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ') },
  body: new URLSearchParams({ username: process.env.KEYCLOAK_AUTOMATION_USERNAME || 'mcp-tester', password: required('KEYCLOAK_TEST_PASSWORD'), credentialId: '' })
})
const redirect = new URL(login.headers.get('location') ?? '')
assert.equal(redirect.searchParams.get('state'), state)
const code = redirect.searchParams.get('code')
assert(code, 'Keycloak authorization code')
async function token(form) {
  const response = await fetch(`${issuer}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form)
  })
  const result = await response.json()
  if (!response.ok || !result.access_token) throw new Error(`Keycloak token exchange failed (HTTP ${response.status}, ${result.error ?? 'missing token'}): ${result.error_description ?? ''}`)
  return result.access_token
}
const ingressToken = await token({ client_id: clientId, redirect_uri: redirectUri, grant_type: 'authorization_code', code, code_verifier: verifier, resource })
const claims = (value) => JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'))
const ingress = claims(ingressToken)
assert([ingress.aud].flat().includes(resource), 'Gateway must be an ingress audience')
assert(ingress.groups?.includes('mcp-users'), 'Ingress token must carry the MCP group')
const targets = [
  { audience: process.env.FORGEJO_MCP_SERVER_CLIENT_ID || 'forgejo-mcp-server', url: required('FORGEJO_MCP_PUBLIC_URL') },
  { audience: process.env.WIKIJS_SDLC_MCP_SERVER_CLIENT_ID || 'wikijs-sdlc-mcp-server', url: required('WIKIJS_SDLC_MCP_PUBLIC_URL') }
]
async function tools(url, accessToken) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  })
  if (!response.ok) return { status: response.status }
  const raw = await response.text()
  const result = JSON.parse(raw.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? raw)
  return { status: response.status, tools: result.result?.tools }
}
for (const [index, target] of targets.entries()) {
  const exchangedToken = await token({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: ingressToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    audience: target.audience,
    scope: target.audience,
    client_id: resource,
    client_secret: required('GATEWAY_WEB_CLIENT_SECRET')
  })
  const exchanged = claims(exchangedToken)
  assert.equal(exchanged.sub, ingress.sub, 'Token exchange must preserve the caller')
  assert([exchanged.aud].flat().includes(target.audience), 'Exchanged token must be bound to the target')
  assert(![exchanged.aud].flat().includes(resource), 'Exchanged token must not be usable at the gateway')
  assert(exchanged.realm_access?.roles?.includes('mcp-user'), 'Exchanged token must retain the MCP role')
  const result = await tools(target.url, exchangedToken)
  assert.equal(result.status, 200, 'The intended backend must accept its delegated token')
  assert(Array.isArray(result.tools) && result.tools.length > 0, 'Backend must expose its MCP tools')
  const other = await tools(targets[1 - index].url, exchangedToken)
  assert([401, 403].includes(other.status), 'The other backend must reject the delegated token')
  console.log(`PASS ${target.audience}: delegated subject, target-only audience, role, and backend access`)
}
