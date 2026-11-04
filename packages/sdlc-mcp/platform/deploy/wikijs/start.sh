#!/bin/sh
set -eu

: "${WIKIJS_ADMIN_EMAIL:?Set WIKIJS_ADMIN_EMAIL in .env}"
: "${WIKIJS_ADMIN_PASSWORD:?Set WIKIJS_ADMIN_PASSWORD in .env}"
: "${WIKIJS_DB_NAME:?Set WIKIJS_DB_NAME in .env}"
: "${WIKIJS_DB_USER:?Set WIKIJS_DB_USER in .env}"
: "${WIKIJS_DB_PASSWORD:?Set WIKIJS_DB_PASSWORD in .env}"

export ADMIN_EMAIL="$WIKIJS_ADMIN_EMAIL"
export ADMIN_PASS="$WIKIJS_ADMIN_PASSWORD"
export DB_NAME="$WIKIJS_DB_NAME"
export DB_USER="$WIKIJS_DB_USER"
export DB_PASS="$WIKIJS_DB_PASSWORD"

oidc_module=/wiki/backend/modules/authentication/oidc/authentication.ts
passkeys_module=/wiki/backend/models/passkeys.ts
original_call='this.config = await client.discovery(new URL(issuer), clientId, clientSecret)'
insecure_call='this.config = await client.discovery(new URL(issuer), clientId, clientSecret, undefined, { execute: [client.allowInsecureRequests] })'
original_passkey_check='!insecureOriginExceptions.has(parsed.hostname)'
localhost_passkey_check="!insecureOriginExceptions.has(parsed.hostname) && !parsed.hostname.endsWith('.localhost')"
localhost_passkey_replacement="!insecureOriginExceptions.has(parsed.hostname) \\&\\& !parsed.hostname.endsWith('.localhost')"

if [ "${WIKIJS_ALLOW_INSECURE_OIDC:-false}" = "true" ]; then
  if grep -Fq "$original_call" "$oidc_module"; then
    sed -i "s|$original_call|$insecure_call|" "$oidc_module"
  elif ! grep -Fq "$insecure_call" "$oidc_module"; then
    echo "Wiki.js OIDC module no longer contains the expected discovery call." >&2
    exit 1
  fi
fi

if [ "${WIKIJS_ALLOW_LOCALHOST_PASSKEYS:-false}" = "true" ]; then
  if grep -Fq "$original_passkey_check" "$passkeys_module"; then
    sed -i "s|$original_passkey_check|$localhost_passkey_replacement|" "$passkeys_module"
  elif ! grep -Fq "$localhost_passkey_check" "$passkeys_module"; then
    echo "Wiki.js passkey model no longer contains the expected origin check." >&2
    exit 1
  fi
fi

cd /wiki
exec node --no-warnings --experimental-strip-types ./backend/index.ts
