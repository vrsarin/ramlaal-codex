#!/usr/bin/env node
// Run with .env loaded. Uses the dedicated automation user; never changes another user's grant.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const issuer = `https://${required('KEYCLOAK_HOSTNAME')}/realms/${required('KEYCLOAK_REALM')}`
const resource = required('FORGEJO_MCP_PUBLIC_URL')
const forgejo = `https://${required('FORGEJO_HOSTNAME')}`
const clientId = 'https://vscode.dev/oauth/client-metadata.json'
const redirectUri = 'http://127.0.0.1:33418/'
const username = process.env.KEYCLOAK_AUTOMATION_USERNAME || 'mcp-tester'
const password = required('KEYCLOAK_TEST_PASSWORD')
const admin = required('FORGEJO_ADMIN_USERNAME')
const adminPassword = required('FORGEJO_ADMIN_PASSWORD')

class Browser {
  #cookies = new Map()
  async request(address, options = {}) {
    const url = new URL(address)
    const cookies = this.#cookies.get(url.hostname) ?? new Map()
    const headers = new Headers(options.headers)
    if (cookies.size) headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '))
    const response = await fetch(url, { ...options, headers, redirect: 'manual' })
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const equals = pair.indexOf('=')
      cookies.set(pair.slice(0, equals), pair.slice(equals + 1))
    }
    this.#cookies.set(url.hostname, cookies)
    return response
  }
}

function location(response, origin) {
  const value = response.headers.get('location')
  if (!value) throw new Error(`Expected a redirect, got HTTP ${response.status}`)
  return new URL(value, origin).toString()
}

function formAction(html) {
  const action = html.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]
  if (!action) throw new Error('Keycloak login form not found')
  return action.replaceAll('&amp;', '&')
}

function field(html, name) {
  return html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1] ?? ''
}

function authorization(path) {
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(24).toString('base64url')
  const query = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid',
    resource, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256'
  })
  return { url: `${issuer}/protocol/openid-connect/${path}?${query}`, verifier, state }
}

async function keycloakLogin(browser, url) {
  const page = await browser.request(url)
  if (page.status === 302 || page.status === 303) return location(page, url)
  assert.equal(page.status, 200, 'Keycloak login page')
  const login = await browser.request(formAction(await page.text()), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, credentialId: '' })
  })
  let next = location(login, issuer)
  if (new URL(next).pathname.endsWith('/login-actions/required-action')) {
    const consent = await browser.request(next)
    const html = await consent.text()
    const action = html.match(/<form[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&')
    const code = field(html, 'code')
    assert(action && code && html.includes('name="accept"'), 'Keycloak client consent')
    const accepted = await browser.request(new URL(action, issuer), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, accept: '' })
    })
    next = location(accepted, issuer)
  }
  return next
}

async function exchange(redirect, auth) {
  const url = new URL(redirect)
  assert.equal(url.origin + url.pathname, redirectUri)
  assert.equal(url.searchParams.get('state'), auth.state)
  const code = url.searchParams.get('code')
  assert(code, 'Keycloak must issue an authorization code')
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, grant_type: 'authorization_code', code, code_verifier: auth.verifier, resource })
  })
  assert.equal(response.status, 200, 'CIMD token exchange')
  const result = await response.json()
  assert(result.access_token, 'Keycloak must issue an access token')
  return result.access_token
}

async function tool(token, name) {
  const response = await fetch(resource, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })
  })
  assert.equal(response.status, 200, `${name} HTTP status`)
  const raw = await response.text()
  const json = JSON.parse(raw.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? raw)
  if (json.error || json.result?.isError) throw new Error(`${name} failed: ${json.error?.message ?? json.result?.content?.[0]?.text}`)
  return JSON.parse(json.result.content[0].text)
}

async function loginForgejoAdmin(browser) {
  const page = await browser.request(`${forgejo}/user/login`)
  const csrf = field(await page.text(), '_csrf')
  const login = await browser.request(`${forgejo}/user/login`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, user_name: admin, password: adminPassword })
  })
  assert([302, 303].includes(login.status), 'Forgejo login')
}

async function approveForgejo(browser, authorizeUrl) {
  const unauthenticated = await browser.request(authorizeUrl)
  assert([302, 303].includes(unauthenticated.status), 'Forgejo requires sign-in')
  const loginUrl = location(unauthenticated, forgejo)
  assert.equal(new URL(loginUrl).pathname, '/user/login')
  const login = await browser.request(loginUrl)
  assert.equal(new URL(location(login, forgejo)).pathname, '/user/oauth2/Keycloak', 'MCP login skips the Forgejo landing page')
  const provider = await browser.request(location(login, forgejo))
  const keycloakUrl = location(provider, forgejo)
  assert.equal(new URL(keycloakUrl).host, new URL(issuer).host, 'Forgejo uses Keycloak')
  const providerCallback = await keycloakLogin(browser, keycloakUrl)
  assert.equal(new URL(providerCallback).pathname, '/user/oauth2/Keycloak/callback')
  const signedIn = await browser.request(providerCallback)
  const consentUrl = location(signedIn, forgejo)
  assert.equal(new URL(consentUrl).pathname, '/login/oauth/authorize')
  const consent = await browser.request(consentUrl)
  if (consent.status === 302 || consent.status === 303) return location(consent, forgejo)
  assert.equal(consent.status, 200, 'Forgejo consent page')
  const html = await consent.text()
  const form = new URLSearchParams({ granted: 'true' })
  for (const name of ['_csrf', 'client_id', 'state', 'scope', 'nonce', 'redirect_uri']) form.set(name, field(html, name))
  assert(form.get('client_id'), 'Forgejo consent form')
  const grant = await browser.request(`${forgejo}/login/oauth/grant`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form
  })
  return location(grant, forgejo)
}

const preflight = authorization('auth-upstream')
const preflightToken = await exchange(await keycloakLogin(new Browser(), preflight.url), preflight)
const prior = await tool(preflightToken, 'get_forgejo_connection')
if (prior.forgejoConnection !== 'not-connected') throw new Error('Automation user already has a Forgejo grant; refusing to modify it.')

let mayHaveConnected = false
try {
  const browser = new Browser()
  const auth = authorization('auth')
  const intercepted = await browser.request(auth.url)
  assert.equal(intercepted.status, 302, 'Forgejo resource authorization is intercepted')
  const start = await browser.request(location(intercepted, issuer))
  const keycloakUrl = location(start, issuer)
  assert(new URL(keycloakUrl).pathname.endsWith('/auth-upstream'), 'Initial Keycloak identity check')
  const loginCallback = await keycloakLogin(browser, keycloakUrl)
  const linked = await browser.request(loginCallback)
  const forgejoStartUrl = location(linked, issuer)
  assert.equal(new URL(forgejoStartUrl).pathname, '/oauth/forgejo/start')
  const forgejoStart = await browser.request(forgejoStartUrl)
  const authorizeUrl = location(forgejoStart, forgejo)
  assert.equal(new URL(authorizeUrl).pathname, '/login/oauth/authorize')
  const unrelated = new URL(authorizeUrl)
  unrelated.searchParams.set('redirect_uri', 'http://localhost/oauth/other/callback')
  const unrelatedBrowser = new Browser()
  const unrelatedRequest = await unrelatedBrowser.request(unrelated)
  const unrelatedLogin = await unrelatedBrowser.request(location(unrelatedRequest, forgejo))
  assert.equal(unrelatedLogin.status, 200, 'Other applications retain the normal Forgejo login page')
  const existingSession = new Browser()
  await loginForgejoAdmin(existingSession)
  const existingConsent = await existingSession.request(authorizeUrl)
  const existingLocation = existingConsent.headers.get('location') ?? ''
  assert.notEqual(new URL(existingLocation || '/', forgejo).pathname, '/user/login', 'An existing Forgejo session remains in use')
  assert([200, 302, 303].includes(existingConsent.status), 'Existing Forgejo session reaches authorization')
  const forgejoRedirect = await approveForgejo(browser, authorizeUrl)
  assert.equal(new URL(forgejoRedirect).pathname, '/oauth/forgejo/callback')
  mayHaveConnected = true
  const completed = await browser.request(forgejoRedirect)
  const resume = location(completed, issuer)
  assert(new URL(resume).pathname.endsWith('/auth-upstream'), 'Resume the original Keycloak authorization')
  const clientRedirect = await keycloakLogin(browser, resume)
  const token = await exchange(clientRedirect, auth)
  assert.equal((await tool(token, 'get_forgejo_connection')).forgejoConnection, 'connected')
  assert(Array.isArray(await tool(token, 'list_organizations')), 'Forgejo API succeeds with the user grant')
  const second = authorization('auth')
  const secondStart = await browser.request(second.url)
  const secondBrowserStart = await browser.request(location(secondStart, issuer))
  const secondCallback = await keycloakLogin(browser, location(secondBrowserStart, issuer))
  const alreadyConnected = await browser.request(secondCallback)
  assert(new URL(location(alreadyConnected, issuer)).pathname.endsWith('/auth-upstream'), 'Connected users do not repeat Forgejo consent')
  console.log('PASS CIMD sign-in, direct Forgejo SSO, consent, existing sessions, PKCE exchange, and Forgejo API access')
} finally {
  if (mayHaveConnected) {
    await tool(preflightToken, 'disconnect_forgejo')
    console.log('PASS automation user grant cleaned up')
  }
}
