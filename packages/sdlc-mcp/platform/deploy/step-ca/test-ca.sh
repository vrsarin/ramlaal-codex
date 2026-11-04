#!/bin/sh
set -eu
umask 077

dir="$(mktemp -d)"
cleanup() {
  rm -f "$dir/leaf.crt" "$dir/leaf.key" "$dir/provisioner-password"
  rmdir "$dir"
}
trap cleanup EXIT

step ca health --ca-url https://localhost:9000 --root /home/step/certs/root_ca.crt | grep -q '^ok'
password_file=/step-secrets/provisioner-password
if [ -n "${STEP_CA_PROVISIONER_PASSWORD:-}" ]; then
  printf '%s\n' "$STEP_CA_PROVISIONER_PASSWORD" > "$dir/provisioner-password"
  password_file="$dir/provisioner-password"
fi
step ca certificate home-assistant.localhost "$dir/leaf.crt" "$dir/leaf.key" \
  --ca-url https://localhost:9000 --root /home/step/certs/root_ca.crt \
  --provisioner sdlc-local-issuer --provisioner-password-file "$password_file" \
  --not-after 10m >/dev/null
step certificate verify "$dir/leaf.crt" --roots /home/step/certs/root_ca.crt --host home-assistant.localhost >/dev/null
echo "PASS Step CA issued and verified a short-lived Home Assistant test certificate"
