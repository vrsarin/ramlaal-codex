const upstreams = {
  forgejo: { http: 'http://forgejo-mcp:3000/mcp', tls: 'https://forgejo-mcp-tls:3000/mcp' },
  wikijs: { http: 'http://wikijs-sdlc-mcp:3000/mcp', tls: 'https://wikijs-mcp-tls:3000/mcp' },
  homeassistant: { http: 'http://homeassistant-mcp:3000/mcp', tls: 'https://homeassistant-mcp-tls:3000/mcp' }
}

export function mcpTlsEnabled(value) {
  if (value === undefined || value === '' || value === 'true') return true
  if (value === 'false') return false
  throw new Error('ENABLE_TLS must be true or false')
}

export function mcpUpstream(name, value) {
  if (!Object.hasOwn(upstreams, name)) throw new Error(`Unknown managed MCP backend: ${name}`)
  return upstreams[name][mcpTlsEnabled(value) ? 'tls' : 'http']
}
