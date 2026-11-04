import assert from 'node:assert/strict'
import test from 'node:test'
import { homeVolumeNames } from './ensure-volumes.mjs'

test('only explicit project-scoped external Home Assistant and Step CA volumes are allowed', () => {
  const config = { volumes: {
    'home-assistant-data': { external: true, name: 'project_home-assistant-data' },
    'home-assistant-oidc': { external: true, name: 'project_home-assistant-oidc' },
    'step-ca-data': { external: true, name: 'project_step-ca-data' },
    'step-ca-secrets': { external: true, name: 'project_step-ca-secrets' },
    'step-ca-public': { external: true, name: 'project_step-ca-public' }
  } }
  assert.deepEqual(homeVolumeNames(config), ['project_home-assistant-data', 'project_home-assistant-oidc', 'project_step-ca-data', 'project_step-ca-secrets', 'project_step-ca-public'])
  assert.throws(() => homeVolumeNames({ volumes: { ...config.volumes, 'home-assistant-data': { external: false, name: 'project_home-assistant-data' } } }))
  assert.throws(() => homeVolumeNames({ volumes: { ...config.volumes, 'home-assistant-data': { external: true, name: 'unrelated' } } }))
})
