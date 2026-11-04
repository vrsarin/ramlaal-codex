import assert from 'node:assert/strict'
import test from 'node:test'
import { mcpTlsEnabled, mcpUpstream } from './mcp-upstreams.mjs'

test('managed MCP upstreams default to TLS and allow an explicit development opt-out', () => {
  assert.equal(mcpTlsEnabled(undefined), true)
  assert.equal(mcpTlsEnabled('false'), false)
  assert.equal(mcpTlsEnabled('true'), true)
  assert.throws(() => mcpTlsEnabled('enabled'), /true or false/)
  assert.equal(mcpUpstream('forgejo', 'true'), 'https://forgejo-mcp-tls:3000/mcp')
  assert.equal(mcpUpstream('wikijs', 'true'), 'https://wikijs-mcp-tls:3000/mcp')
  assert.equal(mcpUpstream('homeassistant', 'true'), 'https://homeassistant-mcp-tls:3000/mcp')
  assert.equal(mcpUpstream('forgejo'), 'https://forgejo-mcp-tls:3000/mcp')
  assert.throws(() => mcpUpstream('other', 'true'), /Unknown/)
})
