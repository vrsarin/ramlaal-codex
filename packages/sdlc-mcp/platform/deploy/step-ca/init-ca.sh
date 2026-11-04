#!/bin/sh
set -eu
umask 077

if [ ! -e /home/step/config/ca.json ]; then
  if [ -n "$(find /home/step -mindepth 1 -print -quit)" ]; then
    echo "Step CA data is incomplete or already initialized; refusing to overwrite it." >&2
    exit 1
  fi
  step ca init --name "SDLC Local Test CA" --dns step-ca,localhost,127.0.0.1 \
    --address :9000 --provisioner sdlc-local-issuer \
    --password-file /step-secrets/ca-password \
    --provisioner-password-file /step-secrets/provisioner-password
fi
for file in /home/step/config/ca.json /home/step/certs/root_ca.crt /home/step/certs/intermediate_ca.crt /home/step/secrets/intermediate_ca_key; do
  [ -s "$file" ] || { echo "Step CA data is incomplete; refusing to overwrite it." >&2; exit 1; }
done
ensure_acme_provisioner() {
  name="$1"
  count="$(jq --arg name "$name" '[.authority.provisioners[] | select(.name == $name)] | length' /home/step/config/ca.json)"
  if [ "$count" = 0 ]; then
    step ca provisioner add "$name" --type ACME --challenge tls-alpn-01 --ca-config /home/step/config/ca.json
  elif [ "$count" != 1 ] || ! jq -e --arg name "$name" \
    '.authority.provisioners[] | select(.name == $name and .type == "ACME" and .challenges == ["tls-alpn-01"])' \
    /home/step/config/ca.json >/dev/null; then
    echo "Step CA provisioner $name conflicts with the managed configuration." >&2
    exit 1
  fi
}
ensure_acme_provisioner sdlc-home-assistant
ensure_acme_provisioner sdlc-services
if [ -e /public/root_ca.crt ]; then
  cmp -s /home/step/certs/root_ca.crt /public/root_ca.crt || {
    echo "Published Step CA root differs from its private CA data; refusing to replace it." >&2
    exit 1
  }
else
  cp /home/step/certs/root_ca.crt /public/root_ca.crt
  chmod 644 /public/root_ca.crt
fi
step certificate fingerprint /home/step/certs/root_ca.crt
