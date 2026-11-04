#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function homeVolumeNames(config) {
  return ['home-assistant-data', 'home-assistant-oidc', 'step-ca-data', 'step-ca-secrets', 'step-ca-public'].map((key) => {
    const volume = config.volumes?.[key]
    if (volume?.external !== true || typeof volume.name !== 'string' ||
        !new RegExp(`^[a-z0-9][a-z0-9_.-]*_${key}$`).test(volume.name)) {
      throw new Error(`Invalid external Home Assistant volume ${key}`)
    }
    return volume.name
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync(0, 'utf8'))
  for (const name of homeVolumeNames(config)) {
    execFileSync('docker', ['volume', 'create', name], { stdio: 'ignore' })
    console.log(`Home Assistant persistent volume ready: ${name}`)
  }
}
