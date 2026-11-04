import assert from 'node:assert/strict'
import test from 'node:test'
import { hasGatewayHttpsResources, hasMcpTlsResources, teardownMode, teardownPlan, validateMcpTlsVolumes, volumeStateMatches } from './teardown.mjs'

const volumes = Object.fromEntries(
  ['home-assistant-data', 'home-assistant-oidc', 'step-ca-data', 'step-ca-secrets', 'step-ca-public']
    .map((key) => [key, { external: true, name: `project_${key}` }])
)
const config = { name: 'project', services: { gateway: {} }, volumes, networks: { frontend: { name: 'project_frontend' } } }
const container = (service, overrides = {}) => ({
  Id: 'a'.repeat(64), Config: { Labels: { 'com.docker.compose.project': 'project', 'com.docker.compose.service': service, 'com.docker.compose.oneoff': 'False' } },
  State: { Running: false }, ...overrides
})

test('teardown targets only project-scoped external volumes and known orphans', () => {
  const network = { Id: 'b'.repeat(64), Name: 'project_everything-net', Labels: { 'com.docker.compose.project': 'project', 'com.docker.compose.network': 'everything-net' } }
  const plan = teardownPlan(config, 'project', [container('gateway'), container('mcp-everything')], [network])
  assert.equal(plan.externalVolumes.length, 5)
  assert.deepEqual(plan.orphans, [{ id: 'a'.repeat(64), running: false }])
  assert.deepEqual(plan.orphanNetworks, [{ id: 'b'.repeat(64), name: 'everything-net' }])
  const legacyProxy = teardownPlan(config, 'project', [container('home-assistant-upstream-tls')])
  assert.equal(legacyProxy.orphans.length, 1)
})

test('teardown refuses mismatched projects, foreign volumes and unknown services', () => {
  assert.throws(() => teardownPlan(config, 'other', []), /project/)
  assert.throws(() => teardownPlan({ ...config, volumes: { ...volumes, 'step-ca-data': { external: true, name: 'other_step-ca-data' } } }, 'project', []), /volume/)
  assert.throws(() => teardownPlan(config, 'project', [container('unknown')]), /Unknown Compose service/)
  assert.throws(() => teardownPlan({ ...config, volumes: { ...volumes, 'postgres-data': { name: 'unrelated' } } }, 'project', []), /Volume/)
  assert.throws(() => teardownPlan({ ...config, networks: { frontend: { name: 'unrelated' } } }, 'project', []), /Network/)
  assert.throws(() => teardownPlan(config, 'project', [], [{ Id: 'b'.repeat(64), Name: 'project_other', Labels: { 'com.docker.compose.project': 'project', 'com.docker.compose.network': 'other' } }]), /Unknown Compose network/)
  assert.throws(() => teardownPlan(config, 'project', [container('gateway', { Config: { Labels: { 'com.docker.compose.project': 'other' } } })]), /Unexpected container/)
  assert.throws(() => teardownPlan(config, 'project', [container('gateway', { Config: { Labels: { 'com.docker.compose.project': 'project', 'com.docker.compose.service': 'gateway', 'com.docker.compose.oneoff': 'True' } } })]), /one-off/)
})

test('teardown refuses volumes replaced while awaiting confirmation', () => {
  const expected = [{ Name: 'project_data', CreatedAt: 'original' }]
  assert.equal(volumeStateMatches(expected, [{ Name: 'project_data', CreatedAt: 'original' }]), true)
  assert.equal(volumeStateMatches(expected, [{ Name: 'project_data', CreatedAt: 'replacement' }]), false)
  assert.equal(volumeStateMatches(expected, []), false)
  assert.equal(volumeStateMatches(expected, [{ Name: 'project_other', CreatedAt: 'original' }]), false)
})

test('teardown distinguishes runtime and legacy stacks and rejects ambiguous credentials', () => {
  const keeper = container('sdlc-runtime-keeper')
  assert.equal(teardownMode(undefined, [keeper]), 'runtime')
  assert.equal(teardownMode(undefined, []), 'runtime')
  assert.equal(teardownMode({}, [container('gateway')]), 'legacy')
  assert.throws(() => teardownMode({}, [keeper]), /ambiguous teardown/)
})

test('teardown detects certificate-manager resources and rejects foreign volumes', () => {
  assert.equal(hasMcpTlsResources('project', [], []), false)
  assert.equal(hasMcpTlsResources('project', [container('mcp-cert-manager')], []), true)
  assert.equal(hasMcpTlsResources('project', [], ['project_forgejo-mcp-cert']), true)
  assert.equal(hasGatewayHttpsResources('project', [], ['project_gateway-public-cert-data']), true)
  assert.equal(hasGatewayHttpsResources('project', [], []), false)
  assert.doesNotThrow(() => validateMcpTlsVolumes('project', [{
    Name: 'project_forgejo-mcp-cert',
    Labels: { 'com.docker.compose.project': 'project', 'com.docker.compose.volume': 'forgejo-mcp-cert' }
  }]))
  assert.throws(() => validateMcpTlsVolumes('project', [{ Name: 'project_forgejo-mcp-cert', Labels: {} }]), /not managed/)
})
