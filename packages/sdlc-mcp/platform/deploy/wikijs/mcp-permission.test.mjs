import assert from 'node:assert/strict'
import test from 'node:test'
import { configureMcpGroup } from './mcp-permission.mjs'

function fixture() {
  const state = {
    strategy: { config: { mapGroups: false, groupsClaim: 'groups', unassignMissingGroups: false, other: 'preserved' } },
    groups: [],
    changes: []
  }
  const request = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined
    state.changes.push(`${options.method ?? 'GET'} ${path}`)
    if (path === '/authentication/strategies/strategy') {
      if (options.method === 'PUT') Object.assign(state.strategy.config, body.config)
      return { body: structuredClone(state.strategy) }
    }
    if (path === '/groups' && options.method === 'POST') {
      const id = `group-${state.groups.length + 1}`
      state.groups.push({ id, name: body.name, permissions: ['default'], rules: [{ id: 'default' }] })
      return { body: { ok: true, id } }
    }
    if (path === '/groups') return { body: structuredClone(state.groups) }
    if (path.startsWith('/groups/')) {
      const group = state.groups.find((entry) => entry.id === path.slice('/groups/'.length))
      if (!group) throw new Error(`Unknown group: ${path}`)
      if (options.method === 'PUT') Object.assign(group, body)
      return { body: structuredClone(group) }
    }
    throw new Error(`Unexpected request: ${path}`)
  }
  return { state, request }
}

test('fresh setup creates narrow MCP and full-control local developer groups', async () => {
  const f = fixture()
  await configureMcpGroup(f.request, 'cookie', 'strategy')
  assert.deepEqual(f.state.groups, [
    { id: 'group-1', name: 'mcp-users', permissions: ['use:mcp'], rules: [] },
    { id: 'group-2', name: 'developers', permissions: ['manage:system'], rules: [] }
  ])
  assert.deepEqual(f.state.strategy.config, { mapGroups: true, groupsClaim: 'wikijs_mcp_group_membership', unassignMissingGroups: false, other: 'preserved' })
  f.state.changes.length = 0
  await configureMcpGroup(f.request, 'cookie', 'strategy')
  assert(!f.state.changes.some((change) => change.startsWith('POST') || change.startsWith('PUT')), 'reconciliation must be idempotent')
})

test('conflicting group permissions or an existing group-mapping policy are not overwritten', async () => {
  const f = fixture()
  f.state.groups.push({ id: 'group-1', name: 'mcp-users', permissions: ['manage:system'], rules: [] })
  await assert.rejects(() => configureMcpGroup(f.request, 'cookie', 'strategy'), /unexpected permissions/)
  assert(!f.state.changes.some((change) => change.startsWith('PUT')))
  const other = fixture()
  other.state.strategy.config = { mapGroups: true, groupsClaim: 'existing', unassignMissingGroups: false }
  await assert.rejects(() => configureMcpGroup(other.request, 'cookie', 'strategy'), /different OIDC group mapping/)
  assert(!other.state.changes.some((change) => change.startsWith('POST') || change.startsWith('PUT')))
})
