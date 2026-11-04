import { parseEnv } from 'node:util'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { requiredSecretNames } from './runtime-secrets.mjs'

const secretNames = new Set([...requiredSecretNames, 'FORGEJO_OAUTH_CLIENT_SECRET'])

export function assertNoLegacyGatewayFile(directory) {
  try { lstatSync(join(directory, 'gateway.env')) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error('Legacy gateway.env exists; preserve any needed data and use the confirmed legacy teardown before a fresh wizard setup')
}

export function nonSensitiveTemplate(text) {
  const lines = text.split('\n').filter((line) => {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)
    return !match || !secretNames.has(match[1])
  })
  return lines.join('\n')
}

export function validateConfiguration(text) {
  const values = parseEnv(text)
  for (const name of secretNames) {
    if (values[name]) throw new Error(`${name} must not be stored in .env; move it out before using the wizard`)
  }
  const project = values.COMPOSE_PROJECT_NAME || 'forgejo-wikijs-sdlc'
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new Error('Invalid COMPOSE_PROJECT_NAME')
  if ((values.BIND_ADDRESS || '127.0.0.1') !== '127.0.0.1') throw new Error('The local setup requires BIND_ADDRESS=127.0.0.1')
  for (const name of ['KEYCLOAK_HOSTNAME', 'GATEWAY_HOSTNAME', 'FORGEJO_HOSTNAME', 'WIKIJS_HOSTNAME',
    'HOMEASSISTANT_HOSTNAME', 'FORGEJO_MCP_HOSTNAME', 'WIKIJS_SDLC_MCP_HOSTNAME']) {
    const value = values[name]
    if (value && !/^(?:[A-Za-z0-9-]+\.)*localhost$/.test(value)) throw new Error(`${name} must use a localhost hostname`)
  }
  for (const name of ['ENABLE_OIDC', 'ENABLE_TLS', 'SDLC_HTTPS', 'SDLC_MCP_TLS']) {
    if (values[name] !== undefined && !['true', 'false'].includes(values[name])) throw new Error(`${name} must be true or false`)
  }
  if (values.ENABLE_TLS !== undefined && values.SDLC_MCP_TLS !== undefined && values.ENABLE_TLS !== values.SDLC_MCP_TLS) {
    throw new Error('ENABLE_TLS conflicts with legacy SDLC_MCP_TLS')
  }
  const tlsEnabled = values.ENABLE_TLS ?? values.SDLC_MCP_TLS ?? 'true'
  if (values.SDLC_HTTPS !== 'false' && tlsEnabled === 'false') {
    throw new Error('SDLC_HTTPS requires ENABLE_TLS')
  }
  return values
}
