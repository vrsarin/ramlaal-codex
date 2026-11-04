#!/bin/bash
# Reports what Keycloak did with client-ID-metadata-document (CIMD) clients after a harness logged in:
# which URL-identified clients exist, what they were allowed to do, and their active sessions.
# Run after connecting a harness to a server that has no pre-registered client ID.
set -euo pipefail

cd "$(dirname "$0")/../../.."
set -a; . ./.env; set +a
KC="http://$KEYCLOAK_HOSTNAME"
admin="$(curl -fsS "$KC/realms/master/protocol/openid-connect/token" -d grant_type=password -d client_id=admin-cli \
  --data-urlencode "username=$KEYCLOAK_ADMIN_USERNAME" --data-urlencode "password=$KEYCLOAK_ADMIN_PASSWORD" | jq -r .access_token)"
api() { curl -fsS -H "authorization: Bearer $admin" "$KC/admin/realms/$KEYCLOAK_REALM/$1"; }

found="$(api 'clients?max=200' | jq -c '[.[] | select(.clientId | startswith("https://") or startswith("http://"))]')"
echo "CIMD clients known to Keycloak: $(jq length <<<"$found")"
jq -r '.[] | "  \(.clientId)\n    publicClient=\(.publicClient) redirectUris=\(.redirectUris | join(","))\n    protocolMappers=\([.protocolMappers[]? | .name] | join(","))"' <<<"$found"
for id in $(jq -r '.[].id' <<<"$found"); do
  echo "  sessions for $(api "clients/$id" | jq -r .clientId): $(api "clients/$id/user-sessions" | jq length)"
done
echo "Recent logins by client (from Keycloak events; needs the realm's event logging, enabled by configure-mcp.sh):"
curl -fsS -H "authorization: Bearer $admin" "$KC/admin/realms/$KEYCLOAK_REALM/events?max=200" \
  | jq -r '[.[] | select(.type=="CODE_TO_TOKEN" or .type=="LOGIN" or .type=="LOGIN_ERROR" or .type=="CODE_TO_TOKEN_ERROR")] | group_by(.clientId) | .[] | "  \(.[0].clientId): \(map(.type) | group_by(.) | map("\(.[0])x\(length)") | join(" "))\((map(.error // empty) | unique | if length > 0 then " errors=" + join(",") else "" end))"'
echo "Reminder: the Forgejo MCP also reports the token's client and audience: ask the assistant for get_forgejo_connection."
