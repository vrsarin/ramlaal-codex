import assert from 'node:assert/strict'
import { managedOidcProvider } from './provider-selection.mjs'

class Browser {
  #cookies = new Map()
  async request(address, options = {}) {
    const url = new URL(address)
    const headers = new Headers(options.headers)
    const cookies = this.#cookies.get(url.hostname) ?? new Map()
    if (cookies.size) headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '))
    const result = await fetch(url, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) })
    for (const cookie of result.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]
      const index = pair.indexOf('=')
      if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
    this.#cookies.set(url.hostname, cookies)
    return result
  }
}

function location(result, origin) {
  const value = result.headers.get('location')
  if (!value) throw new Error(`Expected browser redirect (HTTP ${result.status})`)
  return new URL(value, origin)
}

export async function completeBrowserLogin({ authorizeUrl, keycloak, homeAssistant = 'https://home.localhost', username, password }) {
  const startUrl = new URL(authorizeUrl)
  assert.equal(startUrl.origin, 'http://localhost')
  assert.equal(startUrl.pathname, '/oauth/homeassistant/start')
  const browser = new Browser()
  const start = await browser.request(startUrl)
  const authorization = location(start, 'http://localhost')
  assert.equal(authorization.origin, new URL(homeAssistant).origin)
  assert.equal(authorization.pathname, '/auth/authorize')
  const callback = new URL(authorization.searchParams.get('redirect_uri'))
  assert.equal(callback.origin, 'http://localhost')
  assert.equal(callback.pathname, '/oauth/homeassistant/callback')
  const welcome = new URL('/auth/oidc/welcome', homeAssistant)
  welcome.searchParams.set('redirect_uri', Buffer.from(authorization.toString()).toString('base64'))
  assert.equal((await browser.request(welcome)).status, 200, 'Home Assistant OIDC welcome')
  const redirectPage = await browser.request(new URL('/auth/oidc/redirect', homeAssistant))
  assert.equal(redirectPage.status, 200, 'Home Assistant OIDC redirect')
  const encoded = (await redirectPage.text()).match(/decodeURIComponent\("([^"]+)"\)/)?.[1]
  assert(encoded, 'Home Assistant OIDC authorization URL')
  const keycloakUrl = new URL(decodeURIComponent(encoded))
  assert.equal(keycloakUrl.origin, new URL(keycloak).origin)
  const loginPage = await browser.request(keycloakUrl)
  const action = (await loginPage.text()).match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&')
  assert(action, 'Keycloak login form')
  assert.equal(new URL(action).origin, keycloakUrl.origin, 'Keycloak login form must remain on the configured host')
  const login = await browser.request(action, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, credentialId: '' })
  })
  const oidcCallback = location(login, keycloak)
  assert.equal(oidcCallback.origin, new URL(homeAssistant).origin)
  assert.equal(oidcCallback.pathname, '/auth/oidc/callback')
  const oidc = await browser.request(oidcCallback)
  assert.equal(oidc.status, 302, 'Home Assistant identity must pass its group policy')
  assert.equal(location(oidc, homeAssistant).pathname, '/auth/oidc/finish')

  const providersResponse = await browser.request(new URL('/auth/providers', homeAssistant))
  if (!providersResponse.ok) throw new Error(`Home Assistant providers request failed (HTTP ${providersResponse.status})`)
  const provider = managedOidcProvider(await providersResponse.json())
  const flow = await browser.request(new URL('/auth/login_flow', homeAssistant), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: authorization.searchParams.get('client_id'),
      redirect_uri: callback.toString(), handler: [provider.type, provider.id],
      code_challenge: authorization.searchParams.get('code_challenge'), code_challenge_method: 'S256'
    })
  })
  if (!flow.ok) throw new Error(`Home Assistant login failed (HTTP ${flow.status})`)
  const result = await flow.json()
  if (result.type !== 'create_entry' || typeof result.result !== 'string') throw new Error(`Home Assistant login did not complete (${result.type})`)
  callback.searchParams.set('state', authorization.searchParams.get('state'))
  callback.searchParams.set('code', result.result)
  return browser.request(callback)
}
