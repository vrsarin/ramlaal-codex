import assert from 'node:assert/strict'
import test from 'node:test'
import { completeBrowserLogin } from './browser-login.mjs'

test('browser automation rejects untrusted initiation URLs before sending credentials', async () => {
  for (const authorizeUrl of ['https://other.example/oauth/homeassistant/start', 'http://localhost/unexpected']) {
    await assert.rejects(completeBrowserLogin({
      authorizeUrl, keycloak: 'http://auth.localhost', username: 'test', password: 'test'
    }))
  }
})
