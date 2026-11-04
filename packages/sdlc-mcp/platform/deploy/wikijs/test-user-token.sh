#!/bin/bash
# Live check that the Wiki.js SDLC MCP server reaches the official Wiki.js MCP
# endpoint only with the calling user's own personal access token.
# Run from anywhere with the `mcp` compose profile up.
set -euo pipefail

cd "$(dirname "$0")/../../.."
set -a; . ./.env; set +a

KC="http://$KEYCLOAK_HOSTNAME"
REALM_URL="$KC/realms/$KEYCLOAK_REALM/protocol/openid-connect/token"
WIKI="http://$WIKIJS_HOSTNAME"
WIKI_MCP="$WIKIJS_SDLC_MCP_PUBLIC_URL"
clients=("$WIKIJS_SDLC_MCP_OAUTH_CLIENT_ID")
failures=0
pat_id=""
cookies=""
. deploy/keycloak/lib.sh

cleanup() {
  [ -n "$pat_id" ] && curl -s -o /dev/null -X DELETE -H "cookie: $cookies" "$WIKI/_api/users/profile/tokens/$pat_id" || true
  restore_direct_grants
}
trap cleanup EXIT

# A short-lived personal access token for the wiki administrator, created the way a user would.
site_id="$(curl -fsS "$WIKI/_api/bootstrap" | jq -r .site.id)"
strategy="$(curl -fsS "$WIKI/_api/sites/$site_id/auth/strategies" | jq -r '[.[] | select(.activeStrategy.strategy.key=="local")][0].id')"
cookies="$(curl -fsS -D - -o /dev/null -X PUT "$WIKI/_api/sites/$site_id/auth/login" -H 'content-type: application/json' \
  -d "$(jq -n --arg s "$strategy" --arg u "$WIKIJS_ADMIN_EMAIL" --arg p "$WIKIJS_ADMIN_PASSWORD" '{strategyId:$s,username:$u,password:$p}')" \
  | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\).*/\1/p' | paste -sd';' - | sed 's/;/; /g')"
created="$(curl -fsS -X POST "$WIKI/_api/users/profile/tokens" -H "cookie: $cookies" -H 'content-type: application/json' \
  -d '{"name":"sdlc-mcp-live-test","expiration":"7d","scopes":["mcp:read","pages:read"]}')"
pat="$(jq -r .token <<<"$created")"; pat_id="$(jq -r .id <<<"$created")"

keycloak_token="$(token_for "$WIKIJS_SDLC_MCP_OAUTH_CLIENT_ID" "$WIKIJS_SDLC_MCP_PUBLIC_URL")"

call() { # extra-header-name extra-header-value -> the JSON-RPC response (unwrapped from SSE)
  curl -s -X POST "$WIKI_MCP" -H "authorization: Bearer $keycloak_token" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' ${1:+-H "$1: $2"} \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"discover_wikijs_capabilities","arguments":{}}}' \
    | { grep '^data: ' || true; } | cut -c7-
}
check() { if [ "$2" = true ]; then echo "PASS  $1"; else echo "FAIL  $1"; failures=$((failures + 1)); fi; }

with_token="$(call x-wikijs-token "$pat")"
check "discovery succeeds with the caller's own Wiki.js token" "$(jq -r '(.result.isError // false) | not' <<<"$with_token")"
echo "      tools: $(jq -r '.result.content[0].text | fromjson | .tools | map(.name) | join(", ")' <<<"$with_token")"

without="$(call)"
check "discovery refuses to run without a per-user token" "$(grep -qE 'connect_wikijs|personal access token' <<<"$without" && echo true || echo false)"

bad="$(call x-wikijs-token "not-a-real-token")"
check "an invalid Wiki.js token is rejected by Wiki.js" "$(grep -q 'refused' <<<"$bad" && echo true || echo false)"
check "the token is never echoed back" "$(grep -q "$pat" <<<"$with_token$without$bad" && echo false || echo true)"

[ "$failures" -eq 0 ] && echo "All per-user Wiki.js token checks passed." || { echo "$failures check(s) failed."; exit 1; }
