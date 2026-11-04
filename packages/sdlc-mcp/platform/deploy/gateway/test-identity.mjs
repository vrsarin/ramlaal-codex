import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

export async function testUserToken({ issuer, clientId, resource, username, password }) {
  const redirectUri = 'http://127.0.0.1:33418/'
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(16).toString('hex')
  const query = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid', resource, state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
  })
  const page = await fetch(`${issuer}/auth-upstream?${query}`, { redirect: 'manual' })
  const html = await page.text()
  const action = html.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&')
  assert(action, `Keycloak login form (HTTP ${page.status})`)
  const login = await fetch(action, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: page.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ') },
    body: new URLSearchParams({ username, password, credentialId: '' })
  })
  const redirect = new URL(login.headers.get('location') ?? '')
  assert.equal(redirect.origin + redirect.pathname, redirectUri)
  assert.equal(redirect.searchParams.get('state'), state)
  const code = redirect.searchParams.get('code')
  assert(code, 'Keycloak authorization code')
  const response = await fetch(`${issuer}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, grant_type: 'authorization_code', code, code_verifier: verifier, resource })
  })
  const result = await response.json()
  if (!response.ok || !result.access_token) throw new Error(`Keycloak token issuance failed (HTTP ${response.status}, ${result.error ?? 'missing token'})`)
  return result.access_token
}

export async function rpc(url, token, method, params = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  const raw = await response.text()
  const body = JSON.parse(raw.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? raw)
  if (!response.ok || body.error) throw new Error(`${method} failed (HTTP ${response.status}): ${body.error?.message ?? 'no result'}`)
  return body.result
}
