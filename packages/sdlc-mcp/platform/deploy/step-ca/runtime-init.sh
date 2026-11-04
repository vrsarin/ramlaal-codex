#!/bin/sh
set -eu
umask 077
: "${STEP_CA_PASSWORD:?}"
: "${STEP_CA_PROVISIONER_PASSWORD:?}"
cleanup() { rm -f /step-secrets/ca-password /step-secrets/provisioner-password; }
trap cleanup EXIT
printf '%s\n' "$STEP_CA_PASSWORD" > /step-secrets/ca-password
printf '%s\n' "$STEP_CA_PROVISIONER_PASSWORD" > /step-secrets/provisioner-password
/bin/sh /scripts/init-ca.sh
