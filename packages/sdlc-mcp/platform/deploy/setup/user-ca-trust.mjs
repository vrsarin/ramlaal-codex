import { execFileSync } from 'node:child_process'
import { lstatSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const trustLedgerFileName = '.sdlc-local-ca-trust.json'

function ledgerPath(directory) { return join(directory, trustLedgerFileName) }
function keychainPath() { return join(homedir(), 'Library', 'Keychains', 'login.keychain-db') }

function fingerprints(keychain = keychainPath()) {
  const output = execFileSync('security', ['find-certificate', '-a', '-Z', keychain], { encoding: 'utf8' })
  return new Set([...output.matchAll(/SHA-256 hash:\s*([A-Fa-f0-9]{64})/g)].map((match) => match[1].toLowerCase()))
}

function readLedger(directory) {
  const path = ledgerPath(directory)
  let stat
  try { stat = lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Local CA trust ledger must be a private regular file')
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (value.version !== 1 || value.platform !== 'darwin' || !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
      value.keychain !== keychainPath()) throw new Error('Local CA trust ledger is invalid')
  return { path, stat, value }
}

function writeLedger(directory, value) {
  const path = ledgerPath(directory)
  const temporary = `${path}.${process.pid}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try { renameSync(temporary, path) } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

export function installCurrentUserCaTrust(directory, certificatePath, fingerprint) {
  if (process.platform !== 'darwin') throw new Error('Current-user CA trust is currently implemented and physically verified only for macOS')
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid local CA fingerprint')
  const existing = readLedger(directory)
  const present = fingerprints().has(fingerprint)
  if (existing) {
    if (existing.value.fingerprint !== fingerprint) throw new Error('The owned trust entry belongs to a different CA')
    if (present) return { installed: false, fingerprint }
    // This function is called only after the wizard's explicit TRUST confirmation. Reinstalling an
    // owned certificate repairs a keychain entry removed outside teardown without claiming a foreign CA.
    execFileSync('security', ['add-trusted-cert', '-d', '-r', 'trustRoot', '-k', keychainPath(), certificatePath], { stdio: 'inherit' })
    if (!fingerprints().has(fingerprint)) throw new Error('macOS did not retain the project CA trust entry')
    return { installed: true, fingerprint }
  }
  if (present) throw new Error('The project CA is already trusted but is not owned by this project')
  execFileSync('security', ['add-trusted-cert', '-d', '-r', 'trustRoot', '-k', keychainPath(), certificatePath], { stdio: 'inherit' })
  if (!fingerprints().has(fingerprint)) throw new Error('macOS did not retain the project CA trust entry')
  try {
    writeLedger(directory, { version: 1, platform: 'darwin', fingerprint, keychain: keychainPath() })
  } catch (error) {
    execFileSync('security', ['delete-certificate', '-Z', fingerprint.toUpperCase(), keychainPath()], { stdio: 'inherit' })
    throw error
  }
  return { installed: true, fingerprint }
}

export function removeOwnedCurrentUserCaTrust(directory) {
  const ledger = readLedger(directory)
  if (!ledger) return { removed: false }
  const { fingerprint, keychain } = ledger.value
  if (!fingerprints(keychain).has(fingerprint)) throw new Error('Owned local CA trust entry is already missing; refusing to discard its ownership ledger')
  execFileSync('security', ['delete-certificate', '-Z', fingerprint.toUpperCase(), keychain], { stdio: 'inherit' })
  if (fingerprints(keychain).has(fingerprint)) throw new Error('macOS did not remove the owned project CA trust entry')
  const current = lstatSync(ledger.path)
  if (current.dev !== ledger.stat.dev || current.ino !== ledger.stat.ino) throw new Error('Local CA trust ledger changed during removal')
  unlinkSync(ledger.path)
  return { removed: true, fingerprint }
}
