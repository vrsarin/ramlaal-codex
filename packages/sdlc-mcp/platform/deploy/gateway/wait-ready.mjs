#!/usr/bin/env node
import { gatewayBase } from './gateway-url.mjs'

const base = gatewayBase()
const mode = process.argv[2] || 'gateway'
if (mode !== 'gateway' && mode !== 'virtual') throw new Error('Expected readiness mode: gateway or virtual')
const resource = mode === 'virtual' ? `${base}/virtual/sdlc/mcp` : base
const metadataPath = mode === 'virtual'
  ? '/.well-known/oauth-protected-resource/virtual/sdlc/mcp'
  : '/.well-known/oauth-protected-resource'
const expectedIssuer = `https://${process.env.KEYCLOAK_HOSTNAME}/realms/${process.env.KEYCLOAK_REALM}`
const deadline = Date.now() + 180_000
let lastError = 'Gateway has not responded'
while (Date.now() < deadline) {
  try {
    const [health, metadata] = await Promise.all([
      fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) }),
      fetch(`${base}${metadataPath}`, { signal: AbortSignal.timeout(3000) })
    ])
    if (!health.ok || !metadata.ok) throw new Error(`Gateway readiness HTTP status: ${health.status}, ${metadata.status}`)
    const state = await health.json()
    const discovery = await metadata.json()
    if (state.status !== 'healthy' || discovery.resource !== resource || !discovery.authorization_servers?.includes(expectedIssuer)) {
      throw new Error('Gateway health or protected-resource metadata is incorrect')
    }
    if (mode === 'virtual') {
      const route = await fetch(resource, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'gateway-readiness', version: '1' } }
        }),
        signal: AbortSignal.timeout(3000)
      })
      if (route.status !== 401 || !route.headers.get('www-authenticate')?.includes(`${base}${metadataPath}`)) {
        throw new Error(`Virtual MCP route is not ready or not protected (HTTP ${route.status})`)
      }
    }
    console.log(`${mode === 'gateway' ? 'Gateway' : 'Virtual server'} health and OAuth metadata are ready.`)
    process.exit(0)
  } catch (error) {
    lastError = error instanceof Error ? error.message : 'Gateway readiness failed'
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
throw new Error(`Gateway did not become ready: ${lastError}`)
