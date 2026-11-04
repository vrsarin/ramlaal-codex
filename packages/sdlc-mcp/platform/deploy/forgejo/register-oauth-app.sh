#!/bin/bash
# Creates the Forgejo OAuth application the Forgejo workflow MCP server signs users in with, and
# records its credentials in .env. Idempotent: an application already recorded in .env is kept.
# Forgejo shows a client secret only once, so a missing or unknown application is recreated.
set -euo pipefail

cd "$(dirname "$0")/../../.."
set -a; . ./.env; set +a

API="http://$FORGEJO_HOSTNAME/api/v1"
NAME="Forgejo workflow MCP"
REDIRECT="${FORGEJO_OAUTH_REDIRECT_URL:-http://localhost/oauth/forgejo/callback}"
auth=(-u "$FORGEJO_ADMIN_USERNAME:$FORGEJO_ADMIN_PASSWORD")

set_env() { # name value
  if grep -q "^$1=" .env; then
    python3 - "$1" "$2" <<'PY'
import re, sys
name, value = sys.argv[1], sys.argv[2]
text = open('.env').read()
open('.env', 'w').write(re.sub(rf'^{name}=.*$', lambda _: f'{name}={value}', text, flags=re.M))
PY
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

# Forgejo may still be starting right after `docker compose up`.
for _ in $(seq 1 60); do curl -fsS -o /dev/null "${auth[@]}" "$API/user" 2>/dev/null && break; sleep 2; done

apps="$(curl -fsS "${auth[@]}" "$API/user/applications/oauth2")"
if [ -n "${FORGEJO_OAUTH_CLIENT_ID:-}" ] && [ -n "${FORGEJO_OAUTH_CLIENT_SECRET:-}" ] \
  && jq -e --arg id "$FORGEJO_OAUTH_CLIENT_ID" --arg uri "$REDIRECT" 'any(.[]; .client_id == $id and (.redirect_uris | index($uri)))' <<<"$apps" >/dev/null; then
  echo "OAuth application already registered (client $FORGEJO_OAUTH_CLIENT_ID)."
else
  for id in $(jq -r --arg n "$NAME" '.[] | select(.name == $n) | .id' <<<"$apps"); do
    curl -fsS -o /dev/null -X DELETE "${auth[@]}" "$API/user/applications/oauth2/$id"
  done
  created="$(curl -fsS -X POST "${auth[@]}" -H 'content-type: application/json' "$API/user/applications/oauth2" \
    -d "$(jq -n --arg n "$NAME" --arg u "$REDIRECT" '{name:$n,redirect_uris:[$u],confidential_client:true}')")"
  set_env FORGEJO_OAUTH_CLIENT_ID "$(jq -r .client_id <<<"$created")"
  set_env FORGEJO_OAUTH_CLIENT_SECRET "$(jq -r .client_secret <<<"$created")"
  echo "Registered OAuth application '$NAME' and wrote its credentials to .env."
fi

grep -q '^FORGEJO_TOKEN_ENCRYPTION_KEY=.\{20,\}' .env || set_env FORGEJO_TOKEN_ENCRYPTION_KEY "$(openssl rand -base64 32)"
changed=false
[ "${FORGEJO_OAUTH_CLIENT_ID:-}" != "$(grep '^FORGEJO_OAUTH_CLIENT_ID=' .env | cut -d= -f2-)" ] && changed=true
echo "Credentials changed: $changed"
