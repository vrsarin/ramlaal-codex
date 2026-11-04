export function gatewayBase(env = process.env) {
  const flag = env.SDLC_HTTPS
  if (flag !== undefined && flag !== '' && flag !== 'true' && flag !== 'false') {
    throw new Error('SDLC_HTTPS must be true or false')
  }
  const host = env.GATEWAY_HOSTNAME || 'mcp-gateway.localhost'
  const url = new URL(`${flag === 'false' ? 'http' : 'https'}://${host}`)
  const local = /^(?:[A-Za-z0-9-]+\.)*localhost$/.test(url.hostname) ||
    url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (!local || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Gateway hostname must be a localhost hostname')
  }
  return url.origin
}
