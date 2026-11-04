#!/bin/bash
# Read-only health check of the Forgejo workflow MCP for the person who connected Forgejo (the Keycloak
# developer user). It never connects, disconnects, or writes; it only reads through the real MCP endpoint.
# The Keycloak client's password grant is switched on only for the duration of the check.
set -euo pipefail

cd "$(dirname "$0")/../../.."
set -a; . ./.env; set +a

KC="http://$KEYCLOAK_HOSTNAME"
REALM="$KEYCLOAK_REALM"
CLIENT="$FORGEJO_MCP_OAUTH_CLIENT_ID"
ADMIN="$(curl -fsS "$KC/realms/master/protocol/openid-connect/token" -d grant_type=password -d client_id=admin-cli \
  --data-urlencode "username=$KEYCLOAK_ADMIN_USERNAME" --data-urlencode "password=$KEYCLOAK_ADMIN_PASSWORD" | jq -r .access_token)"

set_direct_grant() { # true|false
  local uuid
  uuid="$(curl -s -H "authorization: Bearer $ADMIN" "$KC/admin/realms/$REALM/clients?clientId=$CLIENT" | jq -r '.[0].id')"
  curl -s -o /dev/null -X PUT -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
    "$KC/admin/realms/$REALM/clients/$uuid" \
    -d "$(curl -s -H "authorization: Bearer $ADMIN" "$KC/admin/realms/$REALM/clients/$uuid" | jq ".directAccessGrantsEnabled=$1")"
}
trap 'set_direct_grant false' EXIT
set_direct_grant true

TOKEN="$(curl -s "$KC/realms/$REALM/protocol/openid-connect/token" -d grant_type=password -d "client_id=$CLIENT" -d scope=openid \
  --data-urlencode "resource=$FORGEJO_MCP_PUBLIC_URL" --data-urlencode "username=$KEYCLOAK_TEST_USERNAME" \
  --data-urlencode "password=$KEYCLOAK_TEST_PASSWORD" | jq -r .access_token)"

rpc() { # json-rpc body -> unwrapped response
  curl -s -X POST "$FORGEJO_MCP_PUBLIC_URL" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -d "$1" | { grep '^data: ' || true; } | cut -c7-
}
tool() { rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"; }
text() { jq -r '.result.content[0].text // .error.message'; }
failed() { jq -r '.result.isError // false'; }

repo="${SDLC_ALLOWED_REPOSITORIES%%,*}"
args="$(jq -nc --arg o "${repo%/*}" --arg r "${repo#*/}" '{owner:$o,repo:$r}')"

echo "== tool list"
rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | jq -r '.result.tools | map(.name) | "\(length) tools; write tools hidden: \(index("create_issue") == null); connect and status tools present: \((index("connect_forgejo") != null) and (index("get_forgejo_connection") != null))"'

echo "== connection"
tool get_forgejo_connection '{}' | text | jq -c '{caller, oauthClient, tokenAudience, forgejoConnection}'

echo "== repository $repo"
out="$(tool get_repository "$args")"
if [ "$(failed <<<"$out")" = false ]; then text <<<"$out" | jq -c '{full_name, default_branch, private, permissions}'; else text <<<"$out"; fi

echo "== organizations"
out="$(tool list_organizations '{}')"
if [ "$(failed <<<"$out")" = false ]; then text <<<"$out" | jq -c '[.[].name]'; else text <<<"$out"; fi

echo "== newest issues"
out="$(tool search_issues "$(jq -c '. + {state:"all",limit:3}' <<<"$args")")"
if [ "$(failed <<<"$out")" = false ]; then text <<<"$out" | jq -c '.[] | {number, title, state}'; else text <<<"$out"; fi

echo "== other read tools"
for name in list_pull_requests list_commits list_releases_and_tags list_branch_protections list_webhooks list_repository_teams discover_issue_fields list_action_runs; do
  out="$(tool "$name" "$args")"
  if [ "$(failed <<<"$out")" = false ]; then echo "  ok    $name"; else echo "  FAIL  $name: $(text <<<"$out" | head -c 120)"; fi
done

echo "== guards"
echo "  repository outside the allowlist: $(tool get_issue '{"owner":"someone","repo":"else","index":1}' | text | head -c 100)"
echo "  write tool while writes are off:  $(tool create_issue '{}' | text | head -c 100)"
