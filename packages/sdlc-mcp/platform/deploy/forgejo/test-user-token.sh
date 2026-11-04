#!/bin/bash
# Live check that the Forgejo workflow MCP server calls Forgejo only as the caller:
# a request without the caller's own token is refused, and with one it acts as that user.
# Uses list_organizations, which needs no particular repository to exist.
# Run from anywhere with the `mcp` compose profile up.
set -euo pipefail

cd "$(dirname "$0")/../../.."
set -a; . ./.env; set +a

KC="http://$KEYCLOAK_HOSTNAME"
REALM_URL="$KC/realms/$KEYCLOAK_REALM/protocol/openid-connect/token"
FORGEJO="http://$FORGEJO_HOSTNAME/api/v1"
FORGEJO_MCP="$FORGEJO_MCP_PUBLIC_URL"
clients=("$FORGEJO_MCP_OAUTH_CLIENT_ID")
failures=0
token_name="sdlc-mcp-live-test-$$"
. deploy/keycloak/lib.sh

cleanup() {
  curl -s -o /dev/null -X DELETE -u "$FORGEJO_ADMIN_USERNAME:$FORGEJO_ADMIN_PASSWORD" "$FORGEJO/users/$FORGEJO_ADMIN_USERNAME/tokens/$token_name" || true
  restore_direct_grants
}
trap cleanup EXIT

pat="$(curl -fsS -X POST -u "$FORGEJO_ADMIN_USERNAME:$FORGEJO_ADMIN_PASSWORD" -H 'content-type: application/json' \
  "$FORGEJO/users/$FORGEJO_ADMIN_USERNAME/tokens" -d "{\"name\":\"$token_name\",\"scopes\":[\"read:repository\",\"read:user\",\"read:organization\"]}" | jq -r .sha1)"
keycloak_token="$(token_for "$FORGEJO_MCP_OAUTH_CLIENT_ID" "$FORGEJO_MCP_PUBLIC_URL")"

call() { # [header-name header-value] -> JSON-RPC response (unwrapped from SSE)
  curl -s -X POST "$FORGEJO_MCP" -H "authorization: Bearer $keycloak_token" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' ${1:+-H "$1: $2"} \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"list_organizations\",\"arguments\":{}}}" \
    | { grep '^data: ' || true; } | cut -c7-
}
check() { if [ "$2" = true ]; then echo "PASS  $1"; else echo "FAIL  $1"; failures=$((failures + 1)); fi; }

without="$(call)"
check "a call without a Forgejo token is refused" "$(grep -qiE 'connect_forgejo|x-forgejo-token' <<<"$without" && echo true || echo false)"

with="$(call x-forgejo-token "$pat")"
check "a call with the caller's own token is accepted by Forgejo as that user" "$(jq -r '(.result.isError // false) | not' <<<"$with")"

bad="$(call x-forgejo-token "not-a-real-token")"
check "an invalid Forgejo token is rejected by Forgejo" "$(jq -r '.result.isError == true' <<<"$bad")"
check "the token is never echoed back" "$(grep -q "$pat" <<<"$without$with$bad" && echo false || echo true)"

[ "$failures" -eq 0 ] && echo "All per-user Forgejo token checks passed." || { echo "$failures check(s) failed."; exit 1; }
