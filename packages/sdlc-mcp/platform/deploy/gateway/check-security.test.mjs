import assert from 'node:assert/strict'
import test from 'node:test'
import { auditEnabledServers } from './check-security.mjs'

const response = (value, status = 200) => new Response(JSON.stringify(value), { status })
function mock(scan) {
  return async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/api/servers') {
      return response({ servers: parsed.searchParams.get('status') === 'active'
        ? [{ path: '/safe', is_enabled: true }, { path: '/disabled', is_enabled: false }] : [], has_next: false })
    }
    if (parsed.pathname === '/api/servers/safe/security-scan') return response(scan)
    throw new Error(`Unexpected request ${parsed.pathname}`)
  }
}

test('all enabled servers require a successful recorded scan', async () => {
  assert.equal(await auditEnabledServers('http://gateway', 'token', mock({ is_safe: true, scan_failed: false })), 1)
  for (const scan of [{ is_safe: false, scan_failed: false }, { is_safe: true, scan_failed: true }, {}]) {
    await assert.rejects(() => auditEnabledServers('http://gateway', 'token', mock(scan)), /has not passed/)
  }
})
