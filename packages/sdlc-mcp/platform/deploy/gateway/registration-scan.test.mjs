import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForRegistrationScan } from './registration-scan.mjs'

test('waits for the initial failed scan to apply its security block', async () => {
  let time = 0
  let scans = 0
  let servers = 0
  const scan = await waitForRegistrationScan('/test', {
    now: () => time, sleep: async (ms) => { time += ms },
    getScan: async () => (++scans === 1 ? undefined : { is_safe: false, scan_failed: true }),
    getServer: async () => (++servers === 1
      ? { tags: ['security-pending'], is_enabled: true }
      : { tags: ['security-pending'], is_enabled: false })
  })
  assert.equal(scan.scan_failed, true)
  assert.equal(scans, 2)
  assert.equal(servers, 2)
})

test('rejects unfinished scans and missing blocks', async () => {
  for (const getScan of [async () => undefined, async () => ({ is_safe: false, scan_failed: true })]) {
    let time = 0
    await assert.rejects(() => waitForRegistrationScan('/test', {
      timeoutMs: 4000, now: () => time, sleep: async (ms) => { time += ms },
      getScan, getServer: async () => ({ tags: [], is_enabled: true })
    }), /did not finish/)
  }
})
