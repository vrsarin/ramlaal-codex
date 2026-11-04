export function managedOidcProvider(response) {
  if (!response || !Array.isArray(response.providers)) {
    throw new Error('Home Assistant returned an invalid provider list')
  }
  const providers = response.providers.filter((provider) => provider?.type === 'auth_oidc' && provider.id === 'default')
  if (providers.length !== 1) throw new Error('Expected exactly one managed Home Assistant OIDC provider')
  return providers[0]
}
