#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { homeVolumeNames } from '../homeassistant/ensure-volumes.mjs'
import { assertNoRuntimeReplacementFiles, requiredSecretNames } from './runtime-secrets.mjs'
import { localCaFileName } from './local-ca.mjs'
import { removeOwnedCurrentUserCaTrust, trustLedgerFileName } from './user-ca-trust.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const knownOrphans = new Set(['mcp-everything', 'home-assistant-keycloak-loopback', 'home-assistant-upstream-tls'])
const knownOrphanNetworks = new Set(['everything-net'])
const mcpTlsVolumeKeys = ['mcp-cert-state', 'forgejo-mcp-cert', 'wikijs-mcp-cert', 'homeassistant-mcp-cert', 'gateway-public-cert-data']

export function teardownPlan(config, project, containers, networks = []) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project) || config.name !== project) {
    throw new Error('Compose project does not match the project in .env')
  }
  const expectedVolumes = homeVolumeNames(config)
  for (const [key, volume] of Object.entries(config.volumes ?? {})) {
    if (volume.name !== `${project}_${key}` || (volume.external && !expectedVolumes.includes(volume.name))) {
      throw new Error(`Volume ${key} is not a managed project volume`)
    }
  }
  for (const [key, network] of Object.entries(config.networks ?? {})) {
    if (network.name !== `${project}_${key}` || network.external) {
      throw new Error(`Network ${key} is not a managed project network`)
    }
  }
  const services = new Set(Object.keys(config.services ?? {}))
  const orphans = []
  for (const container of containers) {
    const labels = container.Config?.Labels ?? {}
    if (labels['com.docker.compose.project'] !== project || !/^[a-f0-9]{64}$/.test(container.Id ?? '')) {
      throw new Error('Unexpected container in the Compose project')
    }
    if (String(labels['com.docker.compose.oneoff']).toLowerCase() === 'true') {
      throw new Error('A one-off Compose container exists; wait for it to finish before teardown')
    }
    const service = labels['com.docker.compose.service']
    if (!services.has(service)) {
      if (!knownOrphans.has(service)) throw new Error(`Unknown Compose service ${service}; refusing to remove it`)
      orphans.push({ id: container.Id, running: container.State?.Running === true })
    }
  }
  const orphanNetworks = []
  for (const network of networks) {
    const labels = network.Labels ?? {}
    const name = labels['com.docker.compose.network']
    if (labels['com.docker.compose.project'] !== project || !/^[a-f0-9]{64}$/.test(network.Id ?? '') ||
        network.Name !== `${project}_${name}`) throw new Error('Unexpected network in the Compose project')
    if (!Object.hasOwn(config.networks ?? {}, name)) {
      if (!knownOrphanNetworks.has(name)) throw new Error(`Unknown Compose network ${name}; refusing to remove it`)
      orphanNetworks.push({ id: network.Id, name })
    }
  }
  return { externalVolumes: expectedVolumes, orphans, orphanNetworks }
}

function command(args, options = {}) {
  return execFileSync('docker', args, {
    cwd: root, encoding: 'utf8', ...options
  })
}

function localFile(name) {
  const path = fileURLToPath(new URL(`../../${name}`, import.meta.url))
  let stat
  try { stat = lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} must be a regular file, not a symbolic link`)
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
  return { path, stat, digest }
}

function assertUnchangedFile(file) {
  const current = lstatSync(file.path)
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== file.stat.dev ||
      current.ino !== file.stat.ino || current.size !== file.stat.size || current.mtimeMs !== file.stat.mtimeMs ||
      createHash('sha256').update(readFileSync(file.path)).digest('hex') !== file.digest) {
    throw new Error(`Local configuration changed during teardown: ${file.path}`)
  }
}

function removeUnchangedFile(file) {
  if (!file) return
  assertUnchangedFile(file)
  unlinkSync(file.path)
}

export function volumeStateMatches(expected, actual) {
  if (expected.length !== actual.length) return false
  if (expected.some((volume) => typeof volume.Name !== 'string' || typeof volume.CreatedAt !== 'string' || !volume.CreatedAt)) return false
  const entries = new Map(expected.map((volume) => [volume.Name, volume.CreatedAt]))
  return entries.size === expected.length &&
    actual.every((volume) => entries.has(volume.Name) && entries.get(volume.Name) === volume.CreatedAt)
}

export function teardownMode(gatewayFile, containers) {
  const hasKeeper = containers.some((container) => container.Config?.Labels?.['com.docker.compose.service'] === 'sdlc-runtime-keeper')
  if (gatewayFile && hasKeeper) throw new Error('Both legacy gateway credentials and a runtime keeper exist; refusing ambiguous teardown')
  return gatewayFile ? 'legacy' : 'runtime'
}

export function hasMcpTlsResources(project, containers, volumeNames) {
  const services = new Set(['mcp-cert-manager', 'mcp-cert-volume-init'])
  return containers.some((container) => services.has(container.Config?.Labels?.['com.docker.compose.service'])) ||
    mcpTlsVolumeKeys.some((key) => volumeNames.includes(`${project}_${key}`))
}

export function hasGatewayHttpsResources(project, containers, volumeNames) {
  return volumeNames.includes(`${project}_gateway-public-cert-data`) ||
    containers.some((container) => container.Config?.Labels?.['com.docker.compose.service'] === 'proxy' &&
      container.Config?.Env?.includes('SDLC_GATEWAY_SCHEME=https'))
}

export function validateMcpTlsVolumes(project, volumes) {
  for (const volume of volumes) {
    const key = mcpTlsVolumeKeys.find((name) => volume.Name === `${project}_${name}`)
    if (key && (volume.Labels?.['com.docker.compose.project'] !== project ||
        volume.Labels?.['com.docker.compose.volume'] !== key)) {
      throw new Error(`MCP certificate volume ${volume.Name} is not managed by this project`)
    }
  }
}

export async function main() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Teardown requires an interactive terminal for confirmation')
  assertNoRuntimeReplacementFiles(root)
  const envFile = localFile('.env')
  const gatewayFile = localFile('gateway.env')
  const caFile = localFile(localCaFileName)
  const trustFile = localFile(trustLedgerFileName)
  if (!envFile) throw new Error('.env is required to identify the exact stack; no data was removed')
  if (localFile('.sdlc-runtime')) throw new Error('A setup runtime file exists; wait for setup to finish, or inspect and remove a stale file only after confirming setup is not running')
  const vars = parseEnv(readFileSync(envFile.path, 'utf8'))
  const project = vars.COMPOSE_PROJECT_NAME || 'forgejo-wikijs-sdlc'
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new Error('Invalid COMPOSE_PROJECT_NAME in .env')
  const env = { ...process.env }
  delete env.COMPOSE_PROJECT_NAME
  const ids = command(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'], { env }).trim().split('\n').filter(Boolean)
  const containers = ids.length ? JSON.parse(command(['inspect', ...ids], { env })) : []
  const mode = teardownMode(gatewayFile, containers)
  const listedVolumes = command(['volume', 'ls', '--format', '{{.Name}}'], { env }).trim().split('\n').filter(Boolean)
  const gatewayHttps = hasGatewayHttpsResources(project, containers, listedVolumes)
  const mcpTls = gatewayHttps || hasMcpTlsResources(project, containers, listedVolumes)
  const composeNames = ['compose.yaml', 'compose.gateway.yaml', 'compose.homeassistant.yaml',
    ...(mode === 'runtime' ? ['compose.runtime.yaml'] : []), ...(mcpTls ? ['compose.mcp-tls.yaml'] : []),
    ...(gatewayHttps ? ['compose.gateway-https.yaml'] : [])]
  const composeFiles = composeNames.map(localFile)
  if (composeFiles.some((file) => !file)) throw new Error('Required Compose configuration is missing')
  const inputs = [envFile, ...(gatewayFile ? [gatewayFile] : []), ...(caFile ? [caFile] : []), ...(trustFile ? [trustFile] : []), ...composeFiles]
  if (mode === 'runtime') {
    for (const name of requiredSecretNames) env[name] = 'teardown-placeholder'
  }
  const prefix = [
    'compose', '--project-name', project, '--env-file', '.env', ...(gatewayFile ? ['--env-file', 'gateway.env'] : []),
    ...composeNames.flatMap((name) => ['-f', name]),
    '--profile', 'mcp', '--profile', 'gateway', '--profile', 'homeassistant', ...(mode === 'runtime' ? ['--profile', 'runtime'] : []),
    ...(mcpTls ? ['--profile', 'mcp-tls'] : [])
  ]
  const config = JSON.parse(command([...prefix, 'config', '--format', 'json'], { env }))
  const networkIds = command(['network', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'], { env }).trim().split('\n').filter(Boolean)
  const networks = networkIds.length ? JSON.parse(command(['network', 'inspect', ...networkIds], { env })) : []
  const plan = teardownPlan(config, project, containers, networks)
  const volumeNames = Object.values(config.volumes).map((volume) => volume.name)
  function volumeState() {
    const listed = new Set(command(['volume', 'ls', '--format', '{{.Name}}'], { env }).trim().split('\n').filter(Boolean))
    const existing = volumeNames.filter((name) => listed.has(name))
    return existing.length ? JSON.parse(command(['volume', 'inspect', ...existing], { env })) : []
  }
  const priorVolumes = volumeState()
  validateMcpTlsVolumes(project, priorVolumes)
  console.log(`\nThis permanently deletes project ${project}'s repositories, databases, grants, Home Assistant data, Step CA identity, gateway state, and local configuration files.`)
  console.log(trustFile ? 'The project-owned current-user CA trust entry will also be removed.' : 'No project-owned user trust entry was found; unrelated trust stores will not be changed.')
  console.log('Docker images are not removed.')
  console.log('A fresh setup will generate new credentials and require Home Assistant onboarding.')
  const prompt = createInterface({ input: stdin, output: stdout })
  let answer
  try { answer = await prompt.question('Type DELETE to continue: ') } finally { prompt.close() }
  if (answer !== 'DELETE') {
    console.log('Teardown cancelled; nothing was deleted.')
    return
  }
  for (const file of inputs) assertUnchangedFile(file)
  assertNoRuntimeReplacementFiles(root)
  if (localFile('.sdlc-runtime')) throw new Error('Setup started while awaiting confirmation; no data was removed')
  if (!caFile && localFile(localCaFileName)) throw new Error('A local CA file appeared while awaiting confirmation; no data was removed')
  if (!volumeStateMatches(priorVolumes, volumeState())) throw new Error('Project volumes changed while awaiting confirmation')
  for (const orphan of plan.orphans) {
    const current = JSON.parse(command(['inspect', orphan.id], { env }))[0]
    const labels = current.Config?.Labels ?? {}
    if (labels['com.docker.compose.project'] !== project || !knownOrphans.has(labels['com.docker.compose.service'])) {
      throw new Error('An orphan container changed identity during teardown')
    }
    if (current.State?.Running) command(['stop', orphan.id], { env, stdio: 'inherit' })
    command(['rm', orphan.id], { env, stdio: 'inherit' })
  }
  for (const file of inputs) assertUnchangedFile(file)
  if (trustFile) removeOwnedCurrentUserCaTrust(root)
  command([...prefix, 'down', '--volumes'], { env, stdio: 'inherit' })
  for (const network of plan.orphanNetworks) {
    const current = JSON.parse(command(['network', 'inspect', network.id], { env }))[0]
    if (current.Labels?.['com.docker.compose.project'] !== project ||
        current.Labels?.['com.docker.compose.network'] !== network.name || current.Name !== `${project}_${network.name}`) {
      throw new Error('An orphan network changed identity during teardown')
    }
    command(['network', 'rm', network.id], { env, stdio: 'inherit' })
  }
  const volumes = new Set(command(['volume', 'ls', '--format', '{{.Name}}'], { env }).trim().split('\n').filter(Boolean))
  for (const name of plan.externalVolumes) {
    if (volumes.has(name)) command(['volume', 'rm', name], { env, stdio: 'inherit' })
  }
  removeUnchangedFile(gatewayFile)
  removeUnchangedFile(caFile)
  removeUnchangedFile(envFile)
  console.log('Local stack data, managed CA volumes, owned CA trust, and local configuration files were removed.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Teardown failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    process.exitCode = 1
  })
}
