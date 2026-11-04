import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const expectAvailable = process.platform !== 'win32' && spawnSync('expect', ['-v']).status === 0

test('password prompt masks input and resumes terminal input for the next question', { skip: !expectAvailable }, () => {
  const fixture = randomBytes(24).toString('hex')
  const script = `
    import { password, line } from ${JSON.stringify(new URL('./wizard.mjs', import.meta.url).href)}
    if (await password('Password') !== process.env.TEST_FIXTURE) process.exit(1)
    if (await line('Continue: ') !== 'yes') process.exit(1)
    console.log('MATCH')
  `
  const expectScript = `
    log_user 0
    set timeout 10
    spawn -noecho $env(NODE_EXECUTABLE) --input-type=module -e $env(TEST_SCRIPT)
    expect -re {Password: } { send -- "$env(TEST_FIXTURE)\\r" } timeout { exit 1 }
    expect -re {Continue: } {
      if {[string first $env(TEST_FIXTURE) $expect_out(buffer)] >= 0} { exit 2 }
      send -- "yes\\r"
    } timeout { exit 5 }
    expect eof
    set output $expect_out(buffer)
    if {[string first $env(TEST_FIXTURE) $output] >= 0} { exit 2 }
    if {[string first MATCH $output] < 0} { exit 3 }
    set result [wait]
    if {[lindex $result 3] != 0} { exit 4 }
  `
  const result = spawnSync('expect', ['-c', expectScript], {
    env: { ...process.env, NODE_EXECUTABLE: process.execPath, TEST_SCRIPT: script, TEST_FIXTURE: fixture },
    encoding: 'utf8', timeout: 15_000
  })
  assert.equal(result.status, 0, `Password prompt test failed: ${result.error?.message ?? result.stderr}`)
})

test('terminal EOF cancels a wizard question', { skip: !expectAvailable }, () => {
  const script = `
    import { line } from ${JSON.stringify(new URL('./wizard.mjs', import.meta.url).href)}
    try { await line('Continue: '); process.exit(1) }
    catch (error) { if (error.message !== 'Setup cancelled') process.exit(1); console.log('CANCELLED') }
  `
  const expectScript = `
    log_user 0
    set timeout 10
    spawn -noecho $env(NODE_EXECUTABLE) --input-type=module -e $env(TEST_SCRIPT)
    expect -re {Continue: } { send -- "\\004" } timeout { exit 1 }
    expect eof
    if {[string first CANCELLED $expect_out(buffer)] < 0} { exit 2 }
    set result [wait]
    if {[lindex $result 3] != 0} { exit 3 }
  `
  const result = spawnSync('expect', ['-c', expectScript], {
    env: { ...process.env, NODE_EXECUTABLE: process.execPath, TEST_SCRIPT: script },
    encoding: 'utf8', timeout: 15_000
  })
  assert.equal(result.status, 0, `Terminal EOF test failed: ${result.error?.message ?? result.stderr}`)
})
