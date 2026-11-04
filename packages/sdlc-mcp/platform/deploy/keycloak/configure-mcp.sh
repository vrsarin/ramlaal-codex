#!/bin/bash
set -euo pipefail

: "${KEYCLOAK_REALM:?Set KEYCLOAK_REALM in .env}"
: "${KEYCLOAK_ADMIN_USERNAME:?Set KEYCLOAK_ADMIN_USERNAME in .env}"
: "${KEYCLOAK_ADMIN_PASSWORD:?Set KEYCLOAK_ADMIN_PASSWORD in .env}"
: "${KEYCLOAK_HOSTNAME:?Set KEYCLOAK_HOSTNAME in .env}"
: "${KEYCLOAK_TEST_USERNAME:?Set KEYCLOAK_TEST_USERNAME in .env}"
: "${KEYCLOAK_SSO_ADMIN_USERNAME:?Set KEYCLOAK_SSO_ADMIN_USERNAME in .env}"
: "${FORGEJO_OIDC_CLIENT_ID:?Set FORGEJO_OIDC_CLIENT_ID in .env}"
: "${FORGEJO_MCP_OAUTH_CLIENT_ID:?Set FORGEJO_MCP_OAUTH_CLIENT_ID in .env}"
: "${WIKIJS_SDLC_MCP_OAUTH_CLIENT_ID:?Set WIKIJS_SDLC_MCP_OAUTH_CLIENT_ID in .env}"
: "${FORGEJO_MCP_PUBLIC_URL:?Set FORGEJO_MCP_PUBLIC_URL in .env}"
: "${WIKIJS_SDLC_MCP_PUBLIC_URL:?Set WIKIJS_SDLC_MCP_PUBLIC_URL in .env}"
: "${WIKIJS_OIDC_CLIENT_ID:?Set WIKIJS_OIDC_CLIENT_ID in .env}"

KCADM=/opt/keycloak/bin/kcadm.sh
SERVER="http://keycloak:8080"

"$KCADM" config credentials \
  --server "$SERVER" \
  --realm master \
  --user "$KEYCLOAK_ADMIN_USERNAME" \
  --password="$KEYCLOAK_ADMIN_PASSWORD"

# VS Code requests offline_access so it can refresh the short-lived MCP token
# without storing a password or repeating the browser login for every expiry.
"$KCADM" add-roles -r "$KEYCLOAK_REALM" \
  --uusername "$KEYCLOAK_TEST_USERNAME" \
  --rolename offline_access

# The live test scripts sign in as their own Keycloak user, so they never touch a person's stored
# Forgejo/Wiki.js connections (grants are keyed by Keycloak user).
AUTOMATION_USER="${KEYCLOAK_AUTOMATION_USERNAME:-mcp-tester}"
if [ -z "$("$KCADM" get users -r "$KEYCLOAK_REALM" -q "username=$AUTOMATION_USER" -q exact=true --fields id --format csv --noquotes)" ]; then
  "$KCADM" create users -r "$KEYCLOAK_REALM" -s "username=$AUTOMATION_USER" -s enabled=true -s emailVerified=true \
    -s "email=$AUTOMATION_USER@example.test" -s firstName=MCP -s lastName=Tester
fi
"$KCADM" set-password -r "$KEYCLOAK_REALM" --username "$AUTOMATION_USER" --new-password="$KEYCLOAK_TEST_PASSWORD"
"$KCADM" add-roles -r "$KEYCLOAK_REALM" --uusername "$AUTOMATION_USER" --rolename offline_access

# Group membership grants the shared MCP role; each resource server still validates its own audience.
MCP_GROUP=mcp-users
MCP_ROLE=mcp-user
if ! "$KCADM" get "roles/$MCP_ROLE" -r "$KEYCLOAK_REALM" >/dev/null 2>&1; then
  "$KCADM" create roles -r "$KEYCLOAK_REALM" -s "name=$MCP_ROLE" -s 'description=May access configured MCP resources'
fi
if [ "$("$KCADM" get "roles/$MCP_ROLE" -r "$KEYCLOAK_REALM" --fields composite --format csv --noquotes)" != 'false' ]; then
  echo "The MCP role is composite; refusing to enroll accounts with unexpected privileges." >&2
  exit 1
fi
group_uuid() {
  "$KCADM" get groups -r "$KEYCLOAK_REALM" -q "search=$MCP_GROUP" --fields id,name --format csv --noquotes \
    | { grep ",$MCP_GROUP\$" || true; } | cut -d, -f1
}
mcp_group_uuid="$(group_uuid)"
if [ -z "$mcp_group_uuid" ]; then
  "$KCADM" create groups -r "$KEYCLOAK_REALM" -s "name=$MCP_GROUP"
  mcp_group_uuid="$(group_uuid)"
fi
if [ -z "$mcp_group_uuid" ] || [[ "$mcp_group_uuid" == *$'\n'* ]]; then
  echo "Expected exactly one top-level MCP users group." >&2
  exit 1
fi
if [ "$("$KCADM" get "groups/$mcp_group_uuid" -r "$KEYCLOAK_REALM" --fields path --format csv --noquotes)" != "/$MCP_GROUP" ]; then
  echo "The MCP users group is nested; refusing to inherit unrelated roles." >&2
  exit 1
fi
group_metadata="$("$KCADM" get "groups/$mcp_group_uuid" -r "$KEYCLOAK_REALM" | tr -d '[:space:]')"
if [[ "$group_metadata" == *'"mcpBootstrapMembers":["true"]'* ]]; then
  initialize_members=false
elif [[ "$group_metadata" == *'"mcpBootstrapMembers":'* ]]; then
  echo "The MCP group has an invalid bootstrap membership marker." >&2
  exit 1
else
  initialize_members=true
fi
group_realm_roles="$("$KCADM" get "groups/$mcp_group_uuid/role-mappings/realm" -r "$KEYCLOAK_REALM" --fields name --format csv --noquotes)"
if [ -n "$(printf '%s\n' "$group_realm_roles" | grep -v -e '^$' -e "^$MCP_ROLE$" || true)" ]; then
  echo "The MCP users group has unexpected realm roles; refusing to enroll accounts." >&2
  exit 1
fi
group_clients="$("$KCADM" get "groups/$mcp_group_uuid/role-mappings" -r "$KEYCLOAK_REALM" \
  | sed -n 's/^[[:space:]]*"client"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
if [ -n "$(printf '%s\n' "$group_clients" | grep -v -e '^$' -e '^mcp-wiki-group-source$' || true)" ]; then
  echo "The MCP users group has unexpected client roles; refusing to enroll accounts." >&2
  exit 1
fi
"$KCADM" add-roles -r "$KEYCLOAK_REALM" --gid "$mcp_group_uuid" --rolename "$MCP_ROLE"

# Keycloak creates CIMD (and other dynamically registered) clients with "full scope allowed" OFF, so a
# realm role only reaches their tokens if the role is within the client's scope. This client scope carries
# the MCP roles' scope mappings and is a realm default, so every client created from now on, including
# each harness's CIMD client, can emit the roles our servers authorize on. It grants nothing by itself:
# a user still needs the role, and a token still needs the server's own audience.
MCP_ROLES_SCOPE=mcp-roles
# Keycloak answers 409 when a mapping or default already exists, which is the state we want on a re-run.
already_ok() {
  local output
  if ! output="$("$@" 2>&1)"; then
    if [[ "$output" != *"Duplicate resource error"* ]]; then echo "$output" >&2; return 1; fi
  fi
}
scope_id() { "$KCADM" get client-scopes -r "$KEYCLOAK_REALM" --fields id,name --format csv --noquotes | { grep ",$1\$" || true; } | cut -d, -f1 | head -n 1; }
role_id() { "$KCADM" get "roles/$1" -r "$KEYCLOAK_REALM" --fields id --format csv --noquotes | head -n 1; }
if [ -z "$(scope_id "$MCP_ROLES_SCOPE")" ]; then
  "$KCADM" create client-scopes -r "$KEYCLOAK_REALM" -s "name=$MCP_ROLES_SCOPE" -s protocol=openid-connect \
    -s 'description=Lets MCP realm roles reach tokens of clients without full scope' \
    -s 'attributes."include.in.token.scope"=false' -s 'attributes."display.on.consent.screen"=false'
fi
MCP_ROLES_SCOPE_ID="$(scope_id "$MCP_ROLES_SCOPE")"
already_ok "$KCADM" create "client-scopes/$MCP_ROLES_SCOPE_ID/scope-mappings/realm" -r "$KEYCLOAK_REALM" \
  -b "[{\"id\":\"$(role_id "$MCP_ROLE")\",\"name\":\"$MCP_ROLE\"}]"
already_ok "$KCADM" update "default-default-client-scopes/$MCP_ROLES_SCOPE_ID" -r "$KEYCLOAK_REALM" -n

client_uuid() {
  "$KCADM" get clients -r "$KEYCLOAK_REALM" -q "clientId=$1" --fields id \
    | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1
}

# Resource Indicators (RFC 8707): each MCP server is registered as a client carrying a `resource_url`
# attribute. A token request whose `resource` matches it gets an access token whose `aud` is only that
# resource; an unknown resource is refused with invalid_target.
ensure_resource_server() {
  local server_client_id="$1" resource="$2" uuid
  uuid="$(client_uuid "$server_client_id")"
  if [ -z "$uuid" ]; then
    "$KCADM" create clients -r "$KEYCLOAK_REALM" \
      -s "clientId=$server_client_id" -s 'name=MCP resource server' -s enabled=true -s protocol=openid-connect \
      -s bearerOnly=true -s standardFlowEnabled=false -s directAccessGrantsEnabled=false \
      -s "attributes.resource_url=$resource"
  else
    "$KCADM" update "clients/$uuid" -r "$KEYCLOAK_REALM" -s "attributes.resource_url=$resource"
  fi
}

mapper_id() { # client-uuid mapper-name -> id of that protocol mapper, if present
  "$KCADM" get "clients/$1/protocol-mappers/models" -r "$KEYCLOAK_REALM" --fields id,name --format csv --noquotes \
    | { grep ",$2\$" || true; } | cut -d, -f1 | head -n 1
}

ensure_client() {
  local client_id="$1"
  local server_client_id="$2"
  local uuid
  uuid="$(client_uuid "$client_id")"

  if [ -z "$uuid" ]; then
    "$KCADM" create clients -r "$KEYCLOAK_REALM" \
      -s "clientId=$client_id" \
      -s 'name=VS Code MCP client' \
      -s enabled=true \
      -s protocol=openid-connect \
      -s publicClient=true \
      -s standardFlowEnabled=true \
      -s directAccessGrantsEnabled=false \
      -s serviceAccountsEnabled=false \
      -s 'redirectUris=["http://127.0.0.1:33418/","https://vscode.dev/redirect"]' \
      -s 'webOrigins=[]' \
      -s 'attributes={"pkce.code.challenge.method":"S256"}'
    uuid="$(client_uuid "$client_id")"
  else
    "$KCADM" update "clients/$uuid" -r "$KEYCLOAK_REALM" \
      -s enabled=true \
      -s publicClient=true \
      -s standardFlowEnabled=true \
      -s directAccessGrantsEnabled=false \
      -s serviceAccountsEnabled=false \
      -s 'redirectUris=["http://127.0.0.1:33418/","https://vscode.dev/redirect"]' \
      -s 'webOrigins=[]' \
      -s 'attributes={"pkce.code.challenge.method":"S256"}'
  fi

  # The client (RP) asks for tokens for the MCP server client; the mapper names that server client.
  local existing_mapper
  existing_mapper="$(mapper_id "$uuid" mcp-audience)"
  [ -n "$existing_mapper" ] && "$KCADM" delete "clients/$uuid/protocol-mappers/models/$existing_mapper" -r "$KEYCLOAK_REALM"
  "$KCADM" create "clients/$uuid/protocol-mappers/models" -r "$KEYCLOAK_REALM" \
    -s name=mcp-audience \
    -s protocol=openid-connect \
    -s protocolMapper=oidc-audience-mapper \
    -s consentRequired=false \
    -s "config.\"included.client.audience\"=$server_client_id" \
    -s 'config."access.token.claim"=true' \
    -s 'config."id.token.claim"=false' \
    -s 'config."introspection.token.claim"=true'
}

FORGEJO_MCP_SERVER_CLIENT_ID="${FORGEJO_MCP_SERVER_CLIENT_ID:-forgejo-mcp-server}"
WIKIJS_SDLC_MCP_SERVER_CLIENT_ID="${WIKIJS_SDLC_MCP_SERVER_CLIENT_ID:-wikijs-sdlc-mcp-server}"
ensure_resource_server "$FORGEJO_MCP_SERVER_CLIENT_ID" "$FORGEJO_MCP_PUBLIC_URL"
ensure_resource_server "$WIKIJS_SDLC_MCP_SERVER_CLIENT_ID" "$WIKIJS_SDLC_MCP_PUBLIC_URL"
ensure_client "$FORGEJO_MCP_OAUTH_CLIENT_ID" "$FORGEJO_MCP_SERVER_CLIENT_ID"
ensure_client "$WIKIJS_SDLC_MCP_OAUTH_CLIENT_ID" "$WIKIJS_SDLC_MCP_SERVER_CLIENT_ID"

# Separate public PKCE clients identify the browser before provider consent. The harness's own
# authorization request and token still go through Keycloak unchanged.
ensure_login_client() {
  local client_id="$1" callback="$2" name="$3" uuid
  uuid="$(client_uuid "$client_id")"
  if [ -z "$uuid" ]; then
    "$KCADM" create clients -r "$KEYCLOAK_REALM" -s "clientId=$client_id" \
      -s "name=$name" -s protocol=openid-connect -s enabled=true -s publicClient=true \
      -s standardFlowEnabled=true -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=false \
      -s "redirectUris=[\"$callback\"]" -s 'webOrigins=[]' -s 'attributes={"pkce.code.challenge.method":"S256"}'
  else
    "$KCADM" update "clients/$uuid" -r "$KEYCLOAK_REALM" -s enabled=true -s publicClient=true \
      -s standardFlowEnabled=true -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=false \
      -s "redirectUris=[\"$callback\"]" -s 'webOrigins=[]' -s 'attributes={"pkce.code.challenge.method":"S256"}'
  fi
}
FORGEJO_LOGIN_CALLBACK="${FORGEJO_OAUTH_REDIRECT_URL:-http://localhost/oauth/forgejo/callback}"
WIKIJS_LOGIN_CALLBACK="${WIKIJS_OAUTH_REDIRECT_URL:-http://localhost/oauth/wikijs/callback}"
ensure_login_client "${FORGEJO_MCP_LOGIN_CLIENT_ID:-forgejo-mcp-login}" \
  "${FORGEJO_LOGIN_CALLBACK%/oauth/forgejo/callback}/oauth/forgejo/login/callback" 'Forgejo MCP sign-in'
ensure_login_client "${WIKIJS_MCP_LOGIN_CLIENT_ID:-wikijs-mcp-login}" \
  "${WIKIJS_LOGIN_CALLBACK%/oauth/wikijs/callback}/oauth/wikijs/login/callback" 'Wiki.js MCP sign-in'

# A dedicated role source prevents unrelated Keycloak roles from being interpreted as provider groups.
# mcp-users stays narrow; developers grants full control only in the two local development providers.
WIKI_ROLE_SOURCE=mcp-wiki-group-source
WIKI_GROUP_ROLE=mcp-users
DEVELOPER_GROUP=developers
DEVELOPER_ROLE=developers
wiki_role_source_uuid="$(client_uuid "$WIKI_ROLE_SOURCE")"
if [ -z "$wiki_role_source_uuid" ]; then
  "$KCADM" create clients -r "$KEYCLOAK_REALM" -s "clientId=$WIKI_ROLE_SOURCE" \
    -s 'name=Wiki.js MCP group role source' -s protocol=openid-connect -s enabled=true \
    -s bearerOnly=true -s standardFlowEnabled=false -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=false
  wiki_role_source_uuid="$(client_uuid "$WIKI_ROLE_SOURCE")"
fi
wiki_roles="$("$KCADM" get "clients/$wiki_role_source_uuid/roles" -r "$KEYCLOAK_REALM" --fields name --format csv --noquotes)"
if [ -n "$(printf '%s\n' "$wiki_roles" | grep -v -e '^$' -e "^$WIKI_GROUP_ROLE$" -e "^$DEVELOPER_ROLE$" || true)" ]; then
  echo "The provider group role source contains unexpected roles; refusing to map them." >&2
  exit 1
fi
for role in "$WIKI_GROUP_ROLE" "$DEVELOPER_ROLE"; do
  if ! printf '%s\n' "$wiki_roles" | grep -Fxq "$role"; then
    "$KCADM" create "clients/$wiki_role_source_uuid/roles" -r "$KEYCLOAK_REALM" -s "name=$role"
  fi
  if [ "$("$KCADM" get "clients/$wiki_role_source_uuid/roles/$role" -r "$KEYCLOAK_REALM" --fields composite --format csv --noquotes)" != 'false' ]; then
    echo "Provider group role $role is composite; refusing to enroll accounts." >&2
    exit 1
  fi
done
wiki_group_roles="$("$KCADM" get "groups/$mcp_group_uuid/role-mappings/clients/$wiki_role_source_uuid" -r "$KEYCLOAK_REALM" --fields name --format csv --noquotes)"
if [ -n "$(printf '%s\n' "$wiki_group_roles" | grep -v -e '^$' -e "^$WIKI_GROUP_ROLE$" || true)" ]; then
  echo "The MCP users group has unexpected Wiki.js roles; refusing to enroll accounts." >&2
  exit 1
fi
"$KCADM" add-roles -r "$KEYCLOAK_REALM" --gid "$mcp_group_uuid" \
  --cclientid "$WIKI_ROLE_SOURCE" --rolename "$WIKI_GROUP_ROLE"

developer_group_uuid="$({ "$KCADM" get groups -r "$KEYCLOAK_REALM" -q "search=$DEVELOPER_GROUP" --fields id,name --format csv --noquotes \
  | { grep ",$DEVELOPER_GROUP\$" || true; } | cut -d, -f1; })"
if [ -z "$developer_group_uuid" ]; then
  "$KCADM" create groups -r "$KEYCLOAK_REALM" -s "name=$DEVELOPER_GROUP"
  developer_group_uuid="$({ "$KCADM" get groups -r "$KEYCLOAK_REALM" -q "search=$DEVELOPER_GROUP" --fields id,name --format csv --noquotes \
    | { grep ",$DEVELOPER_GROUP\$" || true; } | cut -d, -f1; })"
fi
if [ -z "$developer_group_uuid" ] || [[ "$developer_group_uuid" == *$'\n'* ]] ||
   [ "$("$KCADM" get "groups/$developer_group_uuid" -r "$KEYCLOAK_REALM" --fields path --format csv --noquotes)" != "/$DEVELOPER_GROUP" ]; then
  echo "Expected exactly one top-level developers group." >&2
  exit 1
fi
developer_metadata="$("$KCADM" get "groups/$developer_group_uuid" -r "$KEYCLOAK_REALM" | tr -d '[:space:]')"
if [[ "$developer_metadata" == *'"developerBootstrapMembers":["true"]'* ]]; then
  initialize_developers=false
elif [[ "$developer_metadata" == *'"developerBootstrapMembers":'* ]]; then
  echo "The developers group has an invalid bootstrap membership marker." >&2
  exit 1
else
  initialize_developers=true
fi
developer_realm_roles="$("$KCADM" get "groups/$developer_group_uuid/role-mappings/realm" -r "$KEYCLOAK_REALM" --fields name --format csv --noquotes)"
if [ -n "$developer_realm_roles" ]; then
  echo "The developers group has unexpected realm roles; refusing to grant provider control." >&2
  exit 1
fi
developer_clients="$("$KCADM" get "groups/$developer_group_uuid/role-mappings" -r "$KEYCLOAK_REALM" \
  | sed -n 's/^[[:space:]]*"client"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
if [ -n "$(printf '%s\n' "$developer_clients" | grep -v -e '^$' -e "^$WIKI_ROLE_SOURCE$" || true)" ]; then
  echo "The developers group has unexpected client roles; refusing to grant provider control." >&2
  exit 1
fi
developer_source_roles="$("$KCADM" get "groups/$developer_group_uuid/role-mappings/clients/$wiki_role_source_uuid" -r "$KEYCLOAK_REALM" --fields name --format csv --noquotes)"
if [ -n "$(printf '%s\n' "$developer_source_roles" | grep -v -e '^$' -e "^$DEVELOPER_ROLE$" || true)" ]; then
  echo "The developers group has unexpected provider roles; refusing to grant provider control." >&2
  exit 1
fi
"$KCADM" add-roles -r "$KEYCLOAK_REALM" --gid "$developer_group_uuid" \
  --cclientid "$WIKI_ROLE_SOURCE" --rolename "$DEVELOPER_ROLE"
if $initialize_developers; then
  for username in "$KEYCLOAK_TEST_USERNAME" "$KEYCLOAK_SSO_ADMIN_USERNAME"; do
    user_uuid="$("$KCADM" get users -r "$KEYCLOAK_REALM" -q "username=$username" -q exact=true --fields id --format csv --noquotes)"
    if [ -z "$user_uuid" ] || [[ "$user_uuid" == *$'\n'* ]]; then
      echo "Expected exactly one account for developers group membership." >&2
      exit 1
    fi
    "$KCADM" update "users/$user_uuid/groups/$developer_group_uuid" -r "$KEYCLOAK_REALM" -n
  done
  "$KCADM" update "groups/$developer_group_uuid" -r "$KEYCLOAK_REALM" -s 'attributes.developerBootstrapMembers=["true"]'
fi
if $initialize_members; then
  for username in "$KEYCLOAK_TEST_USERNAME" "$AUTOMATION_USER"; do
    user_uuid="$("$KCADM" get users -r "$KEYCLOAK_REALM" -q "username=$username" -q exact=true --fields id --format csv --noquotes)"
    if [ -z "$user_uuid" ] || [[ "$user_uuid" == *$'\n'* ]]; then
      echo "Expected exactly one account for MCP group membership." >&2
      exit 1
    fi
    "$KCADM" update "users/$user_uuid/groups/$mcp_group_uuid" -r "$KEYCLOAK_REALM" -n
  done
  "$KCADM" update "groups/$mcp_group_uuid" -r "$KEYCLOAK_REALM" -s 'attributes.mcpBootstrapMembers=["true"]'
fi
wiki_oidc_uuid="$(client_uuid "$WIKIJS_OIDC_CLIENT_ID")"
if [ -z "$wiki_oidc_uuid" ]; then echo "Wiki.js Keycloak client was not found." >&2; exit 1; fi
wiki_group_mapper="$(mapper_id "$wiki_oidc_uuid" wikijs-mcp-group)"
if [ -n "$wiki_group_mapper" ]; then
  mapper_type="$("$KCADM" get "clients/$wiki_oidc_uuid/protocol-mappers/models/$wiki_group_mapper" -r "$KEYCLOAK_REALM" --fields protocolMapper --format csv --noquotes)"
  if [ "$mapper_type" != 'oidc-usermodel-client-role-mapper' ]; then echo "Conflicting Wiki.js MCP group mapper; refusing to replace it." >&2; exit 1; fi
  wiki_mapper_action=(update "clients/$wiki_oidc_uuid/protocol-mappers/models/$wiki_group_mapper")
else
  wiki_mapper_action=(create "clients/$wiki_oidc_uuid/protocol-mappers/models")
fi
"$KCADM" "${wiki_mapper_action[@]}" -r "$KEYCLOAK_REALM" \
  -s name=wikijs-mcp-group -s protocol=openid-connect -s protocolMapper=oidc-usermodel-client-role-mapper \
  -s consentRequired=false -s "config.\"usermodel.clientRoleMapping.clientId\"=$WIKI_ROLE_SOURCE" \
  -s 'config."claim.name"=wikijs_mcp_group_membership' -s 'config."jsonType.label"=String' \
  -s 'config."multivalued"=true' -s 'config."id.token.claim"=true' \
  -s 'config."access.token.claim"=true' -s 'config."userinfo.token.claim"=true'

forgejo_oidc_uuid="$(client_uuid "$FORGEJO_OIDC_CLIENT_ID")"
if [ -z "$forgejo_oidc_uuid" ]; then echo "Forgejo Keycloak client was not found." >&2; exit 1; fi
forgejo_group_mapper="$(mapper_id "$forgejo_oidc_uuid" forgejo-developer-group)"
if [ -n "$forgejo_group_mapper" ]; then
  mapper_type="$("$KCADM" get "clients/$forgejo_oidc_uuid/protocol-mappers/models/$forgejo_group_mapper" -r "$KEYCLOAK_REALM" --fields protocolMapper --format csv --noquotes)"
  if [ "$mapper_type" != 'oidc-usermodel-client-role-mapper' ]; then echo "Conflicting Forgejo developer mapper; refusing to replace it." >&2; exit 1; fi
  forgejo_mapper_action=(update "clients/$forgejo_oidc_uuid/protocol-mappers/models/$forgejo_group_mapper")
else
  forgejo_mapper_action=(create "clients/$forgejo_oidc_uuid/protocol-mappers/models")
fi
"$KCADM" "${forgejo_mapper_action[@]}" -r "$KEYCLOAK_REALM" \
  -s name=forgejo-developer-group -s protocol=openid-connect -s protocolMapper=oidc-usermodel-client-role-mapper \
  -s consentRequired=false -s "config.\"usermodel.clientRoleMapping.clientId\"=$WIKI_ROLE_SOURCE" \
  -s 'config."claim.name"=forgejo_group_membership' -s 'config."jsonType.label"=String' \
  -s 'config."multivalued"=true' -s 'config."id.token.claim"=true' \
  -s 'config."access.token.claim"=true' -s 'config."userinfo.token.claim"=true'

# Every MCP server resource a CIMD client may request a token for. Add new servers here (or list
# extra URLs, comma separated, in MCP_EXTRA_PUBLIC_URLS) so the same harness login works for all of them.
CIMD_RESOURCES="$(printf '%s\n' "$FORGEJO_MCP_PUBLIC_URL" "$WIKIJS_SDLC_MCP_PUBLIC_URL" $(tr ',' ' ' <<<"${MCP_EXTRA_PUBLIC_URLS:-}") \
  | sed 's/.*/"&"/' | paste -sd, - | sed 's/^/[/;s/$/]/')"

# Harnesses identify themselves through hosted Client ID Metadata Documents. Per the Keycloak MCP guide:
# VS Code and Claude Code are public PKCE clients on localhost redirects (restrict-same-domain OFF), Claude
# Desktop lists a confidential-only grant (accept-public-client-with-confidential-client-only-grant ON), and
# the executor's trusted domains must cover every URL in a client's metadata (code.visualstudio.com for the
# VS Code logo). ChatGPT is not supported by Keycloak. Keep the domain lists as narrow as the harnesses allow.
"$KCADM" update client-policies/profiles -r "$KEYCLOAK_REALM" \
  -s "profiles=[{\"name\":\"mcp-cimd-profile\",\"description\":\"One shared profile for VS Code, Claude Code, and Claude Desktop\",\"executors\":[{\"executor\":\"client-id-metadata-document\",\"configuration\":{\"cimd-allow-http-scheme\":false,\"cimd-allow-permitted-domains\":[\"vscode.dev\",\"code.visualstudio.com\",\"claude.ai\",\"localhost\",\"127.0.0.1\"],\"cimd-restrict-same-domain\":false,\"only-allow-confidential-client\":false,\"accept-public-client-with-confidential-client-only-grant\":true,\"cimd-required-properties\":[],\"cimd-resource-indicator-allow-list\":$CIMD_RESOURCES}}]}]"

"$KCADM" update client-policies/policies -r "$KEYCLOAK_REALM" \
  -s 'policies=[{"name":"mcp-cimd-policy","description":"Allow hosted client metadata documents from the harnesses we test","enabled":true,"conditions":[{"condition":"client-id-uri","configuration":{"client-id-uri-scheme":["https"],"client-id-uri-allow-permitted-domains":["vscode.dev","claude.ai"]}}],"profiles":["mcp-cimd-profile"]}]'

# Login events record which client each login used (including URL-identified CIMD clients), so a
# harness test can be verified afterwards. Local development only: token values are never recorded.
"$KCADM" update events/config -r "$KEYCLOAK_REALM" \
  -s eventsEnabled=true -s eventsExpiration=604800 \
  -s 'enabledEventTypes=["LOGIN","LOGIN_ERROR","CODE_TO_TOKEN","CODE_TO_TOKEN_ERROR","REFRESH_TOKEN","REFRESH_TOKEN_ERROR","CLIENT_REGISTER","CLIENT_REGISTER_ERROR","CLIENT_LOGIN","CLIENT_LOGIN_ERROR"]'

# CIMD clients registered before the scope was a realm default get it now (idempotent).
for cimd_uuid in $("$KCADM" get clients -r "$KEYCLOAK_REALM" --fields id,clientId --format csv --noquotes | { grep ',http' || true; } | cut -d, -f1 | { grep . || true; }); do
  already_ok "$KCADM" update "clients/$cimd_uuid/default-client-scopes/$MCP_ROLES_SCOPE_ID" -r "$KEYCLOAK_REALM" -n
done
