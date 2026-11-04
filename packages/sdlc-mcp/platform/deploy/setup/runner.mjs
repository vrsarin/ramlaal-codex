import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homeVolumeNames } from '../homeassistant/ensure-volumes.mjs'
import { mcpConfigurationStatus } from '../homeassistant/mcp-configuration.mjs'
import { storedOnboardingComplete } from '../homeassistant/onboarding-status.mjs'
import { mcpTlsEnabled } from '../gateway/mcp-upstreams.mjs'
import { gatewayBase } from '../gateway/gateway-url.mjs'
import { assertNoLegacyGatewayFile, nonSensitiveTemplate, validateConfiguration } from './configuration.mjs'
import { registerForgejoOAuth } from './forgejo-oauth.mjs'
import { ensureLocalCa } from './local-ca.mjs'
import { createTrustedFetch } from './trusted-fetch.mjs'
import { assertNoRuntimeReplacementFiles, createRuntimeFile, installRuntimeSignalCleanup, newRuntimeSecrets, removeRuntimeFile, runtimeSecretsFromContainer, updateRuntimeFile } from './runtime-secrets.mjs'
import { waitForOidc } from './wait-oidc.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
function run(program, args, { env, capture = false, input } = {}) {
  return execFileSync(program, args, {
    cwd: root, env, input, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  })
}

function getConfig() {
  const path = fileURLToPath(new URL('../../.env', import.meta.url))
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('.env must be a regular file')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const source = readFileSync(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8')
    writeFileSync(path, nonSensitiveTemplate(source), { flag: 'wx', mode: 0o600 })
  }
  return validateConfiguration(readFileSync(path, 'utf8'))
}

function docker(args, env, capture = false) {
  return run('docker', args, { env, capture })
}

function existingSecrets(project, env) {
  const ids = docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=sdlc-runtime-keeper', '--format', '{{.ID}}'], env, true).trim().split('\n').filter(Boolean)
  if (ids.length > 1) throw new Error('Multiple runtime secret keepers were found; inspect the project before continuing')
  if (ids.length === 1) return runtimeSecretsFromContainer(JSON.parse(docker(['inspect', ids[0]], env, true))[0], project)
  const containers = docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'], env, true).trim()
  const labelledVolumes = docker(['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}'], env, true).trim()
  const names = new Set(docker(['volume', 'ls', '--format', '{{.Name}}'], env, true).trim().split('\n').filter(Boolean))
  const persistentNames = ['home-assistant-data', 'home-assistant-oidc', 'step-ca-data', 'step-ca-secrets', 'step-ca-public']
  if (containers || labelledVolumes || persistentNames.some((name) => names.has(`${project}_${name}`))) {
    throw new Error('Existing stack data has no running runtime secret keeper. Refusing to regenerate secrets; use the confirmed teardown or recover the original stack.')
  }
  return undefined
}

async function waitForForgejo(origin, username, password, fetcher = fetch) {
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  const deadline = Date.now() + 120_000
  let last = 'not reachable'
  while (Date.now() < deadline) {
    try {
      const response = await fetcher(`${origin}/api/v1/user`, {
        headers: { authorization: auth }, redirect: 'error', signal: AbortSignal.timeout(3000)
      })
      if (response.ok) return
      last = `HTTP ${response.status}`
    } catch (error) {
      if (!(error instanceof TypeError) && error?.name !== 'TimeoutError') throw error
      last = error.message
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error(`Forgejo did not become ready: ${last}`)
}

export async function setupStack({ passwords, getPasswords, onboard, configureMcp, trustCa, progress = console.log } = {}) {
  assertNoRuntimeReplacementFiles(root)
  assertNoLegacyGatewayFile(root)
  const config = getConfig()
  const project = config.COMPOSE_PROJECT_NAME || 'forgejo-wikijs-sdlc'
  const baseEnv = { ...process.env }
  delete baseEnv.COMPOSE_PROJECT_NAME
  const resolved = { ...baseEnv, ...config }
  const useMcpTls = mcpTlsEnabled(resolved.ENABLE_TLS ?? resolved.SDLC_MCP_TLS)
  const useGatewayHttps = gatewayBase(resolved).startsWith('https://')
  if (useGatewayHttps && !useMcpTls) throw new Error('SDLC_HTTPS requires ENABLE_TLS')
  const files = ['compose.yaml', 'compose.gateway.yaml', 'compose.homeassistant.yaml', 'compose.runtime.yaml',
    ...(useMcpTls ? ['compose.mcp-tls.yaml'] : []), ...(useGatewayHttps ? ['compose.gateway-https.yaml'] : [])]
  const composeArgs = [
    'compose', '--env-file', '.env', '--env-file', '.sdlc-runtime',
    ...files.flatMap((file) => ['-f', file]), '--profile', 'mcp', '--profile', 'gateway', '--profile', 'homeassistant', '--profile', 'runtime',
    ...(useMcpTls ? ['--profile', 'mcp-tls'] : [])
  ]
  const prior = existingSecrets(project, baseEnv)
  const secrets = prior ?? newRuntimeSecrets(passwords ?? await getPasswords?.() ?? {})
  let handle
  let originalError
  let removeSignalHandlers
  let localCaPath
  let trustedFetch
  try {
    handle = createRuntimeFile(root, secrets)
    removeSignalHandlers = installRuntimeSignalCleanup(handle)
    const environment = () => ({ ...resolved, ...secrets, SDLC_RUNTIME_ENV_FILE: '.sdlc-runtime',
      ...(useGatewayHttps && localCaPath ? { NODE_EXTRA_CA_CERTS: localCaPath } : {}) })
    const compose = (...args) => docker([...composeArgs, ...args], environment())
    const script = (path, ...args) => run(process.execPath, [path, ...args], { env: environment() })

    progress('[1/8] Starting the temporary-credential keeper')
    compose('up', '-d', '--no-deps', 'sdlc-runtime-keeper')
    progress('[2/8] Preparing the local certificate authority')
    const rendered = JSON.parse(docker([...composeArgs, 'config', '--format', 'json'], environment(), true))
    for (const name of homeVolumeNames(rendered)) docker(['volume', 'create', name], environment(), true)
    compose('up', '-d', '--wait', '--wait-timeout', '180', 'step-ca')
    const ca = docker([...composeArgs, 'exec', '-T', 'step-ca', 'cat', '/home/step/certs/root_ca.crt'], environment(), true)
    const localCa = ensureLocalCa(root, ca)
    localCaPath = localCa.path
    trustedFetch = createTrustedFetch(ca)
    if (trustCa) await trustCa(localCa)
    if (useMcpTls) compose('up', '-d', '--wait', '--wait-timeout', '180', 'mcp-cert-manager')
    progress('[3/8] Building and starting Forgejo, Wiki.js, and Keycloak')
    compose('up', '-d', '--build', 'proxy')
    await waitForOidc(`https://${config.KEYCLOAK_HOSTNAME}/realms/${config.KEYCLOAK_REALM}`, { fetcher: trustedFetch })
    compose('up', '-d', '--build', 'forgejo-mcp', 'wikijs-sdlc-mcp', 'forgejo-init', 'wikijs-init')
    compose('wait', 'forgejo-init', 'wikijs-init', 'keycloak-mcp-init')
    for (const service of ['forgejo-init', 'wikijs-init', 'keycloak-mcp-init']) {
      const ids = docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`,
        '--filter', `label=com.docker.compose.service=${service}`, '--filter', 'label=com.docker.compose.oneoff=False',
        '--format', '{{.ID}}'], environment(), true).trim().split('\n').filter(Boolean)
      const entries = ids.length ? JSON.parse(docker(['inspect', ...ids], environment(), true)) : []
      if (entries.length !== 1 || entries[0].State?.Status !== 'exited' || entries[0].State?.ExitCode !== 0) {
        throw new Error(`${service} did not complete successfully`)
      }
    }
    compose('run', '--rm', '--no-deps', 'keycloak-mcp-init')
    compose('run', '--rm', '--no-deps', 'wikijs-init')
    compose('restart', 'proxy')
    await waitForForgejo(`https://${config.FORGEJO_HOSTNAME}`, config.FORGEJO_ADMIN_USERNAME, secrets.FORGEJO_ADMIN_PASSWORD, trustedFetch)
    const oauth = await registerForgejoOAuth({
      origin: `https://${config.FORGEJO_HOSTNAME}`, username: config.FORGEJO_ADMIN_USERNAME, password: secrets.FORGEJO_ADMIN_PASSWORD,
      redirectUrl: config.FORGEJO_OAUTH_REDIRECT_URL || 'http://localhost/oauth/forgejo/callback',
      clientId: secrets.FORGEJO_OAUTH_CLIENT_ID, clientSecret: secrets.FORGEJO_OAUTH_CLIENT_SECRET, fetcher: trustedFetch
    })
    secrets.FORGEJO_OAUTH_CLIENT_ID = oauth.clientId
    secrets.FORGEJO_OAUTH_CLIENT_SECRET = oauth.clientSecret
    updateRuntimeFile(handle, secrets)
    compose('up', '-d', '--no-deps', '--force-recreate', 'sdlc-runtime-keeper', 'forgejo-mcp')
    progress('[4/8] Starting the MCP gateway')
    compose('up', '-d', '--build', 'gateway-registry')
    script('deploy/gateway/wait-ready.mjs')
    script('deploy/gateway/bootstrap.mjs')
    script('deploy/gateway/wait-ready.mjs', 'virtual')
    progress('[5/8] Checking gateway security and connections')
    for (const path of ['check-security.mjs', 'test-discovery.mjs', 'test-token-exchange.mjs', 'test-gateway.mjs']) {
      script(`deploy/gateway/${path}`)
    }
    progress('[6/8] Preparing Home Assistant and the local test CA')
    compose('up', '-d', '--build', '--wait', '--wait-timeout', '180', 'home-assistant', 'step-ca')
    compose('exec', '-T', 'step-ca', '/bin/sh', '/scripts/test-ca.sh')
    const homeAssistantUrl = `https://${config.HOMEASSISTANT_HOSTNAME || 'home.localhost'}`
    progress(`[7/8] Home Assistant is available at ${homeAssistantUrl}`)
    const storedOnboarding = () => {
      const command = "import json,os; p='/config/.storage/onboarding'; print(json.dumps(json.load(open(p))['data']['done'] if os.path.exists(p) else []))"
      const result = docker([...composeArgs, 'exec', '-T', 'home-assistant', 'python', '-c', command], environment(), true)
      return storedOnboardingComplete(JSON.parse(result))
    }
    if (onboard && await onboard(storedOnboarding, { url: homeAssistantUrl, fetcher: trustedFetch })) {
      compose('run', '--rm', '--no-deps', 'home-assistant-config-init')
      compose('up', '-d', '--no-deps', '--force-recreate', 'home-assistant')
      script('deploy/homeassistant/test-sso.mjs', '--discovery')
      const mcpStatus = () => {
        const command = "import json; d=json.load(open('/config/.storage/core.config_entries')); print(json.dumps([e['data'] | e.get('options', {}) for e in d['data']['entries'] if e['domain']=='mcp_server']))"
        const result = docker([...composeArgs, 'exec', '-T', 'home-assistant', 'python', '-c', command], environment(), true)
        return mcpConfigurationStatus(JSON.parse(result))
      }
      if (configureMcp && await configureMcp(mcpStatus)) {
        const issue = mcpStatus()
        if (issue) throw new Error(`Home Assistant MCP integration is not ready: ${issue}`)
        progress('[8/8] Connecting and verifying Home Assistant through the gateway')
        compose('up', '-d', '--build', '--wait', '--wait-timeout', '180', 'homeassistant-mcp')
        compose('exec', '-T', 'homeassistant-mcp', 'node', 'src/test-upstream-tls.mjs')
        script('deploy/homeassistant/connect-discovery.mjs')
        script('deploy/homeassistant/bootstrap-gateway.mjs')
        script('deploy/gateway/check-security.mjs')
        script('deploy/gateway/test-gateway.mjs')
        script('deploy/homeassistant/test-gateway.mjs')
        progress('Setup completed: gateway scans, Home Assistant discovery, TLS, and access checks passed.')
        return { complete: true }
      }
    }
    progress('[8/8] Home Assistant gateway integration remains pending; setup is not complete.')
    return { complete: false }
  } catch (error) {
    originalError = error
    throw error
  } finally {
    trustedFetch?.close()
    removeSignalHandlers?.()
    if (handle) {
      try { removeRuntimeFile(handle) } catch (cleanupError) {
        if (originalError) throw new AggregateError([originalError, cleanupError], 'Setup failed and temporary credentials could not be removed')
        throw cleanupError
      }
    }
  }
}
