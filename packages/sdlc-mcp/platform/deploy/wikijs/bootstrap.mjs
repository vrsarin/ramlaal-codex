import { configureMcpGroup } from './mcp-permission.mjs'

const baseUrl = 'http://wikijs:3000/_api'
const hostname = process.env.WIKIJS_HOSTNAME
const email = process.env.WIKIJS_ADMIN_EMAIL
const password = process.env.WIKIJS_ADMIN_PASSWORD
const oidcClientId = process.env.WIKIJS_OIDC_CLIENT_ID
const oidcClientSecret = process.env.WIKIJS_OIDC_CLIENT_SECRET
const keycloakHostname = process.env.KEYCLOAK_HOSTNAME
const keycloakRealm = process.env.KEYCLOAK_REALM
const dbName = process.env.WIKIJS_DB_NAME
const dbUser = process.env.WIKIJS_DB_USER
const dbPassword = process.env.WIKIJS_DB_PASSWORD
if (!hostname || !email || !password || !oidcClientId || !oidcClientSecret || !keycloakHostname || !keycloakRealm || !dbName || !dbUser || !dbPassword) {
  throw new Error('Wiki.js hostname, database, administrator and OIDC environment variables are required.')
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      Host: hostname,
      ...options.headers
    }
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} failed (${response.status}): ${JSON.stringify(body)}`)
  }
  return { response, body }
}

async function synchronizeAdminPassword(localStrategy) {
  const [{ default: bcrypt }, { default: pg }] = await Promise.all([
    import('/wiki/backend/node_modules/bcryptjs/index.js'),
    import('/wiki/backend/node_modules/pg/lib/index.js')
  ])
  const client = new pg.Client({
    host: 'db',
    port: 5432,
    database: dbName,
    user: dbUser,
    password: dbPassword
  })
  await client.connect()
  try {
    const result = await client.query(
      'SELECT id, auth FROM users WHERE lower(email) = lower($1)',
      [email]
    )
    if (result.rowCount === 0) {
      const administrators = await client.query(
        'SELECT id, auth FROM users WHERE "isSystem" = false ORDER BY "createdAt"'
      )
      if (administrators.rowCount !== 1) {
        throw new Error(`Could not uniquely identify the Wiki.js administrator; found ${administrators.rowCount} non-system users.`)
      }
      result.rows.push(administrators.rows[0])
    } else if (result.rowCount !== 1) {
      throw new Error(`Expected one Wiki.js administrator with email ${email}, found ${result.rowCount}.`)
    }
    const user = result.rows[0]
    const auth = user.auth ?? {}
    auth[localStrategy] = {
      ...(auth[localStrategy] ?? {}),
      password: await bcrypt.hash(password, 12),
      restrictLogin: false
    }
    await client.query(
      'UPDATE users SET auth = $1::jsonb, email = $3, "isVerified" = true WHERE id = $2',
      [JSON.stringify(auth), user.id, email.toLowerCase()]
    )
  } finally {
    await client.end()
  }
}

async function siteHasPages(siteId) {
  const { default: pg } = await import('/wiki/backend/node_modules/pg/lib/index.js')
  const client = new pg.Client({
    host: 'db',
    port: 5432,
    database: dbName,
    user: dbUser,
    password: dbPassword
  })
  await client.connect()
  try {
    const result = await client.query('SELECT 1 FROM pages WHERE "siteId" = $1 LIMIT 1', [siteId])
    return result.rowCount > 0
  } finally {
    await client.end()
  }
}

const bootstrapPath = `/bootstrap?hostname=${encodeURIComponent(hostname)}`
const { body: bootstrap } = await request(bootstrapPath)
const site = bootstrap.site
if (!site?.id) {
  throw new Error('Wiki.js did not return a default site.')
}

const { body: strategies } = await request(`/sites/${site.id}/auth/strategies`)
const configuredOidc = strategies.find(
  (strategy) =>
    strategy.activeStrategy?.strategy?.key === 'oidc' &&
    strategy.activeStrategy?.displayName === 'Keycloak' &&
    strategy.isVisible
)
const hostnameConfigured = site.hostname === hostname
const pagesExist = await siteHasPages(site.id)
// A disabled MCP endpoint answers 404, so this also reruns setup on wikis configured before it existed.
const mcpEnabled = (await fetch(`http://${hostname}/_mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status !== 404
const coreConfigured = hostnameConfigured && configuredOidc && pagesExist && mcpEnabled

const localStrategy = strategies.find(
  (strategy) => strategy.activeStrategy?.strategy?.key === 'local'
)?.id
if (!localStrategy) {
  throw new Error('Wiki.js did not return its local authentication strategy.')
}

if (!coreConfigured) await synchronizeAdminPassword(localStrategy)

const { response: loginResponse, body: login } = await request(
  `/sites/${site.id}/auth/login`,
  {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategyId: localStrategy, username: email, password })
  }
)
if (!login.authenticated) {
  throw new Error(`Wiki.js administrator login did not complete: ${JSON.stringify(login)}`)
}

const cookies = loginResponse.headers
  .getSetCookie()
  .map((value) => value.split(';', 1)[0])
  .join('; ')
if (!cookies) {
  throw new Error('Wiki.js administrator login did not return a session cookie.')
}

// Wiki.js derives OAuth callback URLs from the request protocol. In the HTTPS profile the public
// listener is Caddy while Wiki.js itself receives HTTP, so it must trust Caddy's X-Forwarded-Proto.
// The container is reachable only on the private Compose network; direct host access is not exposed.
const { body: security } = await request('/system/security', { headers: { Cookie: cookies } })
if (security.trustProxy !== true) {
  await request('/system/security', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookies },
    body: JSON.stringify({ trustProxy: true })
  })
}
const { body: verifiedSecurity } = await request('/system/security', { headers: { Cookie: cookies } })
if (verifiedSecurity.trustProxy !== true) {
  throw new Error('Wiki.js proxy trust verification failed; HTTPS OAuth callbacks would be incorrect.')
}

if (!pagesExist) {
  await request(`/sites/${site.id}/pages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookies
    },
    body: JSON.stringify({
      path: 'home',
      title: 'Welcome',
      description: 'Forgejo and Wiki.js development workspace',
      editor: 'markdown',
      content: '# Welcome\n\nThe Forgejo and Wiki.js development workspace is ready.',
      render: '<h1>Welcome</h1><p>The Forgejo and Wiki.js development workspace is ready.</p>',
      locale: 'en',
      publishState: 'published',
      isBrowsable: true,
      isSearchable: true
    })
  })
}

let oidcStrategyId = configuredOidc?.id
if (!oidcStrategyId) {
  const { body: configuredStrategies } = await request('/authentication/strategies', {
    headers: { Cookie: cookies }
  })
  const existingOidc = configuredStrategies.find(
    (strategy) => strategy.module === 'oidc' && strategy.displayName === 'Keycloak'
  )
  const oidcConfig = {
    clientId: oidcClientId,
    clientSecret: oidcClientSecret,
    issuer: `https://${keycloakHostname}/realms/${keycloakRealm}`,
    useDiscovery: true,
    scopes: 'openid profile email',
    requireVerifiedEmail: true
  }

  if (existingOidc) {
    oidcStrategyId = existingOidc.id
    await request(`/authentication/strategies/${oidcStrategyId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookies
      },
      body: JSON.stringify({
        displayName: 'Keycloak',
        isEnabled: true,
        registration: true,
        config: oidcConfig
      })
    })
  } else {
    const { body: createdOidc } = await request('/authentication/strategies', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookies
      },
      body: JSON.stringify({
        module: 'oidc',
        displayName: 'Keycloak',
        isEnabled: true,
        registration: true,
        allowedEmailRegex: '',
        autoEnrollGroups: [],
        config: oidcConfig
      })
    })
    oidcStrategyId = createdOidc.id
  }
}

if (!oidcStrategyId) throw new Error('Wiki.js Keycloak OIDC strategy was not created.')
await configureMcpGroup(request, cookies, oidcStrategyId)
if (coreConfigured) {
  console.log(`Wiki.js hostname ${hostname}, Keycloak OIDC and MCP group mapping are configured.`)
  process.exit(0)
}

const authStrategies = [...(site.authStrategies ?? [])]
if (!authStrategies.some((strategy) => strategy.id === oidcStrategyId)) {
  authStrategies.push({ id: oidcStrategyId, order: authStrategies.length, isVisible: true })
} else {
  for (const strategy of authStrategies) {
    if (strategy.id === oidcStrategyId) strategy.isVisible = true
  }
}

await request(`/sites/${site.id}`, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    Cookie: cookies
  },
  body: JSON.stringify({ hostname, authStrategies })
})

const { body: configuredBootstrap } = await request(bootstrapPath)
const configuredSite = configuredBootstrap.site
if (configuredSite.hostname !== hostname) {
  throw new Error(`Wiki.js hostname verification failed: expected ${hostname}, got ${configuredSite.hostname}`)
}

const { body: verifiedStrategies } = await request(`/sites/${site.id}/auth/strategies`)
if (!verifiedStrategies.some(
  (strategy) => strategy.id === oidcStrategyId && strategy.isVisible && strategy.activeStrategy?.strategy?.key === 'oidc'
)) {
  throw new Error('Wiki.js Keycloak OIDC strategy verification failed.')
}

// Personal access tokens, and so the MCP endpoint, only authenticate while the API is on.
await request('/system/api', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Cookie: cookies },
  body: JSON.stringify({ isEnabled: true })
})

// The official MCP endpoint is read-only here: callers must bring their own personal access token,
// and only the discovery and read tool groups are enabled. Write groups stay off until a workflow
// needs them.
await request('/system/mcp', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Cookie: cookies },
  body: JSON.stringify({
    isEnabled: true,
    allowAnonymous: false,
    tools: { discover: true, pages: true, history: true, glossary: true, comments: false, suggest: false, edit: false, assets: false, destructive: false }
  })
})

console.log(`Wiki.js hostname ${hostname}, Keycloak OIDC and initial content are configured.`)
