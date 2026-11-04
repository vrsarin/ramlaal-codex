import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const opensslAvailable = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0

test('all MCP images support verified HTTPS and reject plaintext', { skip: !opensslAvailable, timeout: 120_000 }, async () => {
  const project = process.env.SDLC_CA_TEST_PROJECT || `sdlc-mcp-test-${randomBytes(6).toString('hex')}`
  assert.match(project, /^[a-z0-9][a-z0-9_-]*$/)
  const run = randomBytes(8).toString('hex')
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-mcp-listeners-'))
  chmodSync(directory, 0o755)
  const certificate = join(directory, 'server.crt')
  const key = join(directory, 'server.key')
  const identity = join(directory, 'identity')
  const containers = []
  const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', ...options })
  const common = {
    MCP_TLS_CERT_PATH: '/tls/server.crt', MCP_TLS_KEY_PATH: '/tls/server.key',
    MCP_HOST: '0.0.0.0', MCP_PORT: '3000'
  }
  const tokens = JSON.stringify({ fixture: 'local-integration-token-1234567890' })
  const services = [
    { name: 'forgejo', image: process.env.SDLC_TEST_FORGEJO_IMAGE || 'forgejo-workflow-mcp:dev',
      env: { ...common, FORGEJO_URL: 'https://forgejo.localhost', MCP_CLIENT_TOKENS: tokens } },
    { name: 'wikijs', image: process.env.SDLC_TEST_WIKI_IMAGE || 'wikijs-sdlc-mcp:dev',
      env: { ...common, MCP_CLIENT_TOKENS: tokens } },
    { name: 'homeassistant', image: process.env.SDLC_TEST_HOME_IMAGE || 'homeassistant-mcp:dev',
      env: { ...common, MCP_OIDC_ISSUER: 'http://auth.localhost/realms/sdlc',
        MCP_OIDC_AUDIENCE: 'homeassistant-mcp-server', HOMEASSISTANT_INTERNAL_URL: 'https://home-assistant-upstream-tls',
        HOMEASSISTANT_PUBLIC_URL: 'https://home.localhost',
        HOMEASSISTANT_DISCOVERY_SUBJECT_FILE: '/tls/identity', HOMEASSISTANT_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') } }
  ]
  let failure
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=SDLC MCP integration fixture', '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', key, '-out', certificate
    ], { stdio: 'ignore' })
    chmodSync(key, 0o644)
    writeFileSync(identity, '12345678-1234-1234-1234-123456789abc\n')
    for (const service of services) {
      const name = `${project}-${run}-${service.name}`
      const process = spawn('docker', [
        'run', '--rm', '--name', name, '--label', `com.docker.compose.project=${project}`,
        '--label', `sdlc.ca.test=${run}`, '--publish', '127.0.0.1::3000',
        '-v', `${directory}:/tls:ro`, ...Object.entries(service.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        service.image
      ], { stdio: 'ignore' })
      containers.push({ name, process })
    }
    const ca = readFileSync(certificate)
    for (const { name, process } of containers) {
      const deadline = Date.now() + 30_000
      let port
      while (!port && Date.now() < deadline) {
        try {
          const output = docker(['port', name, '3000/tcp'], { stdio: 'pipe' }).trim()
          const match = /^127\.0\.0\.1:(\d+)$/.exec(output)
          if (match) port = Number(match[1])
        } catch {
          if (process.exitCode !== null) throw new Error(`${name} exited before becoming ready`)
        }
        if (!port) await new Promise((resolve) => setTimeout(resolve, 500))
      }
      if (!port) throw new Error(`${name} did not publish its test port`)
      const request = (trusted, servername) => new Promise((resolve, reject) => {
        const request = httpsGet({
          host: '127.0.0.1', port, path: '/healthz', agent: false, ...(trusted ? { ca } : {}),
          ...(servername ? { servername } : {}), rejectUnauthorized: true, timeout: 3000
        }, (response) => { response.resume(); resolve(response.statusCode) })
        request.on('timeout', () => request.destroy(new Error('HTTPS health check timed out')))
        request.on('error', reject)
      })
      let status
      let lastError = 'no response'
      while (!status && Date.now() < deadline) {
        try { status = await request(true) } catch (error) {
          lastError = error instanceof Error ? error.message : 'unknown error'
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
      assert.equal(status, 200, `${name} HTTPS health check: ${lastError}`)
      await assert.rejects(request(false), undefined, `${name} must reject an untrusted CA`)
      await assert.rejects(request(true, 'wrong.localhost'), undefined, `${name} must reject a hostname mismatch`)
      await assert.rejects(new Promise((resolve, reject) => {
        const request = httpGet({ host: '127.0.0.1', port, path: '/healthz', timeout: 3000 }, (response) => {
          response.resume()
          resolve(response)
        })
        request.on('timeout', () => request.destroy(new Error('Plaintext health check timed out')))
        request.on('error', reject)
      }), undefined, `${name} must not accept plaintext`)
    }
  } catch (error) {
    failure = error
  } finally {
    const cleanupErrors = []
    for (const { name, process } of containers.reverse()) {
      try {
        const id = docker(['ps', '-a', '--filter', `name=^${name}$`, '--filter', `label=sdlc.ca.test=${run}`, '--format', '{{.ID}}']).trim()
        if (id) docker(['stop', id], { stdio: 'pipe' })
        if (process.exitCode === null && process.signalCode === null) process.kill()
      } catch (error) { cleanupErrors.push(error) }
    }
    for (const file of [certificate, key, identity]) {
      try { unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(error) }
    }
    try { rmdirSync(directory) } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'MCP listener test cleanup failed')
  }
  if (failure) throw failure
})
