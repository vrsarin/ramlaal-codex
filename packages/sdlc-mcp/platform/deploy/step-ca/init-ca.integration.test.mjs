import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('local CA provisions the two managed ACME issuers and rejects conflicts', { timeout: 120_000 }, () => {
  const script = fileURLToPath(new URL('./init-ca.sh', import.meta.url))
  const command = `
    set -eu
    mkdir -p /step-secrets /public
    printf 'test-fixture-password\\n' > /step-secrets/ca-password
    cp /step-secrets/ca-password /step-secrets/provisioner-password
    sh /scripts/init-ca.sh >/dev/null
    sh /scripts/init-ca.sh >/dev/null
    jq -e '[.authority.provisioners[] | select((.name == "sdlc-home-assistant" or .name == "sdlc-services") and .type == "ACME" and .challenges == ["tls-alpn-01"])] | length == 2' /home/step/config/ca.json >/dev/null
    jq '(.authority.provisioners[] | select(.name == "sdlc-services") | .type) = "JWK"' /home/step/config/ca.json > /tmp/invalid-ca.json
    cp /tmp/invalid-ca.json /home/step/config/ca.json
    if sh /scripts/init-ca.sh >/tmp/conflict.log 2>&1; then
      echo "Conflicting provisioner was incorrectly accepted" >&2
      exit 1
    fi
    grep -q 'sdlc-services conflicts with the managed configuration' /tmp/conflict.log
  `
  execFileSync('docker', [
    'run', '--rm', '--network', 'none', '--user', '0:0', '--entrypoint', '/bin/sh',
    '-v', `${script}:/scripts/init-ca.sh:ro`, 'smallstep/step-ca:0.30.2', '-c', command
  ], { stdio: 'pipe' })
})
