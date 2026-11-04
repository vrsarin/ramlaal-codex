#!/usr/bin/env node
import { completeBrowserLogin } from './browser-login.mjs'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const keycloak = `https://${required('KEYCLOAK_HOSTNAME')}/realms/${required('KEYCLOAK_REALM')}/protocol/openid-connect`
const homeAssistant = `https://${required('HOMEASSISTANT_HOSTNAME')}`
const audience = process.env.HOMEASSISTANT_MCP_SERVER_CLIENT_ID || 'homeassistant-mcp-server'
const response = await fetch(`${keycloak}/token`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials', client_id: 'mcp-gateway-discovery',
    client_secret: required('GATEWAY_DISCOVERY_CLIENT_SECRET'), scope: audience
  }),
  signal: AbortSignal.timeout(10_000)
})
if (!response.ok) throw new Error(`Keycloak discovery token request failed (HTTP ${response.status})`)
const token = (await response.json()).access_token
if (!token) throw new Error('Keycloak did not issue a discovery token')
const initiation = await fetch('http://localhost/internal/homeassistant/discovery/connect', {
  method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000)
})
if (!initiation.ok) throw new Error(`Home Assistant discovery connection failed (HTTP ${initiation.status})`)
const connection = await initiation.json()
if (connection.connected === true) {
  console.log('Home Assistant discovery identity is already connected.')
  process.exit(0)
}
if (typeof connection.authorizeUrl !== 'string') throw new Error('Home Assistant discovery connection did not return an authorization URL')

const completed = await completeBrowserLogin({
  authorizeUrl: connection.authorizeUrl, keycloak, homeAssistant, username: 'home-assistant-discovery',
  password: required('GATEWAY_HOME_DISCOVERY_PASSWORD')
})
if (completed.status !== 200) throw new Error(`Home Assistant discovery grant could not be connected (HTTP ${completed.status})`)
console.log('PASS dedicated Home Assistant discovery grant is connected to its Keycloak identity')
