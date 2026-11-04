#!/usr/bin/env node
// Run with .env loaded. Uses the dedicated automation user and preserves any pre-existing grant.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const issuer = `https://${required('KEYCLOAK_HOSTNAME')}/realms/${required('KEYCLOAK_REALM')}`
const resource = required('WIKIJS_SDLC_MCP_PUBLIC_URL')
const wiki = `https://${required('WIKIJS_HOSTNAME')}`
const forgejoResource = required('FORGEJO_MCP_PUBLIC_URL')
const forgejo = `https://${required('FORGEJO_HOSTNAME')}`
const clientId = 'https://vscode.dev/oauth/client-metadata.json'
const redirectUri = 'http://127.0.0.1:33418/'
const probeOnly = process.argv.includes('--probe-only')
const username = probeOnly ? required('KEYCLOAK_TEST_USERNAME') : (process.env.KEYCLOAK_AUTOMATION_USERNAME || 'mcp-tester')
const password = required('KEYCLOAK_TEST_PASSWORD')

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

function authorization(path, targetResource = resource) {
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(24).toString('base64url')
  const query = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid',
    resource: targetResource, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256'
  })
  return { url: `${issuer}/protocol/openid-connect/${path}?${query}`, verifier, state, resource: targetResource }
}

let credentialPrompts = 0
async function keycloakLogin(browser, url) {
  const page = await browser.request(url)
  if ([302, 303].includes(page.status)) return location(page, url)
  const html = await page.text()
  const action = html.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&')
  assert(action, 'Keycloak login form')
  credentialPrompts++
  const login = await browser.request(action, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, credentialId: '' })
  })
  let next = location(login, issuer)
  if (new URL(next).pathname.endsWith('/login-actions/required-action')) {
    const consent = await browser.request(next)
    const body = await consent.text()
    const form = body.match(/<form[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&')
    const code = body.match(/name="code" value="([^"]*)"/)?.[1]
    assert(form && code && body.includes('name="accept"'), 'Keycloak client consent')
    const accepted = await browser.request(new URL(form, issuer), {
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
  assert(code, 'Keycloak authorization code')
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, grant_type: 'authorization_code', code, code_verifier: auth.verifier, resource: auth.resource })
  })
  assert.equal(response.status, 200, 'CIMD token exchange')
  const result = await response.json()
  assert(result.access_token, 'Keycloak access token')
  return result.access_token
}

async function tool(token, name, targetResource = resource) {
  const response = await fetch(targetResource, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })
  })
  assert.equal(response.status, 200, `${name} HTTP status`)
  const raw = await response.text()
  const result = JSON.parse(raw.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? raw)
  if (result.error || result.result?.isError) throw new Error(`${name} failed: ${result.error?.message ?? result.result?.content?.[0]?.text}`)
  return JSON.parse(result.result.content[0].text)
}

const preflight = authorization('auth-upstream')
const preflightToken = await exchange(await keycloakLogin(new Browser(), preflight.url), preflight)
const prior = await tool(preflightToken, 'get_service_status')
if (probeOnly && prior.wikiJsConnection === 'connected') {
  console.log('Developer already has a Wiki.js grant.')
  process.exit(0)
}
if (prior.wikiJsConnection !== 'not-connected') throw new Error('Automation user already has a Wiki.js grant; refusing to modify it.')
let forgejoPreflightToken
if (!probeOnly) {
  const forgejoPreflight = authorization('auth-upstream', forgejoResource)
  forgejoPreflightToken = await exchange(await keycloakLogin(new Browser(), forgejoPreflight.url), forgejoPreflight)
  if ((await tool(forgejoPreflightToken, 'get_forgejo_connection', forgejoResource)).forgejoConnection !== 'not-connected') {
    throw new Error('Automation user already has a Forgejo grant; refusing to modify it.')
  }
}

class ProbeComplete extends Error {}
let mayHaveConnected = false
let forgejoMayHaveConnected = false
try {
  const browser = new Browser()
  credentialPrompts = 0
  if (!probeOnly) {
    const first = authorization('auth', forgejoResource)
    const interceptedForgejo = await browser.request(first.url)
    const forgejoBrowserStart = await browser.request(location(interceptedForgejo, issuer))
    const keycloakCallback = await keycloakLogin(browser, location(forgejoBrowserStart, issuer))
    const connectedForgejo = await browser.request(keycloakCallback)
    const forgejoStart = await browser.request(location(connectedForgejo, issuer))
    const forgejoAuthorize = location(forgejoStart, forgejo)
    const needLogin = await browser.request(forgejoAuthorize)
    const forgejoLogin = await browser.request(location(needLogin, forgejo))
    assert.equal(new URL(location(forgejoLogin, forgejo)).pathname, '/user/oauth2/Keycloak')
    const provider = await browser.request(location(forgejoLogin, forgejo))
    const providerCallback = await keycloakLogin(browser, location(provider, issuer))
    const signedIn = await browser.request(providerCallback)
    const consent = await browser.request(location(signedIn, forgejo))
    let providerRedirect
    if ([302, 303].includes(consent.status)) {
      providerRedirect = location(consent, forgejo)
    } else {
      assert.equal(consent.status, 200, 'Forgejo consent page')
      const html = await consent.text()
      const form = new URLSearchParams({ granted: 'true' })
      for (const name of ['_csrf', 'client_id', 'state', 'scope', 'nonce', 'redirect_uri']) {
        form.set(name, html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1] ?? '')
      }
      assert(form.get('client_id'), 'Forgejo consent form')
      const approved = await browser.request(`${forgejo}/login/oauth/grant`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form
      })
      providerRedirect = location(approved, forgejo)
    }
    forgejoMayHaveConnected = true
    const completed = await browser.request(providerRedirect)
    const forgejoToken = await exchange(await keycloakLogin(browser, location(completed, issuer)), first)
    assert.equal((await tool(forgejoToken, 'get_forgejo_connection', forgejoResource)).forgejoConnection, 'connected')
    assert(Array.isArray(await tool(forgejoToken, 'list_organizations', forgejoResource)), 'Forgejo MCP access')
  }
  const auth = authorization('auth')
  const intercepted = await browser.request(auth.url)
  assert.equal(intercepted.status, 302, 'Wiki.js resource authorization is intercepted')
  const start = await browser.request(location(intercepted, issuer))
  const keycloakUrl = location(start, issuer)
  assert(new URL(keycloakUrl).pathname.endsWith('/auth-upstream'), 'Initial Keycloak identity check')
  const loginCallback = await keycloakLogin(browser, keycloakUrl)
  const linked = await browser.request(loginCallback)
  const wikiStartUrl = location(linked, issuer)
  assert.equal(new URL(wikiStartUrl).pathname, '/oauth/wikijs/start')
  const wikiStart = await browser.request(wikiStartUrl)
  const authorizeUrl = location(wikiStart, wiki)
  assert.equal(new URL(authorizeUrl).pathname, '/_oauth/authorize')
  const authorizationPage = await browser.request(authorizeUrl)
  const consentUrl = new URL(location(authorizationPage, wiki))
  assert.equal(consentUrl.pathname, '/_authorize')
  const direct = await browser.request(consentUrl)
  assert.equal(direct.status, 302, 'MCP consent navigation starts Wiki.js SSO')
  const providerUrl = location(direct, wiki)
  assert.match(new URL(providerUrl).pathname, /^\/_api\/auth\/[0-9a-f-]+\/authorize$/)
  const provider = await browser.request(providerUrl)
  const wikiKeycloakCallback = await keycloakLogin(browser, location(provider, issuer))
  assert.equal(new URL(wikiKeycloakCallback).origin, wiki, 'Wiki.js OIDC callback uses the public HTTPS origin')
  assert.match(new URL(wikiKeycloakCallback).pathname, /^\/_api\/auth\/[0-9a-f-]+\/callback$/)
  const signedIn = await browser.request(wikiKeycloakCallback)
  const consentReturn = new URL(location(signedIn, wiki))
  assert.equal(consentReturn.pathname, '/_authorize')
  assert.equal(consentReturn.searchParams.get('mcp_sso'), '1')
  const existingSession = await browser.request(consentUrl)
  const existingDestination = new URL(location(existingSession, wiki))
  assert.equal(existingDestination.pathname, '/_authorize', 'An existing Wiki.js session is preserved')
  assert.equal(existingDestination.searchParams.get('mcp_sso'), '1')
  assert.equal((await browser.request(consentReturn)).status, 200, 'Wiki.js consent page is served')
  const infoUrl = new URL('/_api/oauth/authorize', wiki)
  infoUrl.search = consentReturn.search
  const info = await browser.request(infoUrl)
  assert.equal(info.status, 200, 'Wiki.js account can view consent')
  const consentInfo = await info.json()
  if (probeOnly) {
    console.log(`Developer Wiki.js permission use:mcp: ${consentInfo.mayUse ? 'allowed' : 'missing'}`)
    throw new ProbeComplete()
  }
  assert.equal(consentInfo.mayUse, true, 'Keycloak MCP group grants the automation user Wiki.js use:mcp')
  const request = Object.fromEntries(consentReturn.searchParams)
  const approved = await browser.request(infoUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request, approve: true, scopes: ['mcp:read', 'pages:read'], expiration: '7d' })
  })
  assert.equal(approved.status, 200, 'Wiki.js consent')
  const approval = await approved.json()
  assert(approval.redirect, 'Wiki.js consent callback')
  mayHaveConnected = true
  const callback = await browser.request(approval.redirect)
  const resume = location(callback, issuer)
  assert(new URL(resume).pathname.endsWith('/auth-upstream'), 'Resume the original Keycloak authorization')
  const token = await exchange(await keycloakLogin(browser, resume), auth)
  assert.equal((await tool(token, 'get_service_status')).wikiJsConnection, 'connected')
  assert(Array.isArray((await tool(token, 'discover_wikijs_capabilities')).tools), 'Wiki.js MCP discovery')
  const ordinary = await browser.request(`${wiki}/login`)
  assert.equal(ordinary.status, 200, 'Ordinary Wiki.js login is unchanged')
  const otherConsent = new URL('/_authorize', wiki)
  otherConsent.search = new URLSearchParams({ client_id: 'other', redirect_uri: 'http://localhost/oauth/other/callback' }).toString()
  assert.equal((await browser.request(otherConsent)).status, 200, 'Other applications retain the normal consent page')
  const second = authorization('auth')
  const secondStart = await browser.request(second.url)
  const secondBrowserStart = await browser.request(location(secondStart, issuer))
  const secondCallback = await keycloakLogin(browser, location(secondBrowserStart, issuer))
  const alreadyConnected = await browser.request(secondCallback)
  assert(new URL(location(alreadyConnected, issuer)).pathname.endsWith('/auth-upstream'), 'Connected users do not repeat consent')
  assert.equal(credentialPrompts, 1, 'Both services and both consent flows use one Keycloak credential login')
  console.log('PASS both MCP services, one Keycloak credential login, separate provider consent and MCP access')
  if (process.argv.includes('--verify-gateway')) {
    execFileSync(process.execPath, ['deploy/gateway/test-gateway.mjs'], {
      stdio: 'inherit', env: { ...process.env, GATEWAY_REQUIRE_CONNECTED: 'true' }
    })
  }
} catch (error) {
  if (!(error instanceof ProbeComplete)) throw error
} finally {
  if (mayHaveConnected) {
    await tool(preflightToken, 'disconnect_wikijs')
    console.log('PASS automation user grant cleaned up')
  }
  if (forgejoMayHaveConnected) {
    await tool(forgejoPreflightToken, 'disconnect_forgejo', forgejoResource)
    console.log('PASS automation Forgejo grant cleaned up')
  }
}
