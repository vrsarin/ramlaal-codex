#!/bin/bash
# Live check that each MCP server accepts only access tokens minted for its own
# resource. Run from the repository root with the `mcp` compose profile up.
# It briefly enables the password grant on the two VS Code clients to obtain
# tokens non-interactively, and always restores the original setting on exit.
set -euo pipefail

cd "$(dirname "$0")/../../.."
set -a; . ./.env; set +a

KC="http://$KEYCLOAK_HOSTNAME"
REALM_URL="$KC/realms/$KEYCLOAK_REALM/protocol/openid-connect/token"
FORGEJO_MCP="${FORGEJO_MCP_PUBLIC_URL}"
WIKI_MCP="${WIKIJS_SDLC_MCP_PUBLIC_URL}"
failures=0
# Both clients are always restored; tracking them in a subshell would lose them.
clients=("$FORGEJO_MCP_OAUTH_CLIENT_ID" "$WIKIJS_SDLC_MCP_OAUTH_CLIENT_ID")

. deploy/keycloak/lib.sh
trap restore_direct_grants EXIT

status() { # url token -> HTTP status of an MCP initialize call
  curl -s -o /dev/null -w '%{http_code}' -X POST "$1" \
    -H "authorization: Bearer $2" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"binding-test","version":"0"}}}'
}

expect() { # description expected actual
  local pass=false
  case "$2:$3" in ok:200|denied:401|denied:403) pass=true ;; esac
  if $pass; then echo "PASS  $1 ($3)"; else echo "FAIL  $1 (HTTP $3, wanted $2)"; failures=$((failures + 1)); fi
}

audience() { # JWT -> aud claim
  local payload; payload="$(cut -d. -f2 <<<"$1" | tr '_-' '/+')"
  while [ $(( ${#payload} % 4 )) -ne 0 ]; do payload="$payload="; done
  base64 -d <<<"$payload" 2>/dev/null | jq -c .aud
}

forgejo_token="$(token_for "$FORGEJO_MCP_OAUTH_CLIENT_ID" "$FORGEJO_MCP_PUBLIC_URL")"
wiki_token="$(token_for "$WIKIJS_SDLC_MCP_OAUTH_CLIENT_ID" "$WIKIJS_SDLC_MCP_PUBLIC_URL")"

echo "audiences: forgejo-client token -> $(audience "$forgejo_token")"
echo "audiences: wiki-client token    -> $(audience "$wiki_token")"

expect "no token rejected by Forgejo MCP"                 denied "$(status "$FORGEJO_MCP" garbage)"
expect "Forgejo-bound token accepted by Forgejo MCP"      ok     "$(status "$FORGEJO_MCP" "$forgejo_token")"
expect "Forgejo-bound token rejected by Wiki.js SDLC MCP" denied "$(status "$WIKI_MCP" "$forgejo_token")"
expect "Wiki.js-bound token accepted by Wiki.js SDLC MCP" ok     "$(status "$WIKI_MCP" "$wiki_token")"
expect "Wiki.js-bound token rejected by Forgejo MCP"      denied "$(status "$FORGEJO_MCP" "$wiki_token")"

[ "$failures" -eq 0 ] && echo "All resource-binding checks passed." || { echo "$failures check(s) failed."; exit 1; }
