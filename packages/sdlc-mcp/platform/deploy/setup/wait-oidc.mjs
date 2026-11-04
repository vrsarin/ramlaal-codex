export async function waitForOidc(issuer, {
  fetcher = fetch, timeoutMs = 180_000, now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const expected = issuer.replace(/\/$/, '')
  const deadline = now() + timeoutMs
  let last = 'not reachable'
  while (now() < deadline) {
    let response
    try {
      response = await fetcher(`${expected}/.well-known/openid-configuration`, {
        redirect: 'error', signal: AbortSignal.timeout(3000)
      })
    } catch (error) {
      if (!(error instanceof TypeError) && error?.name !== 'TimeoutError') throw error
      last = 'connection unavailable'
      await sleep(2000)
      continue
    }
    if (!response.ok) {
      last = `HTTP ${response.status}`
      await sleep(2000)
      continue
    }
    const metadata = await response.json()
    if (metadata.issuer !== expected) throw new Error('Keycloak returned an unexpected issuer')
    return
  }
  throw new Error(`Keycloak OIDC discovery did not become ready: ${last}`)
}
