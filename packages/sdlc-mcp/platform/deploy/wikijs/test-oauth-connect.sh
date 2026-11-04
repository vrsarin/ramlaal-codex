#!/bin/bash
# Live end-to-end check of the one-time Wiki.js connection: no token is pasted anywhere.
# A Keycloak-authenticated caller runs connect_wikijs, the "browser" completes Wiki.js consent as the
# wiki administrator (signed in via the API), and discovery then works from the stored grant.
# Run with the `mcp` compose profile up. It leaves the administrator's grant disconnected afterwards.
set -euo pipefail

cd "$(dirname "$0")/../../.."
set -a; . ./.env; set +a

KC="http://$KEYCLOAK_HOSTNAME"
REALM_URL="$KC/realms/$KEYCLOAK_REALM/protocol/openid-connect/token"
WIKI="http://$WIKIJS_HOSTNAME"
WIKI_MCP="$WIKIJS_SDLC_MCP_PUBLIC_URL"
clients=("$WIKIJS_SDLC_MCP_OAUTH_CLIENT_ID")
failures=0
jar="$(mktemp)"; wiki_jar="$(mktemp)"
. deploy/keycloak/lib.sh

cleanup() { [ -n "${keycloak_token:-}" ] && tool disconnect_wikijs >/dev/null 2>&1 || true; rm -f "$jar" "$wiki_jar"; restore_direct_grants; }
trap cleanup EXIT

check() { if [ "$2" = true ]; then echo "PASS  $1"; else echo "FAIL  $1"; failures=$((failures + 1)); fi; }
tool() { # name -> tool result text (SSE unwrapped)
  curl -s -X POST "$WIKI_MCP" -H "authorization: Bearer $keycloak_token" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":{}}}" \
    | { grep '^data: ' || true; } | cut -c7-
}
text() { jq -r '.result.content[0].text // .error.message // .result.content[0].text' ; }

keycloak_token="$(token_for "$WIKIJS_SDLC_MCP_OAUTH_CLIENT_ID" "$WIKIJS_SDLC_MCP_PUBLIC_URL")"
tool disconnect_wikijs >/dev/null

before="$(tool discover_wikijs_capabilities)"
check "before connecting, discovery asks the user to connect (no shared fallback)" "$(grep -q 'connect_wikijs' <<<"$before" && echo true || echo false)"

link="$(tool connect_wikijs | text | jq -r .authorizeUrl)"
check "connect_wikijs returns a browser link on the loopback redirect origin" "$([[ "$link" == http://localhost/oauth/wikijs/start?state=* ]] && echo true || echo false)"

# Browser leg 1: our start route pins the flow to this browser and sends it to Wiki.js.
authorize="$(curl -s -o /dev/null -D - -c "$jar" "$link" | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')"
check "start redirects to the Wiki.js authorization endpoint" "$([[ "$authorize" == $WIKI/_oauth/authorize\?* ]] && echo true || echo false)"

# Browser leg 2: the wiki administrator approves on the consent screen (its API, with a signed-in session).
site_id="$(curl -fsS "$WIKI/_api/bootstrap" | jq -r .site.id)"
strategy="$(curl -fsS "$WIKI/_api/sites/$site_id/auth/strategies" | jq -r '[.[] | select(.activeStrategy.strategy.key=="local")][0].id')"
curl -fsS -c "$wiki_jar" -o /dev/null -X PUT "$WIKI/_api/sites/$site_id/auth/login" -H 'content-type: application/json' \
  -d "$(jq -n --arg s "$strategy" --arg u "$WIKIJS_ADMIN_EMAIL" --arg p "$WIKIJS_ADMIN_PASSWORD" '{strategyId:$s,username:$u,password:$p}')"
params="$(python3 -c 'import sys,json,urllib.parse as u; print(json.dumps({k:v[0] for k,v in u.parse_qs(u.urlparse(sys.argv[1]).query).items()}))' "$authorize")"
redirect="$(curl -fsS -b "$wiki_jar" -X POST "$WIKI/_api/oauth/authorize" -H 'content-type: application/json' \
  -d "$(jq -n --argjson r "$params" '{request:$r,approve:true,scopes:["mcp:read","pages:read"],expiration:"7d"}')" | jq -r .redirect)"
check "Wiki.js consent returns the browser to our callback with a code" "$([[ "$redirect" == http://localhost/oauth/wikijs/callback\?* ]] && echo true || echo false)"

# Browser leg 3: a different browser (no cookie) must be refused; the right one connects.
other="$(curl -s -o /dev/null -w '%{http_code}' "$redirect")"
check "the callback is refused without the cookie set at the start of the flow" "$([ "$other" = 400 ] && echo true || echo false)"
link2="$(tool connect_wikijs | text | jq -r .authorizeUrl)"
authorize2="$(curl -s -o /dev/null -D - -c "$jar" "$link2" | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')"
params2="$(python3 -c 'import sys,json,urllib.parse as u; print(json.dumps({k:v[0] for k,v in u.parse_qs(u.urlparse(sys.argv[1]).query).items()}))' "$authorize2")"
redirect2="$(curl -fsS -b "$wiki_jar" -X POST "$WIKI/_api/oauth/authorize" -H 'content-type: application/json' \
  -d "$(jq -n --argjson r "$params2" '{request:$r,approve:true,scopes:["mcp:read","pages:read"],expiration:"7d"}')" | jq -r .redirect)"
done_status="$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$redirect2")"
check "the callback in the original browser completes the connection" "$([ "$done_status" = 200 ] && echo true || echo false)"

status="$(tool get_service_status | text | jq -r .wikiJsConnection)"
check "the service reports this user as connected" "$([ "$status" = connected ] && echo true || echo false)"

after="$(tool discover_wikijs_capabilities)"
check "discovery now works from the stored grant, with no token header" "$(jq -r '(.result.isError // false) | not' <<<"$after")"
echo "      tools: $(text <<<"$after" | jq -r '.tools | map(.name) | join(", ")')"
check "no Wiki.js token appears in any tool response" "$(grep -qE 'Bearer|refresh_token|access_token' <<<"$before$after" && echo false || echo true)"

[ "$failures" -eq 0 ] && echo "All Wiki.js OAuth connection checks passed." || { echo "$failures check(s) failed."; exit 1; }
