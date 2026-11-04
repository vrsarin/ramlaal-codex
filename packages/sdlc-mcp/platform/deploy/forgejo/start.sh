#!/bin/sh
set -eu

: "${FORGEJO_HOSTNAME:?Set FORGEJO_HOSTNAME in .env}"
: "${FORGEJO_SSH_HOSTNAME:?Set FORGEJO_SSH_HOSTNAME in .env}"
: "${FORGEJO_SSH_PORT:?Set FORGEJO_SSH_PORT in .env}"

export FORGEJO__server__DOMAIN="$FORGEJO_HOSTNAME"
export FORGEJO__server__ROOT_URL="https://$FORGEJO_HOSTNAME/"
export FORGEJO__server__SSH_DOMAIN="$FORGEJO_SSH_HOSTNAME"
export FORGEJO__server__SSH_PORT="$FORGEJO_SSH_PORT"

exec /usr/bin/entrypoint "$@"
