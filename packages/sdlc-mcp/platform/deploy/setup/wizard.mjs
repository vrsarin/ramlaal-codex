#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { createInterface, emitKeypressEvents } from 'node:readline'
import { stdin, stdout } from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setupStack } from './runner.mjs'
import { supportsComposeOverride } from './prerequisites.mjs'
import { waitForOnboarding } from '../homeassistant/wait-onboarding.mjs'
import { installCurrentUserCaTrust } from './user-ca-trust.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

const descriptions = {
  KEYCLOAK_ADMIN_PASSWORD: 'Keycloak administrator',
  KEYCLOAK_SSO_ADMIN_PASSWORD: 'Keycloak SSO administrator',
  KEYCLOAK_TEST_PASSWORD: 'Keycloak developer',
  FORGEJO_ADMIN_PASSWORD: 'Forgejo local administrator',
  WIKIJS_ADMIN_PASSWORD: 'Wiki.js local administrator'
}

export function line(question) {
  return new Promise((resolve, reject) => {
    stdin.resume()
    const rl = createInterface({ input: stdin, output: stdout })
    let answered = false
    rl.once('close', () => { if (!answered) reject(new Error('Setup cancelled')) })
    rl.question(question, (value) => { answered = true; rl.close(); resolve(value) })
  })
}

export async function password(label) {
  if (!stdin.isTTY) throw new Error('Password entry requires an interactive terminal')
  emitKeypressEvents(stdin)
  stdin.setRawMode(true)
  stdin.resume()
  stdout.write(`${label}: `)
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (error) => {
      stdin.off('keypress', onKey)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onKey = (character, key) => {
      if (key?.ctrl && (key.name === 'c' || key.name === 'd')) return finish(new Error('Setup cancelled'))
      if (key?.name === 'return' || key?.name === 'enter') return finish()
      if (key?.name === 'backspace') {
        if (value) { value = Array.from(value).slice(0, -1).join(''); stdout.write('\b \b') }
      } else if (character && !key?.ctrl && !key?.meta && !/[\x00-\x1f\x7f]/.test(character)) {
        value += character
        stdout.write('*')
      }
    }
    stdin.on('keypress', onKey)
  })
}

async function passwords() {
  const result = {}
  console.log('\nChoose local user passwords (at least 12 characters). They are not written to .env.')
  for (const [name, description] of Object.entries(descriptions)) {
    const value = await password(`${description} password`)
    const confirm = await password(`Confirm ${description} password`)
    if (value !== confirm) throw new Error(`${description} passwords do not match`)
    result[name] = value
  }
  return result
}

async function onboarding(storedOnboarding, options) {
  for (;;) {
    if (await waitForOnboarding(storedOnboarding, options)) return true
    console.log(`\nOpen ${options.url} and complete Home Assistant owner onboarding.`)
    const answer = await line('Press Enter when complete, or type SKIP to finish later: ')
    if (answer.trim().toUpperCase() === 'SKIP') return false
  }
}

async function trustCa(localCa) {
  console.log('\nHTTPS uses a project-owned local certificate authority.')
  console.log(`CA SHA-256 fingerprint: ${localCa.fingerprint}`)
  const answer = await line('Trust this CA in your current macOS login keychain? Type TRUST to continue, or SKIP: ')
  if (answer.trim().toUpperCase() !== 'TRUST') {
    console.log('CA trust skipped. Browsers and VS Code will reject the local HTTPS endpoints until you install it.')
    return false
  }
  const result = installCurrentUserCaTrust(root, localCa.path, localCa.fingerprint)
  console.log(result.installed ? 'Installed project CA trust for the current user.' : 'Project CA trust is already installed and owned by this project.')
  return true
}

async function configureMcp(check) {
  for (;;) {
    const issue = check()
    if (!issue) return true
    console.log(`\n${issue}`)
    console.log('In Home Assistant, open Settings > Devices & services > Add integration > MCP Server.')
    console.log('After adding it, open its Configure options: disable all LLM APIs, select Assist, and allow non-admin users.')
    console.log('Expose only the entities you intend to use.')
    const answer = await line('Press Enter after configuring MCP Server, or type SKIP to finish later: ')
    if (answer.trim().toUpperCase() === 'SKIP') return false
  }
}

async function main() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('The setup wizard requires an interactive terminal')
  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) throw new Error('Node.js 22 or later is required')
  let composeVersion
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' })
    composeVersion = execFileSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    throw new Error('Docker Desktop/Engine and Docker Compose must be installed and running')
  }
  if (!supportsComposeOverride(composeVersion)) throw new Error('Docker Compose 2.24.4 or later is required')
  for (const host of ['git.localhost', 'wiki.localhost', 'login.localhost', 'home.localhost', 'mcp-gateway.localhost', 'forgejo-mcp.localhost', 'sdlc-mcp.localhost']) {
    const addresses = await lookup(host, { all: true })
    if (!addresses.length || addresses.some(({ address }) => address !== '127.0.0.1' && address !== '::1')) {
      throw new Error(`${host} must resolve to loopback; configure local hostname resolution and retry`)
    }
  }
  console.log('SDLC local setup — existing data will not be deleted.')
  const result = await setupStack({ getPasswords: passwords, onboard: onboarding, configureMcp, trustCa })
  if (!result.complete) {
    process.exitCode = 2
    return
  }
  console.log('\nTo use Home Assistant tools, add your Keycloak account to both mcp-users and home-assistant-users.')
  console.log('Start the sdlcGateway server in VS Code, run connect_home_assistant, and complete its consent link.')
  console.log('Use connect_forgejo and connect_wikijs to authorize those providers when needed.')
  console.log('Keep the dedicated automation account outside home-assistant-users so access checks remain valid.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Setup failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    process.exitCode = 1
  })
}
