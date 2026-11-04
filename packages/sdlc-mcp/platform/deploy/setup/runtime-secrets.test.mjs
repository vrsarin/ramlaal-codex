import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, lstatSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertNoRuntimeReplacementFiles, createRuntimeFile, newRuntimeSecrets, removeRuntimeFile, updateRuntimeFile, requiredSecretNames, runtimeSecretsFromContainer, userPasswordNames } from './runtime-secrets.mjs'

test('generates independent keys and validates user passwords', () => {
  const passwords = Object.fromEntries(userPasswordNames.map((name) => [name, 'local-test-password']))
  const first = newRuntimeSecrets(passwords)
  const second = newRuntimeSecrets(passwords)
  for (const name of requiredSecretNames) assert(first[name], name)
  assert.notEqual(first.GATEWAY_SECRET_KEY, second.GATEWAY_SECRET_KEY)
  assert.equal(Buffer.from(first.FORGEJO_TOKEN_ENCRYPTION_KEY, 'base64').length, 32)
  assert.throws(() => newRuntimeSecrets({ ...passwords, KEYCLOAK_TEST_PASSWORD: 'short' }), /KEYCLOAK_TEST_PASSWORD/)
})

test('runtime file is exclusive, private, and not removed if changed', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-runtime-test-'))
  const handle = createRuntimeFile(directory, { TEST_SECRET: "fixture-value-$#'\\tail" })
  t.after(() => {
    try { unlinkSync(handle.path) } catch (error) { if (error.code !== 'ENOENT') throw error }
    rmdirSync(directory)
  })

  if (process.platform !== 'win32') assert.equal(lstatSync(handle.path).mode & 0o777, 0o600)
  assert.throws(() => createRuntimeFile(directory, { TEST_SECRET: 'another' }), /EEXIST/)
  updateRuntimeFile(handle, { TEST_SECRET: 'updated-test-value' })
  writeFileSync(handle.path, 'changed\n')
  assert.throws(() => removeRuntimeFile(handle), /changed/)
  assert.throws(() => updateRuntimeFile(handle, { TEST_SECRET: 'another' }), /changed/)
})

test('a stale runtime replacement file blocks setup and teardown', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-runtime-stale-test-'))
  const path = join(directory, `.sdlc-runtime.${'a'.repeat(24)}.tmp`)
  t.after(() => { unlinkSync(path); rmdirSync(directory) })
  assert.doesNotThrow(() => assertNoRuntimeReplacementFiles(directory))
  writeFileSync(path, 'fixture')
  assert.throws(() => assertNoRuntimeReplacementFiles(directory), /temporary runtime replacement file/)
})

test('only a running secret keeper can restore the complete runtime state', () => {
  const passwords = Object.fromEntries(userPasswordNames.map((name) => [name, 'local-test-password']))
  const values = newRuntimeSecrets(passwords)
  const labels = { 'com.docker.compose.project': 'project', 'com.docker.compose.service': 'sdlc-runtime-keeper' }
  const container = { State: { Running: true }, Config: { Labels: labels, Env: Object.entries(values).map(([key, value]) => `${key}=${value}`) } }
  assert.deepEqual(runtimeSecretsFromContainer(container, 'project'), values)
  assert.throws(() => runtimeSecretsFromContainer(container, 'other'), /does not belong/)
  assert.throws(() => runtimeSecretsFromContainer({ ...container, State: { Running: false } }, 'project'), /not running/)
  assert.throws(() => runtimeSecretsFromContainer({ ...container, Config: { Labels: labels, Env: [] } }, 'project'), /missing/)
})

test('interrupting setup removes its temporary credentials', { skip: process.platform === 'win32', timeout: 10_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-runtime-signal-test-'))
  const script = `
    import { createRuntimeFile, installRuntimeSignalCleanup } from ${JSON.stringify(new URL('./runtime-secrets.mjs', import.meta.url).href)}
    const handle = createRuntimeFile(process.argv[1], { TEST_SECRET: 'signal-test' })
    installRuntimeSignalCleanup(handle)
    console.log('ready')
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    try { unlinkSync(join(directory, '.sdlc-runtime')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    rmdirSync(directory)
  })
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('error', reject)
    child.once('exit', () => reject(new Error('Signal test exited before becoming ready')))
  })
  const finished = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM')
  assert.deepEqual(await finished, { code: 143, signal: null })
  assert.throws(() => lstatSync(join(directory, '.sdlc-runtime')), /ENOENT/)
})
