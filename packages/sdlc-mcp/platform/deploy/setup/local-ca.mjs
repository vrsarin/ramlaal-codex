import { X509Certificate } from 'node:crypto'
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const localCaFileName = '.sdlc-local-ca.pem'

export function parseLocalCa(pem) {
  if (typeof pem !== 'string' || !/^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----\s*$/.test(pem)) {
    throw new Error('Local CA did not provide exactly one PEM certificate')
  }
  const certificate = new X509Certificate(pem)
  if (!certificate.ca || !certificate.verify(certificate.publicKey)) throw new Error('Local CA certificate is not a self-signed CA')
  const validFrom = Date.parse(certificate.validFrom)
  const validTo = Date.parse(certificate.validTo)
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || validFrom > Date.now() || validTo <= Date.now()) {
    throw new Error('Local CA certificate is not currently valid')
  }
  return certificate
}

export function ensureLocalCa(directory, pem) {
  const expected = parseLocalCa(pem)
  const path = join(directory, localCaFileName)
  let stat
  try { stat = lstatSync(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${localCaFileName} must be a regular file`)
    const existing = parseLocalCa(readFileSync(path, 'utf8'))
    if (!existing.raw.equals(expected.raw)) throw new Error('The saved local CA differs from the running project CA; refusing to replace it')
  } else {
    const fd = openSync(path, 'wx', 0o644)
    let created
    let failure
    try {
      created = fstatSync(fd)
      writeFileSync(fd, pem, 'utf8')
      fsyncSync(fd)
    } catch (error) {
      failure = error
    } finally {
      closeSync(fd)
    }
    if (failure) {
      if (!created) throw new AggregateError([failure], 'Local CA export failed; inspect the file')
      try {
        const current = lstatSync(path)
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== created.dev || current.ino !== created.ino) {
          throw new Error('Local CA export was replaced; refusing cleanup')
        }
        unlinkSync(path)
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') throw new AggregateError([failure, cleanupError], 'Local CA export and cleanup failed')
      }
      throw failure
    }
  }
  return { path, fingerprint: expected.fingerprint256.replaceAll(':', '').toLowerCase() }
}
