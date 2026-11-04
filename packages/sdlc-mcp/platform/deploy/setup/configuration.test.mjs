import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertNoLegacyGatewayFile, nonSensitiveTemplate, validateConfiguration } from './configuration.mjs'

test('new configuration excludes sensitive placeholder values', () => {
  const template = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')
  const sanitized = nonSensitiveTemplate(template)
  const values = validateConfiguration(sanitized)
  assert.equal(values.COMPOSE_PROJECT_NAME, 'forgejo-wikijs-sdlc')
  assert.equal(values.SDLC_HTTPS, 'true')
  assert.equal(values.ENABLE_OIDC, 'true')
  assert.equal(values.ENABLE_TLS, 'true')
  assert.equal(values.KEYCLOAK_TEST_PASSWORD, undefined)
  assert.equal(values.FORGEJO_TOKEN_ENCRYPTION_KEY, undefined)
  assert(!sanitized.includes('change-this-keycloak-admin-password'))
})

test('existing secrets and non-local gateway settings fail explicitly', () => {
  assert.throws(() => validateConfiguration('KEYCLOAK_TEST_PASSWORD=legacy\n'), /must not be stored/)
  assert.throws(() => validateConfiguration('BIND_ADDRESS=0.0.0.0\n'), /127.0.0.1/)
  assert.throws(() => validateConfiguration('GATEWAY_HOSTNAME=example.com\n'), /localhost/)
  assert.throws(() => validateConfiguration('SDLC_HTTPS=true\nENABLE_TLS=false\n'), /requires/)
  assert.throws(() => validateConfiguration('ENABLE_TLS=true\nSDLC_MCP_TLS=false\n'), /conflicts/)
})

test('wizard refuses a leftover legacy gateway credential file', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-config-test-'))
  const path = join(directory, 'gateway.env')
  t.after(() => { unlinkSync(path); rmdirSync(directory) })
  assert.doesNotThrow(() => assertNoLegacyGatewayFile(directory))
  writeFileSync(path, 'fixture')
  assert.throws(() => assertNoLegacyGatewayFile(directory), /Legacy gateway.env exists/)
})
