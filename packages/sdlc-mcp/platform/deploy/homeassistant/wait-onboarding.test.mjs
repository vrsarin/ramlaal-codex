import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForOnboarding } from './wait-onboarding.mjs'

const steps = ['user', 'core_config', 'analytics', 'integration'].map((step) => ({ step, done: false }))
test('waits for startup errors and does not mistake an early 404 for completed onboarding', async () => {
  let attempt = 0
  let time = 0
  const result = await waitForOnboarding(() => false, {
    fetcher: async () => {
      if (++attempt === 1) throw new TypeError('connection refused')
      if (attempt === 2) return new Response(null, { status: 404 })
      return Response.json(steps)
    },
    now: () => time, sleep: async (ms) => { time += ms }
  })
  assert.equal(result, false)
  assert.equal(attempt, 3)
})

test('accepts a 404 only when stored onboarding is complete and reports timeouts', async () => {
  assert(await waitForOnboarding(() => true, { fetcher: async () => new Response(null, { status: 404 }) }))
  let time = 0
  await assert.rejects(() => waitForOnboarding(() => false, {
    fetcher: async () => new Response(null, { status: 404 }), timeoutMs: 2000,
    now: () => time, sleep: async (ms) => { time += ms }
  }), /onboarding endpoint not yet available/)
  await assert.rejects(() => waitForOnboarding(() => false, {
    fetcher: async () => new Response(null, { status: 403 })
  }), /HTTP 403/)
})
