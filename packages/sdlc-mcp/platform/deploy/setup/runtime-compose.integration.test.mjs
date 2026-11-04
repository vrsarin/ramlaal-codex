import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRuntimeFile, removeRuntimeFile } from './runtime-secrets.mjs'

test('Compose receives exact quoted runtime values', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-compose-test-'))
  const value = "fixture-value-$#'\\tail\\'last"
  const handle = createRuntimeFile(directory, { TEST_SECRET: value })
  const compose = join(directory, 'compose.yaml')
  t.after(() => {
    try { unlinkSync(handle.path) } catch (error) { if (error.code !== 'ENOENT') throw error }
    try { unlinkSync(compose) } catch (error) { if (error.code !== 'ENOENT') throw error }
    rmdirSync(directory)
  })
  writeFileSync(compose, 'services:\n  test:\n    image: alpine:3.21\n    network_mode: none\n    environment:\n      TEST_SECRET: ${TEST_SECRET}\n    command: ["/bin/sh", "-c", "printf %s \\"$$TEST_SECRET\\" | base64"]\n')
  const result = execFileSync('docker', ['compose', '--env-file', handle.path, '-f', compose, 'run', '--rm', '--no-deps', 'test'], { encoding: 'utf8' })
  assert.equal(Buffer.from(result.trim(), 'base64').toString('utf8'), value)
  removeRuntimeFile(handle)
})
