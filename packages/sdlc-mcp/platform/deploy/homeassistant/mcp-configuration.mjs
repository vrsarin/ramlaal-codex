export function mcpConfigurationStatus(entries) {
  if (!Array.isArray(entries)) throw new Error('Home Assistant returned invalid MCP integration configuration')
  if (entries.length === 0) return 'Add the Home Assistant MCP Server integration.'
  if (entries.length !== 1) return 'Exactly one Home Assistant MCP Server integration is required.'
  const data = entries[0]
  if (!data || typeof data !== 'object') throw new Error('Home Assistant returned invalid MCP integration settings')
  if (data.require_admin !== false) return 'Set the MCP Server integration to allow non-admin users.'
  if (data.all_llm_apis !== false || !Array.isArray(data.llm_hass_api) || !data.llm_hass_api.includes('assist')) {
    return 'Select Assist explicitly and disable access to all LLM APIs.'
  }
  return undefined
}
