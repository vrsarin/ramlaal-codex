#!/bin/sh
set -eu
umask 077
: "${STEP_CA_PASSWORD:?}"
cleanup() { rm -f /step-secrets/ca-password; }
trap cleanup EXIT
printf '%s\n' "$STEP_CA_PASSWORD" > /step-secrets/ca-password
/usr/local/bin/step-ca --password-file /step-secrets/ca-password /home/step/config/ca.json &
pid=$!
trap 'kill "$pid"; wait "$pid" || true; exit 0' TERM INT
i=0
while [ "$i" -lt 60 ]; do
  if step ca health --ca-url https://localhost:9000 --root /home/step/certs/root_ca.crt >/dev/null 2>&1; then
    cleanup
    wait "$pid"
    exit $?
  fi
  if ! kill -0 "$pid" 2>/dev/null; then wait "$pid"; exit 1; fi
  i=$((i + 1))
  sleep 1
done
echo 'Step CA did not become ready.' >&2
kill "$pid"
wait "$pid" || true
exit 1
