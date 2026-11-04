import assert from 'node:assert/strict'
import test from 'node:test'
import { unavailableUnscannedBuiltin } from './builtin-scan-policy.mjs'

test('only the known unavailable built-in without a safe scan is disabled', () => {
  const builtin = { path: '/airegistry-tools/', proxy_pass_url: 'http://mcpgw-server:8003/', health_status: 'unhealthy', is_enabled: true }
  assert.equal(unavailableUnscannedBuiltin(builtin), true)
  assert.equal(unavailableUnscannedBuiltin(builtin, { scan_failed: false, is_safe: true }), false)
  assert.equal(unavailableUnscannedBuiltin({ ...builtin, health_status: 'healthy' }), false)
  assert.equal(unavailableUnscannedBuiltin({ ...builtin, is_enabled: false }), false)
  assert.equal(unavailableUnscannedBuiltin({ ...builtin, path: '/other' }), false)
  assert.equal(unavailableUnscannedBuiltin({ ...builtin, proxy_pass_url: 'http://other:8003/' }), false)
})
