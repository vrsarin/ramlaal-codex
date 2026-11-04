import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ensureLocalCa, localCaFileName } from './local-ca.mjs'

const opensslAvailable = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0

test('exports only the matching local CA and refuses replacement', { skip: !opensslAvailable }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-local-ca-test-'))
  const files = ['first.pem', 'first.key', 'second.pem', 'second.key', localCaFileName].map((name) => join(directory, name))
  t.after(() => {
    for (const path of files) {
      try { unlinkSync(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    rmdirSync(directory)
  })
  for (const name of ['first', 'second']) {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', `/CN=${name} test CA`, '-keyout', join(directory, `${name}.key`),
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-out', join(directory, `${name}.pem`)
    ], { stdio: 'ignore' })
  }
  const first = readFileSync(join(directory, 'first.pem'), 'utf8')
  const second = readFileSync(join(directory, 'second.pem'), 'utf8')
  const saved = ensureLocalCa(directory, first)
  assert.equal(saved.fingerprint, new X509Certificate(first).fingerprint256.replaceAll(':', '').toLowerCase())
  assert.equal(ensureLocalCa(directory, first).path, saved.path)
  assert.throws(() => ensureLocalCa(directory, second), /differs/)
  assert.throws(() => ensureLocalCa(directory, `${first}\n${second}`), /exactly one/)
  unlinkSync(saved.path)
  if (process.platform !== 'win32') {
    symlinkSync(join(directory, 'first.pem'), saved.path)
    assert.throws(() => ensureLocalCa(directory, first), /regular file/)
  }
})
