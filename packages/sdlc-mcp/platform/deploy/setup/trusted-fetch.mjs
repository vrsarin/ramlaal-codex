import { request as httpsRequest, Agent } from 'node:https'
import { rootCertificates } from 'node:tls'
import { parseLocalCa } from './local-ca.mjs'

const maxResponseBytes = 2 * 1024 * 1024

export function createTrustedFetch(rootPem) {
  parseLocalCa(rootPem)
  const agent = new Agent({ ca: [...rootCertificates, rootPem] })
  const fetcher = (address, options = {}) => new Promise((resolve, reject) => {
    let url
    try { url = new URL(address) } catch (error) { reject(error); return }
    const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
      url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    if (url.protocol !== 'https:' || !local || url.username || url.password) {
      reject(new Error('Local trusted fetch requires a localhost HTTPS URL without embedded credentials'))
      return
    }
    if (options.body !== undefined && typeof options.body !== 'string' && !(options.body instanceof Uint8Array)) {
      reject(new Error('Unsupported request body for local trusted fetch'))
      return
    }
    const request = httpsRequest(url, {
      agent, method: options.method ?? 'GET', headers: Object.fromEntries(new Headers(options.headers)),
      ...(options.signal ? { signal: options.signal } : {})
    }, (response) => {
      const status = response.statusCode
      if (!status) {
        response.resume()
        reject(new Error('HTTPS response has no status code'))
        return
      }
      if (status >= 300 && status < 400 && options.redirect !== 'manual') {
        response.resume()
        reject(new Error('Local HTTPS redirects are not allowed'))
        return
      }
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > maxResponseBytes) {
          const error = new Error('Local HTTPS response exceeded the size limit')
          reject(error)
          response.destroy(error)
          return
        }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const entry of value) headers.append(name, entry)
          else if (value !== undefined) headers.set(name, value)
        }
        const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks)
        resolve(new Response(body, { status, statusText: response.statusMessage, headers }))
      })
    })
    request.on('error', (error) => {
      if (options.signal?.aborted) {
        reject(options.signal.reason ?? error)
      } else {
        reject(new TypeError('Local HTTPS request failed', { cause: error }))
      }
    })
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
  fetcher.close = () => agent.destroy()
  return fetcher
}
