#!/usr/bin/env node
import assert from 'node:assert/strict'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const tokenUrl = `https://${required('KEYCLOAK_HOSTNAME')}/realms/${required('KEYCLOAK_REALM')}/protocol/openid-connect/token`
const targets = [
  { audience: process.env.FORGEJO_MCP_SERVER_CLIENT_ID || 'forgejo-mcp-server', url: required('FORGEJO_MCP_PUBLIC_URL') },
  { audience: process.env.WIKIJS_SDLC_MCP_SERVER_CLIENT_ID || 'wikijs-sdlc-mcp-server', url: required('WIKIJS_SDLC_MCP_PUBLIC_URL') }
]

for (const [index, target] of targets.entries()) {
  const issued = await fetch(tokenUrl, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: 'mcp-gateway-discovery',
      client_secret: required('GATEWAY_DISCOVERY_CLIENT_SECRET'), scope: target.audience
    })
  })
  const token = await issued.json()
  assert(issued.ok && token.access_token, `Discovery token request failed: ${token.error ?? issued.status}`)
  async function call(url, method, params = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
    return response.status
  }
  assert.equal(await call(target.url, 'tools/list'), 200, 'Discovery must be able to list tools')
  assert.equal(await call(target.url, 'tools/call', { name: 'get_service_status', arguments: {} }), 403, 'Discovery must not call tools')
  assert([401, 403].includes(await call(targets[1 - index].url, 'tools/list')), 'Discovery token must be audience-bound')
  console.log(`PASS ${target.audience}: discovery allowed, tool calls and cross-audience access denied`)
}
