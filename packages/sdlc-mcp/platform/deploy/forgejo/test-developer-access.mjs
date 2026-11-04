#!/usr/bin/env node
// Verify that a seeded developers-group member becomes a Forgejo administrator through OIDC.
import assert from 'node:assert/strict'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const forgejo = `https://${required('FORGEJO_HOSTNAME')}`
const keycloakHost = required('KEYCLOAK_HOSTNAME')
const username = required('KEYCLOAK_TEST_USERNAME')
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
  assert(value, `Expected redirect from ${origin}, got HTTP ${response.status}`)
  return new URL(value, origin).toString()
}

const browser = new Browser()
const provider = await browser.request(`${forgejo}/user/oauth2/Keycloak`)
assert([302, 303, 307].includes(provider.status), 'Forgejo Keycloak login redirect')
const loginUrl = location(provider, forgejo)
assert.equal(new URL(loginUrl).hostname, keycloakHost, 'Forgejo must use the configured Keycloak origin')
const page = await browser.request(loginUrl)
assert.equal(page.status, 200, 'Keycloak login page')
const action = (await page.text()).match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&')
assert(action, 'Keycloak login form')
const login = await browser.request(action, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username, password, credentialId: '' })
})
assert([302, 303, 307].includes(login.status), 'Keycloak developer login')
const callbackUrl = location(login, loginUrl)
assert.equal(new URL(callbackUrl).origin, forgejo)
assert.equal(new URL(callbackUrl).pathname, '/user/oauth2/Keycloak/callback')
const callback = await browser.request(callbackUrl)
assert([302, 303, 307].includes(callback.status), 'Forgejo OIDC callback')
const destination = location(callback, forgejo)
assert.equal(new URL(destination).origin, forgejo, 'Forgejo login must stay on the local origin')
await browser.request(destination)
const administration = await browser.request(`${forgejo}/admin`)
assert.equal(administration.status, 200, 'Developers group member must reach Forgejo site administration')
console.log('PASS developers-group OIDC login reaches Forgejo site administration')
