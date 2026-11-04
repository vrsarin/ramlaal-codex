import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForOidc } from './wait-oidc.mjs'

test('waits for OIDC discovery even after the container is running', async () => {
  let time = 0
  let calls = 0
  await waitForOidc('http://auth.localhost/realms/sdlc', {
    now: () => time, sleep: async (ms) => { time += ms },
    fetcher: async () => ++calls === 1 ? new Response('', { status: 503 }) : Response.json({ issuer: 'http://auth.localhost/realms/sdlc' })
  })
  assert.equal(calls, 2)
})

test('rejects a wrong issuer and reports timeouts', async () => {
  await assert.rejects(() => waitForOidc('http://auth.localhost/realms/sdlc', {
    fetcher: async () => Response.json({ issuer: 'http://other/realms/sdlc' })
  }), /unexpected issuer/)
  let time = 0
  await assert.rejects(() => waitForOidc('http://auth.localhost/realms/sdlc', {
    timeoutMs: 2000, now: () => time, sleep: async (ms) => { time += ms },
    fetcher: async () => new Response('', { status: 503 })
  }), /HTTP 503/)
})
