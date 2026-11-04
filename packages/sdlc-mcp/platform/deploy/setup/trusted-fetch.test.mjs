import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTrustedFetch } from './trusted-fetch.mjs'

const opensslAvailable = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0

test('local HTTPS client verifies its CA and rejects redirects and oversized responses', {
  skip: !opensslAvailable, timeout: 20_000
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-trusted-fetch-'))
  const files = ['first.pem', 'first.key', 'other.pem', 'other.key'].map((name) => join(directory, name))
  const [firstCert, firstKey, otherCert, otherKey] = files
  let server
  let trusted
  let untrusted
  try {
    for (const [certificate, key] of [[firstCert, firstKey], [otherCert, otherKey]]) {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=SDLC test CA',
        '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,digitalSignature,keyEncipherment',
        '-addext', 'subjectAltName=IP:127.0.0.1',
        '-keyout', key, '-out', certificate
      ], { stdio: 'ignore' })
    }
    server = createServer({ cert: readFileSync(firstCert), key: readFileSync(firstKey) }, (request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/json' })
        response.end()
      } else if (request.url === '/large') {
        response.end(Buffer.alloc(2 * 1024 * 1024 + 1))
      } else if (request.url === '/slow') {
        setTimeout(() => response.end('late'), 500)
      } else {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ ok: true, method: request.method }))
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    const url = `https://127.0.0.1:${address.port}`
    trusted = createTrustedFetch(readFileSync(firstCert, 'utf8'))
    untrusted = createTrustedFetch(readFileSync(otherCert, 'utf8'))
    assert.throws(() => createTrustedFetch(readFileSync(firstCert, 'utf8') + readFileSync(otherCert, 'utf8')), /exactly one/)
    assert.deepEqual(await (await trusted(`${url}/json`, { method: 'POST', body: '{}' })).json(), { ok: true, method: 'POST' })
    await assert.rejects(() => untrusted(`${url}/json`))
    await assert.rejects(() => trusted('http://127.0.0.1/'), /requires a localhost HTTPS URL/)
    await assert.rejects(() => trusted('https://example.com/'), /requires a localhost HTTPS URL/)
    await assert.rejects(() => trusted(`${url}/redirect`), /redirects are not allowed/)
    assert.equal((await trusted(`${url}/redirect`, { redirect: 'manual' })).status, 302)
    await assert.rejects(() => trusted(`${url}/large`), /exceeded the size limit/)
    await assert.rejects(() => trusted(`${url}/slow`, { signal: AbortSignal.timeout(30) }))
  } finally {
    trusted?.close()
    untrusted?.close()
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    for (const path of files) {
      try { unlinkSync(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    rmdirSync(directory)
  }
})
