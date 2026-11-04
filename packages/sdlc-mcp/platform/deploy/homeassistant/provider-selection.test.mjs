import { test } from 'node:test'
import assert from 'node:assert/strict'
import { managedOidcProvider } from './provider-selection.mjs'

test('selects the managed provider from the Home Assistant response envelope', () => {
  const provider = { name: 'OpenID Connect (SSO)', id: 'default', type: 'auth_oidc' }
  assert.equal(managedOidcProvider({ providers: [provider, { id: null, type: 'homeassistant' }] }), provider)
})

test('rejects invalid, missing, or ambiguous provider lists', () => {
  assert.throws(() => managedOidcProvider([]), /invalid provider list/)
  assert.throws(() => managedOidcProvider({ providers: [] }), /exactly one/)
  assert.throws(() => managedOidcProvider({ providers: [
    { type: 'auth_oidc', id: 'default' }, { type: 'auth_oidc', id: 'default' }
  ] }), /exactly one/)
})
