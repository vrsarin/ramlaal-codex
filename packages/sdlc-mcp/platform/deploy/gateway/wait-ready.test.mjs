import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import test from 'node:test'

test('gateway readiness precedes virtual server metadata readiness', async (t) => {
  let virtualExists = false
  let routeReady = false
  const paths = []
  const server = createServer((request, response) => {
    paths.push(request.url)
    response.setHeader('content-type', 'application/json')
    if (request.url === '/health') return response.end(JSON.stringify({ status: 'healthy' }))
    if (request.url === '/virtual/sdlc/mcp' && request.method === 'POST') {
      if (!routeReady) {
        response.statusCode = 405
      } else {
        response.statusCode = 401
        response.setHeader('www-authenticate', `Bearer resource_metadata="http://127.0.0.1:${server.address().port}/.well-known/oauth-protected-resource/virtual/sdlc/mcp"`)
      }
      return response.end('{}')
    }
    const root = '/.well-known/oauth-protected-resource'
    const isVirtual = request.url === `${root}/virtual/sdlc/mcp`
    if (request.url !== root && !(isVirtual && virtualExists)) {
      response.statusCode = 404
      return response.end(JSON.stringify({ detail: 'not found' }))
    }
    return response.end(JSON.stringify({
      resource: `http://127.0.0.1:${server.address().port}${isVirtual ? '/virtual/sdlc/mcp' : ''}`,
      authorization_servers: ['https://auth.localhost/realms/sdlc']
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const env = {
    ...process.env, SDLC_HTTPS: 'false', GATEWAY_HOSTNAME: `127.0.0.1:${server.address().port}`,
    KEYCLOAK_HOSTNAME: 'auth.localhost', KEYCLOAK_REALM: 'sdlc'
  }
  async function run(...args) {
    const child = spawn(process.execPath, [new URL('./wait-ready.mjs', import.meta.url).pathname, ...args], { env })
    let output = ''
    child.stdout.on('data', (data) => { output += data })
    child.stderr.on('data', (data) => { output += data })
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    assert.equal(code, 0, output)
  }
  await run()
  assert(paths.includes('/.well-known/oauth-protected-resource'))
  assert(!paths.includes('/.well-known/oauth-protected-resource/virtual/sdlc/mcp'))
  virtualExists = true
  const timer = setTimeout(() => { routeReady = true }, 200)
  t.after(() => clearTimeout(timer))
  await run('virtual')
  assert(paths.includes('/.well-known/oauth-protected-resource/virtual/sdlc/mcp'))
  assert(paths.filter((path) => path === '/virtual/sdlc/mcp').length >= 2, 'Must wait for the authenticated route')
})
