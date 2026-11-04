#!/bin/bash
# Live end-to-end check of the one-time Forgejo connection: no token is pasted anywhere.
# A Keycloak-authenticated caller runs connect_forgejo, the "browser" signs in to Forgejo as the
# administrator and approves, and Forgejo calls then work from the stored grant.
# Run with the `mcp` compose profile up and `make register-forgejo-oauth` done.
# It leaves the caller disconnected afterwards.
set -euo pipefail

cd "$(dirname "$0")/../../.."
set -a; . ./.env; set +a

KC="http://$KEYCLOAK_HOSTNAME"
REALM_URL="$KC/realms/$KEYCLOAK_REALM/protocol/openid-connect/token"
FORGEJO="http://$FORGEJO_HOSTNAME"
FORGEJO_MCP="$FORGEJO_MCP_PUBLIC_URL"
clients=("$FORGEJO_MCP_OAUTH_CLIENT_ID")
failures=0
mcp_jar="$(mktemp)"; forgejo_jar="$(mktemp)"
. deploy/keycloak/lib.sh

cleanup() { [ -z "${KEEP_CONNECTED:-}" ] && [ -n "${keycloak_token:-}" ] && tool disconnect_forgejo '{}' >/dev/null 2>&1 || true; rm -f "$mcp_jar" "$forgejo_jar"; restore_direct_grants; }
trap cleanup EXIT

check() { if [ "$2" = true ]; then echo "PASS  $1"; else echo "FAIL  $1"; failures=$((failures + 1)); fi; }
tool() { # name arguments-json -> JSON-RPC response (SSE unwrapped)
  curl -s -X POST "$FORGEJO_MCP" -H "authorization: Bearer $keycloak_token" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
    | { grep '^data: ' || true; } | cut -c7-
}
text() { jq -r '.result.content[0].text // .error.message'; }
# sed (not head) reads all input, so pipefail never trips on a closed pipe.
csrf() { { grep -o 'name="_csrf" value="[^"]*"' || true; } | sed -n '1s/.*value="//;1s/"$//p'; }

keycloak_token="$(token_for "$FORGEJO_MCP_OAUTH_CLIENT_ID" "$FORGEJO_MCP_PUBLIC_URL")"
tool disconnect_forgejo '{}' >/dev/null

before="$(tool list_organizations '{}')"
check "before connecting, calls ask the user to connect (no shared fallback)" "$(grep -q 'connect_forgejo' <<<"$before" && echo true || echo false)"

link="$(tool connect_forgejo '{}' | text | jq -r .authorizeUrl)"
check "connect_forgejo returns a browser link on the loopback redirect origin" "$([[ "$link" == http://localhost/oauth/forgejo/start?state=* ]] && echo true || echo false)"

# Browser leg 1: our start route pins the flow to this browser and sends it to Forgejo.
authorize="$(curl -s -o /dev/null -D - -c "$mcp_jar" "$link" | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')"
check "start redirects to the Forgejo authorization endpoint" "$([[ "$authorize" == $FORGEJO/login/oauth/authorize\?* ]] && echo true || echo false)"
check "the client secret never appears in the browser redirect" "$(grep -q 'client_secret' <<<"$authorize" && echo false || echo true)"

# Browser leg 2: sign in to Forgejo as the administrator and approve on the consent screen.
token="$(curl -s -c "$forgejo_jar" "$FORGEJO/user/login" | csrf)"
curl -s -o /dev/null -b "$forgejo_jar" -c "$forgejo_jar" -X POST "$FORGEJO/user/login" --data-urlencode "_csrf=$token" \
  --data-urlencode "user_name=$FORGEJO_ADMIN_USERNAME" --data-urlencode "password=$FORGEJO_ADMIN_PASSWORD"
field() { { grep -o "name=\"$1\" value=\"[^\"]*\"" <<<"$consent" || true; } | sed -n '1s/.*value="//;1s/"$//p'; }
approve() { # authorize-url -> where Forgejo sends the browser next. Forgejo remembers an approved
  # application, so a repeat request may skip the consent screen.
  local first location
  first="$(curl -s -D - -b "$forgejo_jar" -c "$forgejo_jar" "$1" | tr -d '\r')"
  location="$(sed -n 's/^[Ll]ocation: //p' <<<"$first" | head -1)"
  if [[ "$location" == http://localhost/oauth/forgejo/callback\?* ]]; then echo "$location"; return; fi
  consent="$first"
  curl -s -o /dev/null -D - -b "$forgejo_jar" -c "$forgejo_jar" -X POST "$FORGEJO/login/oauth/grant" \
    --data-urlencode "_csrf=$(csrf <<<"$consent")" --data-urlencode "client_id=$(field client_id)" --data-urlencode "state=$(field state)" \
    --data-urlencode "scope=$(field scope)" --data-urlencode "nonce=$(field nonce)" --data-urlencode "redirect_uri=$(field redirect_uri)" \
    --data-urlencode "granted=true" | tr -d '\r' | sed -n 's/^[Ll]ocation: //p'
}
redirect="$(approve "$authorize")"
check "approving on Forgejo returns the browser to our callback with a code" "$([[ "$redirect" == http://localhost/oauth/forgejo/callback\?* ]] && echo true || echo false)"

# Browser leg 3: a different browser (no cookie) must be refused; the original one connects.
other="$(curl -s -o /dev/null -w '%{http_code}' "$redirect")"
check "the callback is refused without the cookie set at the start of the flow" "$([ "$other" = 400 ] && echo true || echo false)"
link2="$(tool connect_forgejo '{}' | text | jq -r .authorizeUrl)"
authorize2="$(curl -s -o /dev/null -D - -c "$mcp_jar" "$link2" | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')"
redirect2="$(approve "$authorize2")"
done_status="$(curl -s -o /dev/null -w '%{http_code}' -b "$mcp_jar" "$redirect2")"
check "the callback in the original browser completes the connection" "$([ "$done_status" = 200 ] && echo true || echo false)"

status="$(tool get_forgejo_connection '{}' | text | jq -r .forgejoConnection)"
check "the service reports this user as connected" "$([ "$status" = connected ] && echo true || echo false)"

after="$(tool list_organizations '{}')"
check "Forgejo calls now work from the stored grant, with no token header" "$(jq -r '(.result.isError // false) | not' <<<"$after")"
me="$(tool get_issue '{"owner":"x","repo":"y","index":1}')"
check "the allowlist still applies to a connected user" "$(grep -q 'SDLC_ALLOWED_REPOSITORIES' <<<"$me" && echo true || echo false)"
check "no Forgejo token or secret appears in any tool response" "$(grep -qE "Bearer|refresh_token|access_token|$FORGEJO_OAUTH_CLIENT_SECRET" <<<"$before$after$me" && echo false || echo true)"

[ "$failures" -eq 0 ] && echo "All Forgejo OAuth connection checks passed." || { echo "$failures check(s) failed."; exit 1; }
