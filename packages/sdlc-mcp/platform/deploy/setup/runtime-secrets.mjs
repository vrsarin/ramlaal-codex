import { randomBytes, createHash } from 'node:crypto'
import { closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const runtimeFileName = '.sdlc-runtime'
export function assertNoRuntimeReplacementFiles(directory) {
  if (readdirSync(directory).some((name) => /^\.sdlc-runtime\.[a-f0-9]{24}\.tmp$/.test(name))) {
    throw new Error('A temporary runtime replacement file exists; confirm setup is not running, inspect it, and remove it before proceeding')
  }
}
export const userPasswordNames = [
  'KEYCLOAK_ADMIN_PASSWORD', 'KEYCLOAK_SSO_ADMIN_PASSWORD', 'KEYCLOAK_TEST_PASSWORD',
  'FORGEJO_ADMIN_PASSWORD', 'WIKIJS_ADMIN_PASSWORD'
]
const generatedNames = [
  'POSTGRES_ADMIN_PASSWORD', 'FORGEJO_DB_PASSWORD', 'WIKIJS_DB_PASSWORD', 'KEYCLOAK_DB_PASSWORD',
  'FORGEJO_OIDC_CLIENT_SECRET', 'WIKIJS_OIDC_CLIENT_SECRET', 'MCP_OIDC_CLIENT_SECRET',
  'GATEWAY_MONGO_PASSWORD', 'GATEWAY_SECRET_KEY', 'GATEWAY_MARKER_SECRET', 'GATEWAY_WEB_CLIENT_SECRET',
  'GATEWAY_M2M_CLIENT_SECRET', 'GATEWAY_DISCOVERY_CLIENT_SECRET', 'GATEWAY_HOME_DISCOVERY_PASSWORD',
  'GATEWAY_BOOTSTRAP_TOKEN', 'STEP_CA_PASSWORD', 'STEP_CA_PROVISIONER_PASSWORD'
]
const encryptionNames = ['FORGEJO_TOKEN_ENCRYPTION_KEY', 'WIKIJS_TOKEN_ENCRYPTION_KEY', 'HOMEASSISTANT_TOKEN_ENCRYPTION_KEY']
export const requiredSecretNames = [...userPasswordNames, ...generatedNames, ...encryptionNames]

export function newRuntimeSecrets(passwords) {
  const values = {}
  for (const name of userPasswordNames) {
    const value = passwords[name]
    if (typeof value !== 'string' || value.length < 12 || /[\r\n\0]/.test(value)) {
      throw new Error(`${name} must be at least 12 characters and contain no line breaks`)
    }
    values[name] = value
  }
  for (const name of generatedNames) values[name] = randomBytes(48).toString('base64url')
  for (const name of encryptionNames) values[name] = randomBytes(32).toString('base64')
  return values
}

export function runtimeContents(values) {
  return Object.entries(values).map(([name, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) {
      throw new Error(`Invalid runtime setting: ${name}`)
    }
    const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '$$')
    return `${name}="${escaped}"`
  }).join('\n') + '\n'
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex')
}

export function createRuntimeFile(directory, values) {
  const path = join(directory, runtimeFileName)
  const content = runtimeContents(values)
  const fd = openSync(path, 'wx', 0o600)
  let stat
  let failure
  try {
    stat = fstatSync(fd)
    fchmodSync(fd, 0o600)
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
  } catch (error) {
    failure = error
  } finally {
    closeSync(fd)
  }
  if (failure) {
    if (!stat) throw new AggregateError([failure], 'Runtime secret file creation failed; inspect the temporary file')
    try {
      const current = lstatSync(path)
      if (current.isFile() && !current.isSymbolicLink() && current.dev === stat.dev && current.ino === stat.ino) {
        unlinkSync(path)
      } else {
        throw new Error('Temporary runtime secret file was replaced; refusing cleanup')
      }
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') throw new AggregateError([failure, cleanupError], 'Runtime secret file creation and cleanup failed')
    }
    throw failure
  }
  return { path, dev: stat.dev, ino: stat.ino, digest: digest(content) }
}

export function removeRuntimeFile(handle) {
  const stat = lstatSync(handle.path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== handle.dev || stat.ino !== handle.ino ||
      digest(readFileSync(handle.path, 'utf8')) !== handle.digest) {
    throw new Error('Temporary runtime secrets changed; refusing to remove them automatically')
  }
  unlinkSync(handle.path)
}

export function installRuntimeSignalCleanup(handle) {
  const handlers = new Map()
  for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const handler = () => {
      try {
        removeRuntimeFile(handle)
        console.error(`Setup interrupted (${signal}); temporary credentials removed.`)
        process.exit(status)
      } catch (error) {
        console.error(`Setup interrupted (${signal}); temporary credential cleanup failed: ${error.message}`)
        process.exit(1)
      }
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
  return () => { for (const [signal, handler] of handlers) process.off(signal, handler) }
}

export function updateRuntimeFile(handle, values) {
  const content = runtimeContents(values)
  const stat = lstatSync(handle.path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== handle.dev || stat.ino !== handle.ino ||
      digest(readFileSync(handle.path, 'utf8')) !== handle.digest) {
    throw new Error('Temporary runtime secrets changed; refusing to overwrite them')
  }
  const temporary = `${handle.path}.${randomBytes(12).toString('hex')}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  let created
  try {
    try {
      created = fstatSync(fd)
      fchmodSync(fd, 0o600)
      writeFileSync(fd, content, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    const current = lstatSync(handle.path)
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== handle.dev || current.ino !== handle.ino ||
        digest(readFileSync(handle.path, 'utf8')) !== handle.digest) {
      throw new Error('Temporary runtime secrets changed; refusing to overwrite them')
    }
    renameSync(temporary, handle.path)
    const updated = lstatSync(handle.path)
    handle.dev = updated.dev
    handle.ino = updated.ino
    handle.digest = digest(content)
  } finally {
    try {
      const current = lstatSync(temporary)
      if (!created || !current.isFile() || current.isSymbolicLink() ||
          current.dev !== created.dev || current.ino !== created.ino) {
        throw new Error('Temporary replacement file changed; refusing to remove it')
      }
      unlinkSync(temporary)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

export function runtimeSecretsFromContainer(container, project) {
  const labels = container?.Config?.Labels ?? {}
  if (!project || labels['com.docker.compose.project'] !== project ||
      labels['com.docker.compose.service'] !== 'sdlc-runtime-keeper') {
    throw new Error('The runtime secret keeper does not belong to the requested Compose project')
  }
  if (container?.State?.Running !== true) throw new Error('The runtime secret keeper is not running; refusing to regenerate secrets for existing data')
  const env = container.Config?.Env
  if (!Array.isArray(env)) throw new Error('The runtime secret keeper has no environment')
  const values = {}
  for (const entry of env) {
    const index = entry.indexOf('=')
    if (index > 0) values[entry.slice(0, index)] = entry.slice(index + 1)
  }
  for (const name of requiredSecretNames) {
    if (!values[name]) throw new Error(`The running secret keeper is missing ${name}`)
  }
  return Object.fromEntries([...requiredSecretNames, 'FORGEJO_OAUTH_CLIENT_ID', 'FORGEJO_OAUTH_CLIENT_SECRET']
    .filter((name) => values[name]).map((name) => [name, values[name]]))
}
