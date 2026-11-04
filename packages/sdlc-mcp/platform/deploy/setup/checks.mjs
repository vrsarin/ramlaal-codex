#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gatewayBase } from '../gateway/gateway-url.mjs'
import { mcpTlsEnabled } from '../gateway/mcp-upstreams.mjs'
import { validateConfiguration } from './configuration.mjs'
import { ensureLocalCa, localCaFileName } from './local-ca.mjs'
import { assertNoRuntimeReplacementFiles, createRuntimeFile, installRuntimeSignalCleanup, removeRuntimeFile, runtimeSecretsFromContainer } from './runtime-secrets.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
assertNoRuntimeReplacementFiles(root)
const config = validateConfiguration(readFileSync(new URL('../../.env', import.meta.url), 'utf8'))
const project = config.COMPOSE_PROJECT_NAME || 'forgejo-wikijs-sdlc'
const mode = process.argv[2] || 'gateway'
if (!['gateway', 'home-sso', 'home-discovery', 'step-ca', 'forgejo-login', 'wikijs-login'].includes(mode)) throw new Error(`Unknown check: ${mode}`)
const extra = process.argv.slice(3)
if (extra.length && !(mode === 'wikijs-login' && extra.length === 1 && extra[0] === '--probe-only')) throw new Error('Unsupported check arguments')
const baseEnv = { ...process.env }
delete baseEnv.COMPOSE_PROJECT_NAME
const ids = execFileSync('docker', [
  'ps', '-a', '--filter', `label=com.docker.compose.project=${project}`,
  '--filter', 'label=com.docker.compose.service=sdlc-runtime-keeper', '--format', '{{.ID}}'
], { cwd: root, env: baseEnv, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
if (ids.length !== 1) throw new Error('Exactly one running runtime secret keeper is required')
const container = JSON.parse(execFileSync('docker', ['inspect', ids[0]], { cwd: root, env: baseEnv, encoding: 'utf8' }))[0]
const secrets = runtimeSecretsFromContainer(container, project)
const useMcpTls = mcpTlsEnabled(config.ENABLE_TLS ?? config.SDLC_MCP_TLS ?? baseEnv.ENABLE_TLS ?? baseEnv.SDLC_MCP_TLS)
const useGatewayHttps = gatewayBase({ ...baseEnv, ...config }).startsWith('https://')
if (useGatewayHttps && !useMcpTls) throw new Error('SDLC_HTTPS requires ENABLE_TLS')
const localCa = useGatewayHttps
  ? ensureLocalCa(root, readFileSync(new URL(`../../${localCaFileName}`, import.meta.url), 'utf8'))
  : undefined
const env = { ...baseEnv, ...config, ...secrets, SDLC_RUNTIME_ENV_FILE: '.sdlc-runtime',
  ...(localCa ? { NODE_EXTRA_CA_CERTS: localCa.path } : {}) }
const handle = createRuntimeFile(root, secrets)
const removeSignalHandlers = installRuntimeSignalCleanup(handle)
let failure
try {
  const compose = [
    'compose', '--env-file', '.env', '--env-file', '.sdlc-runtime',
    '-f', 'compose.yaml', '-f', 'compose.gateway.yaml', '-f', 'compose.homeassistant.yaml', '-f', 'compose.runtime.yaml',
    ...(useMcpTls ? ['-f', 'compose.mcp-tls.yaml'] : []),
    ...(useGatewayHttps ? ['-f', 'compose.gateway-https.yaml'] : []),
    '--profile', 'mcp', '--profile', 'gateway', '--profile', 'homeassistant', '--profile', 'runtime',
    ...(useMcpTls ? ['--profile', 'mcp-tls'] : [])
  ]
  if (mode === 'step-ca') {
    execFileSync('docker', [...compose, 'exec', '-T', 'step-ca', '/bin/sh', '/scripts/test-ca.sh'], { cwd: root, env, stdio: 'inherit' })
  } else if (mode === 'home-sso' || mode === 'home-discovery') {
    execFileSync(process.execPath, ['deploy/homeassistant/test-sso.mjs', ...(mode === 'home-discovery' ? ['--discovery'] : [])], { cwd: root, env, stdio: 'inherit' })
  } else if (mode === 'forgejo-login' || mode === 'wikijs-login') {
    const provider = mode === 'forgejo-login' ? 'forgejo' : 'wikijs'
    execFileSync(process.execPath, [`deploy/${provider}/test-initial-login.mjs`, ...extra], { cwd: root, env, stdio: 'inherit' })
  } else {
    execFileSync('docker', [...compose, 'exec', '-T', 'homeassistant-mcp', 'node', 'src/test-upstream-tls.mjs'], { cwd: root, env, stdio: 'inherit' })
    execFileSync(process.execPath, ['deploy/keycloak/test-mcp-access.mjs'], { cwd: root, env, stdio: 'inherit' })
    execFileSync(process.execPath, ['deploy/forgejo/test-developer-access.mjs'], { cwd: root, env, stdio: 'inherit' })
    for (const script of ['check-security', 'test-discovery', 'test-token-exchange', 'test-gateway']) {
      execFileSync(process.execPath, [`deploy/gateway/${script}.mjs`], { cwd: root, env, stdio: 'inherit' })
    }
    execFileSync(process.execPath, ['deploy/homeassistant/test-gateway.mjs'], { cwd: root, env, stdio: 'inherit' })
  }
} catch (error) {
  failure = error
  throw error
} finally {
  removeSignalHandlers()
  try { removeRuntimeFile(handle) } catch (error) {
    if (failure) throw new AggregateError([failure, error], 'Checks failed and temporary credentials could not be removed')
    throw error
  }
}
