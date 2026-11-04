import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('gateway rejects untrusted or hostname-mismatched TLS backends', { timeout: 120_000 }, () => {
  const policy = fileURLToPath(new URL('./upstream-tls.conf', import.meta.url))
  const script = fileURLToPath(new URL('./upstream-tls-policy.test.py', import.meta.url))
  execFileSync('docker', [
    'run', '--rm', '--network', 'none', '--user', '0:0', '--entrypoint', 'python3',
    '-v', `${policy}:/etc/nginx/conf.d/00-sdlc-upstream-tls.conf:ro`,
    '-v', `${script}:/scripts/upstream-tls-policy.test.py:ro`,
    'public.ecr.aws/p3v1o3c6/registry:1.35.0', '/scripts/upstream-tls-policy.test.py'
  ], { stdio: 'inherit' })
})
