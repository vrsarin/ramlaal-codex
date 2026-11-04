#!/bin/bash
# Shared helpers for the live MCP checks. Source after loading .env and defining
# Tokens are for the automation user (mcp-tester), never the developer, so test runs cannot disconnect
# a person's Forgejo or Wiki.js connection.
# KC, REALM_URL and the `clients` array that restore_direct_grants must reset.
admin_token() {
  curl -fsS "$KC/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli \
    --data-urlencode "username=$KEYCLOAK_ADMIN_USERNAME" \
    --data-urlencode "password=$KEYCLOAK_ADMIN_PASSWORD" | jq -r .access_token
}

set_direct_grant() {
  local client_id="$1" enabled="$2" admin uuid
  admin="$(admin_token)"
  uuid="$(curl -fsS -H "authorization: Bearer $admin" "$KC/admin/realms/$KEYCLOAK_REALM/clients?clientId=$client_id" | jq -r '.[0].id')"
  curl -fsS -X PUT -H "authorization: Bearer $admin" -H 'content-type: application/json' \
    "$KC/admin/realms/$KEYCLOAK_REALM/clients/$uuid" \
    -d "$(curl -fsS -H "authorization: Bearer $admin" "$KC/admin/realms/$KEYCLOAK_REALM/clients/$uuid" | jq ".directAccessGrantsEnabled=$enabled")" >/dev/null
}

restore_direct_grants() {
  for client in "${clients[@]}"; do set_direct_grant "$client" false || echo "WARN  could not restore $client; disable its direct access grant manually" >&2; done
}

token_for() { # client-id resource-url
  set_direct_grant "$1" true
  curl -fsS "$REALM_URL" -d grant_type=password -d "client_id=$1" -d scope=openid --data-urlencode "resource=$2" \
    --data-urlencode "username=${KEYCLOAK_AUTOMATION_USERNAME:-mcp-tester}" \
    --data-urlencode "password=$KEYCLOAK_TEST_PASSWORD" | jq -r .access_token
}
