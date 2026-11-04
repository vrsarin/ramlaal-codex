import { onboardingComplete } from './onboarding-status.mjs'

export async function waitForOnboarding(storedOnboarding, {
  fetcher = fetch, url = 'https://home.localhost', timeoutMs = 120_000, now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const deadline = now() + timeoutMs
  let last = 'not reachable'
  while (now() < deadline) {
    let response
    try {
      response = await fetcher(`${url}/api/onboarding`, { signal: AbortSignal.timeout(3000) })
    } catch (error) {
      if (!(error instanceof TypeError) && error?.name !== 'TimeoutError') throw error
      last = 'connection unavailable'
      await sleep(2000)
      continue
    }
    if (response.status === 404) {
      if (await storedOnboarding()) return true
      last = 'onboarding endpoint not yet available'
      await sleep(2000)
      continue
    }
    if ([502, 503, 504].includes(response.status)) {
      last = `HTTP ${response.status}`
      await sleep(2000)
      continue
    }
    if (!response.ok) throw new Error(`Home Assistant onboarding check failed (HTTP ${response.status})`)
    return onboardingComplete(await response.json())
  }
  throw new Error(`Home Assistant onboarding did not become ready: ${last}`)
}
