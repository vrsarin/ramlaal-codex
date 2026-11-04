export async function waitForRegistrationScan(path, {
  getScan, getServer, timeoutMs = 120_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  const deadline = now() + timeoutMs
  let scan
  while (now() < deadline) {
    scan = await getScan()
    if (scan) break
    await sleep(2000)
  }
  if (!scan) throw new Error(`${path}: initial registration scan did not finish`)
  if (scan.is_safe !== true) {
    while (now() < deadline) {
      const server = await getServer()
      if (server.tags?.includes('security-pending') && server.is_enabled === false) return scan
      await sleep(2000)
    }
    throw new Error(`${path}: initial failed scan did not finish applying its security block`)
  }
  if (scan.scan_failed !== false) throw new Error(`${path}: initial scan has an inconsistent result`)
  return scan
}
