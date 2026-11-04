const CLAIM = 'wikijs_mcp_group_membership'
const GROUPS = [
  { name: 'mcp-users', permissions: ['use:mcp'] },
  { name: 'developers', permissions: ['manage:system'] }
]

function sameStrings(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && expected.every((value) => actual.includes(value))
}

/** Reconcile the two Keycloak-managed local groups without changing unrelated groups. */
export async function configureMcpGroup(request, cookie, strategyId) {
  const headers = { Cookie: cookie }
  const { body: strategy } = await request(`/authentication/strategies/${strategyId}`, { headers })
  const config = strategy.config ?? {}
  if ((config.mapGroups === true && config.groupsClaim !== CLAIM) || config.unassignMissingGroups === true) {
    throw new Error('Wiki.js already uses a different OIDC group mapping; configure the MCP group manually.')
  }
  const { body: groups } = await request('/groups', { headers })
  for (const managed of GROUPS) {
    const matches = groups.filter((group) => group.name === managed.name)
    if (matches.length > 1) throw new Error(`Multiple Wiki.js ${managed.name} groups exist.`)
    let groupId = matches[0]?.id
    if (!groupId) {
      const { body: created } = await request('/groups', {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: managed.name })
      })
      if (!created.ok || !created.id) throw new Error(`Wiki.js ${managed.name} group creation failed.`)
      groupId = created.id
      await request(`/groups/${groupId}`, {
        method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions: managed.permissions, rules: [] })
      })
    }
    const { body: group } = await request(`/groups/${groupId}`, { headers })
    if (!sameStrings(group.permissions, managed.permissions) || !Array.isArray(group.rules) || group.rules.length !== 0) {
      throw new Error(`Wiki.js ${managed.name} group has unexpected permissions or page rules; refusing to change it.`)
    }
  }
  if (config.mapGroups !== true || config.groupsClaim !== CLAIM || config.unassignMissingGroups !== false) {
    await request(`/authentication/strategies/${strategyId}`, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { mapGroups: true, groupsClaim: CLAIM, unassignMissingGroups: false } })
    })
  }
  const { body: verified } = await request(`/authentication/strategies/${strategyId}`, { headers })
  if (verified.config?.mapGroups !== true || verified.config?.groupsClaim !== CLAIM || verified.config?.unassignMissingGroups !== false) {
    throw new Error('Wiki.js MCP group mapping verification failed.')
  }
}
