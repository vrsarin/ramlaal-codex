import assert from 'node:assert/strict'
import test from 'node:test'
import { mcpConfigurationStatus } from './mcp-configuration.mjs'

test('requires a single non-admin MCP integration with explicitly selected Assist', () => {
  const configured = { require_admin: false, all_llm_apis: false, llm_hass_api: ['assist'] }
  assert.equal(mcpConfigurationStatus([configured]), undefined)
  assert.match(mcpConfigurationStatus([]), /Add/)
  assert.match(mcpConfigurationStatus([configured, configured]), /Exactly one/)
  assert.match(mcpConfigurationStatus([{ ...configured, require_admin: true }]), /non-admin/)
  assert.match(mcpConfigurationStatus([{ ...configured, all_llm_apis: true }]), /Assist/)
  assert.match(mcpConfigurationStatus([{ ...configured, llm_hass_api: [] }]), /Assist/)
  assert.throws(() => mcpConfigurationStatus({}), /invalid/)
})
