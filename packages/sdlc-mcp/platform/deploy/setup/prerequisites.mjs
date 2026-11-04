export function supportsComposeOverride(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim())
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  return major > 2 || (major === 2 && (minor > 24 || (minor === 24 && patch >= 4)))
}
