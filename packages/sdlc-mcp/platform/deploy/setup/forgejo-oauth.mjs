const appName = 'Forgejo workflow MCP'

export async function registerForgejoOAuth({ origin, username, password, redirectUrl, clientId, clientSecret, fetcher = fetch }) {
  const provider = new URL(origin)
  if (provider.protocol !== 'https:' || !/^(?:[A-Za-z0-9-]+\.)*localhost$/.test(provider.hostname) || provider.pathname !== '/') throw new Error('Forgejo must use a localhost HTTPS origin')
  if (!username || !password) throw new Error('Forgejo administrator credentials are required')
  const redirect = new URL(redirectUrl)
  if (redirect.protocol !== 'http:' || redirect.hostname !== 'localhost' || redirect.pathname !== '/oauth/forgejo/callback' ||
      redirect.username || redirect.password || redirect.search || redirect.hash) throw new Error('Invalid local Forgejo OAuth redirect')
  const base = `${provider.origin}/api/v1`
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  async function request(path, options = {}) {
    const response = await fetcher(`${base}${path}`, {
      ...options, headers: { authorization, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) throw new Error(`Forgejo OAuth registration failed (HTTP ${response.status})`)
    return response.json()
  }
  const apps = await request('/user/applications/oauth2')
  if (!Array.isArray(apps)) throw new Error('Forgejo returned an invalid OAuth application list')
  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) throw new Error('The saved Forgejo OAuth client is incomplete')
    if (!apps.some((app) => app.client_id === clientId && Array.isArray(app.redirect_uris) && app.redirect_uris.includes(redirectUrl))) {
      throw new Error('The saved Forgejo OAuth application does not match; refusing to replace existing applications')
    }
    return { clientId, clientSecret }
  }
  if (apps.some((app) => app.name === appName)) {
    throw new Error('A Forgejo OAuth application already exists without its saved secret; resolve it explicitly')
  }
  const result = await request('/user/applications/oauth2', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: appName, redirect_uris: [redirectUrl], confidential_client: true })
  })
  if (typeof result.client_id !== 'string' || !result.client_id || typeof result.client_secret !== 'string' || !result.client_secret) {
    throw new Error('Forgejo did not return OAuth application credentials')
  }
  return { clientId: result.client_id, clientSecret: result.client_secret }
}
