import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const hosts = [
  'forgejo.localhost', 'wiki.localhost', 'auth.localhost', 'mcp-gateway.localhost',
  'forgejo-mcp.localhost', 'sdlc-mcp.localhost', 'homeassistant.localhost'
]

test('Smallstep issues trusted certificates for each local service hostname', { timeout: 180_000 }, async () => {
  const project = process.env.SDLC_CA_TEST_PROJECT || `sdlc-ca-test-${randomBytes(6).toString('hex')}`
  assert.match(project, /^[a-z0-9][a-z0-9_-]*$/)
  const run = randomBytes(8).toString('hex')
  const prefix = `${project}-${run}`
  const network = `${prefix}-net`
  const names = { ca: `${prefix}-ca`, caddy: `${prefix}-caddy` }
  const volumes = [`${prefix}-ca-data`, `${prefix}-ca-public`, `${prefix}-caddy-data`]
  const createdVolumes = []
  let createdNetwork = false
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-acme-test-'))
  const caddyfile = join(directory, 'Caddyfile')
  const initScript = fileURLToPath(new URL('./init-ca.sh', import.meta.url))
  const labels = ['--label', `com.docker.compose.project=${project}`, '--label', `sdlc.ca.test=${run}`]
  const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', ...options })
  const containers = []
  let failure
  try {
    const existing = new Set(docker(['volume', 'ls', '--format', '{{.Name}}']).trim().split('\n').filter(Boolean))
    if (volumes.some((name) => existing.has(name))) throw new Error('Test volume already exists')
    docker(['network', 'create', ...labels, network])
    createdNetwork = true
    for (const volume of volumes) {
      docker(['volume', 'create', ...labels, volume])
      createdVolumes.push(volume)
    }
    docker([
      'run', '--rm', '--network', 'none', '--user', '0:0', '--entrypoint', '/bin/sh',
      '-v', `${initScript}:/scripts/init-ca.sh:ro`, '-v', `${volumes[0]}:/home/step`,
      '-v', `${volumes[1]}:/public`, '--tmpfs', '/step-secrets',
      'smallstep/step-ca:0.30.2', '-c',
      "set -eu; printf 'test-fixture-password\\n' > /step-secrets/ca-password; cp /step-secrets/ca-password /step-secrets/provisioner-password; sh /scripts/init-ca.sh >/dev/null; step ca provisioner update sdlc-services --x509-min-dur 30s --x509-default-dur 90s --x509-max-dur 5m --ca-config /home/step/config/ca.json >/dev/null"
    ], { stdio: 'pipe' })
    const ca = spawn('docker', [
      'run', '--rm', '--name', names.ca, ...labels, '--network', network, '--network-alias', 'step-ca',
      '--user', '0:0', '-v', `${volumes[0]}:/home/step`, '--tmpfs', '/step-secrets',
      '--entrypoint', '/bin/sh', 'smallstep/step-ca:0.30.2', '-c',
      "set -eu; printf 'test-fixture-password\\n' > /step-secrets/ca-password; exec /usr/local/bin/step-ca --password-file /step-secrets/ca-password /home/step/config/ca.json"
    ], { stdio: 'ignore' })
    containers.push({ name: names.ca, process: ca })
    const readyBy = Date.now() + 30_000
    let ready = false
    while (Date.now() < readyBy) {
      try {
        docker(['exec', names.ca, 'step', 'ca', 'health', '--ca-url', 'https://localhost:9000', '--root', '/home/step/certs/root_ca.crt'], { stdio: 'pipe' })
        ready = true
        break
      } catch {
        if (ca.exitCode !== null) throw new Error('Test CA exited before becoming ready')
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    if (!ready) throw new Error('Test CA did not become ready')
    writeFileSync(caddyfile, `{
  admin off
  auto_https disable_redirects
  renew_interval 5s
  cert_lifetime 90s
  acme_ca https://step-ca:9000/acme/sdlc-services/directory
  acme_ca_root /ca/root_ca.crt
}
${hosts.join(', ')} {
  tls {
    issuer acme https://step-ca:9000/acme/sdlc-services/directory {
      trusted_roots /ca/root_ca.crt
      disable_http_challenge
    }
  }
  respond "local TLS probe" 200
}
`)
    const caddy = spawn('docker', [
      'run', '--rm', '--name', names.caddy, ...labels, '--network', network,
      ...hosts.flatMap((host) => ['--network-alias', host]),
      '-v', `${volumes[1]}:/ca:ro`, '-v', `${volumes[2]}:/data`,
      '-v', `${caddyfile}:/etc/caddy/Caddyfile:ro`, '--entrypoint', 'caddy',
      'caddy:2-alpine', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'
    ], { stdio: 'ignore' })
    containers.push({ name: names.caddy, process: caddy })
    const probe = `
      import assert from 'node:assert/strict'
      import { connect } from 'node:tls'
      const hosts = ${JSON.stringify(hosts)}
      let firstSerial
      const handshake = (host, ca) => new Promise((resolve, reject) => {
        const socket = connect({ host, port: 443, servername: host, ...(ca ? { ca } : {}), rejectUnauthorized: true }, () => {
          const cert = socket.getPeerCertificate()
          socket.end()
          resolve(cert)
        })
        socket.setTimeout(3000, () => socket.destroy(new Error('TLS timeout')))
        socket.on('error', reject)
      })
      for (const host of hosts) {
        let cert
        const deadline = Date.now() + 90_000
        while (!cert && Date.now() < deadline) {
          try { cert = await handshake(host) } catch { await new Promise((resolve) => setTimeout(resolve, 1000)) }
        }
        assert(cert, 'Certificate did not become ready for ' + host)
        assert(cert.subjectaltname?.split(', ').includes('DNS:' + host))
        if (!firstSerial) firstSerial = cert.serialNumber
        assert.equal((await fetch('https://' + host + '/')).status, 200)
      }
      await assert.rejects(handshake(hosts[0], []))
      const deadline = Date.now() + 120_000
      let renewed
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        const cert = await handshake(hosts[0])
        if (cert.serialNumber !== firstSerial) { renewed = cert; break }
      }
      assert(renewed, 'Certificate did not renew automatically')
      assert(Date.parse(renewed.valid_to) > Date.now(), 'Renewed certificate is expired')
    `
    docker([
      'run', '--rm', '--network', network, '-v', `${volumes[1]}:/ca:ro`,
      '-e', 'NODE_EXTRA_CA_CERTS=/ca/root_ca.crt', '--entrypoint', 'node', 'node:22-alpine',
      '--input-type=module', '-e', probe
    ], { stdio: 'pipe' })
  } catch (error) {
    failure = error
  } finally {
    const cleanupErrors = []
    for (const { name, process } of containers.reverse()) {
      try {
        const ids = docker(['ps', '-a', '--filter', `name=^${name}$`, '--filter', `label=sdlc.ca.test=${run}`, '--format', '{{.ID}}']).trim()
        if (ids) docker(['stop', ids], { stdio: 'pipe' })
        if (process.exitCode === null && process.signalCode === null) process.kill()
      } catch (error) { cleanupErrors.push(error) }
    }
    if (createdNetwork) {
      try { docker(['network', 'rm', network], { stdio: 'pipe' }) } catch (error) { cleanupErrors.push(error) }
    }
    for (const volume of createdVolumes.reverse()) {
      try { docker(['volume', 'rm', volume], { stdio: 'pipe' }) } catch (error) { cleanupErrors.push(error) }
    }
    try { unlinkSync(caddyfile) } catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(error) }
    try { rmdirSync(directory) } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'ACME test cleanup failed')
  }
  if (failure) throw failure
})
