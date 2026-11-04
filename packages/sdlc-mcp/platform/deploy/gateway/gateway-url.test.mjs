import assert from 'node:assert/strict'
import test from 'node:test'
import { gatewayBase } from './gateway-url.mjs'

test('gateway URL defaults to HTTPS and requires a local hostname', () => {
  assert.equal(gatewayBase({}), 'https://mcp-gateway.localhost')
  assert.equal(gatewayBase({ SDLC_HTTPS: 'false' }), 'http://mcp-gateway.localhost')
  assert.equal(gatewayBase({ GATEWAY_HOSTNAME: '127.0.0.1:12345' }), 'https://127.0.0.1:12345')
  assert.throws(() => gatewayBase({ SDLC_HTTPS: 'invalid' }), /true or false/)
  assert.throws(() => gatewayBase({ GATEWAY_HOSTNAME: 'example.com' }), /localhost/)
  assert.throws(() => gatewayBase({ GATEWAY_HOSTNAME: 'localhost/path' }), /localhost/)
})
