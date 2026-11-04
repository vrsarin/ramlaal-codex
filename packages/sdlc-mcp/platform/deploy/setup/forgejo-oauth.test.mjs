import assert from 'node:assert/strict'
import test from 'node:test'
import { registerForgejoOAuth } from './forgejo-oauth.mjs'

const options = { origin: 'https://git.localhost', username: 'admin', password: 'test-password', redirectUrl: 'http://localhost/oauth/forgejo/callback' }
const json = (body) => new Response(JSON.stringify(body))

test('creates an OAuth client without deleting existing applications', async () => {
  const methods = []
  const result = await registerForgejoOAuth({ ...options, fetcher: async (_url, init) => {
    methods.push(init.method || 'GET')
    return json(init.method === 'POST' ? { client_id: 'id', client_secret: 'secret' } : [])
  } })
  assert.deepEqual(result, { clientId: 'id', clientSecret: 'secret' })
  assert.deepEqual(methods, ['GET', 'POST'])
})

test('reuses matching credentials and refuses ambiguous existing apps', async () => {
  const apps = [{ name: 'Forgejo workflow MCP', client_id: 'id', redirect_uris: [options.redirectUrl] }]
  const fetcher = async (_url, init) => { assert.notEqual(init.method, 'DELETE'); return json(apps) }
  assert.deepEqual(await registerForgejoOAuth({ ...options, fetcher, clientId: 'id', clientSecret: 'secret' }), { clientId: 'id', clientSecret: 'secret' })
  await assert.rejects(() => registerForgejoOAuth({ ...options, fetcher }), /resolve it explicitly/)
  await assert.rejects(() => registerForgejoOAuth({ ...options, fetcher, clientId: 'different', clientSecret: 'secret' }), /refusing to replace/)
})
