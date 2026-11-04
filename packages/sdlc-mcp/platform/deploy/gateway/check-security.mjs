#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { gatewayBase } from './gateway-url.mjs'

export async function auditEnabledServers(base, token, fetcher = fetch) {
  const headers = { authorization: `Bearer ${token}` }
  const seen = new Map()
  for (const status of ['active', 'beta', 'draft', 'deprecated']) {
    let offset = 0
    for (;;) {
      const response = await fetcher(`${base}/api/servers?limit=2000&offset=${offset}&include_tools=false&status=${status}`, { headers, signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`Gateway server inventory failed (HTTP ${response.status})`)
      const page = await response.json()
      if (!Array.isArray(page.servers) || typeof page.has_next !== 'boolean') throw new Error('Invalid gateway inventory response')
      for (const server of page.servers) {
        if (typeof server.path !== 'string' || typeof server.is_enabled !== 'boolean') throw new Error('Invalid gateway server inventory entry')
        seen.set(server.path.replace(/\/+$/, ''), server)
      }
      if (!page.has_next) break
      if (!page.servers.length) throw new Error('Gateway inventory returned an empty page with more results')
      offset += page.servers.length
    }
  }
  const enabled = [...seen.entries()].filter(([, server]) => server.is_enabled)
  if (!enabled.length) throw new Error('No enabled MCP servers were found')
  for (const [path] of enabled) {
    const encoded = path.slice(1).split('/').map(encodeURIComponent).join('/')
    const response = await fetcher(`${base}/api/servers/${encoded}/security-scan`, { headers, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`${path} has no accessible security scan (HTTP ${response.status})`)
    const scan = await response.json()
    if (scan.scan_failed !== false || scan.is_safe !== true) throw new Error(`${path} has not passed its security scan`)
  }
  return enabled.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.GATEWAY_BOOTSTRAP_TOKEN) throw new Error('GATEWAY_BOOTSTRAP_TOKEN is required')
  const base = gatewayBase()
  const count = await auditEnabledServers(base, process.env.GATEWAY_BOOTSTRAP_TOKEN)
  console.log(`PASS all ${count} enabled MCP servers have successful security scans`)
}
