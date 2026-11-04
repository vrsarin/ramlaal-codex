#!/bin/bash
set -euo pipefail

: "${KEYCLOAK_REALM:?}"
: "${KEYCLOAK_HOSTNAME:?}"
: "${KEYCLOAK_ADMIN_USERNAME:?}"
: "${KEYCLOAK_ADMIN_PASSWORD:?}"
: "${GATEWAY_WEB_CLIENT_SECRET:?}"
: "${GATEWAY_M2M_CLIENT_SECRET:?}"
: "${GATEWAY_DISCOVERY_CLIENT_SECRET:?}"
: "${GATEWAY_HOME_DISCOVERY_PASSWORD:?}"
: "${HOMEASSISTANT_HOSTNAME:?}"

KCADM=/opt/keycloak/bin/kcadm.sh
HOST="${GATEWAY_HOSTNAME:-mcp-gateway.localhost}"
GATEWAY_SCHEME="${SDLC_GATEWAY_SCHEME:-https}"
case "$GATEWAY_SCHEME" in http|https) ;; *) echo 'Invalid gateway scheme.' >&2; exit 1 ;; esac
GATEWAY_RESOURCE="$GATEWAY_SCHEME://$HOST/virtual/sdlc/mcp"
FORGEJO_TARGET="${FORGEJO_MCP_SERVER_CLIENT_ID:-forgejo-mcp-server}"
WIKI_TARGET="${WIKIJS_SDLC_MCP_SERVER_CLIENT_ID:-wikijs-sdlc-mcp-server}"
HOME_TARGET="${HOMEASSISTANT_MCP_SERVER_CLIENT_ID:-homeassistant-mcp-server}"
"$KCADM" config credentials --server "http://keycloak:8080" --realm master \
  --user "$KEYCLOAK_ADMIN_USERNAME" --password="$KEYCLOAK_ADMIN_PASSWORD"

client_id() {
  "$KCADM" get clients -r "$KEYCLOAK_REALM" -q "clientId=$1" --fields id --format csv --noquotes
}
ensure_client() {
  local name="$1" id
  id="$(client_id "$name")"
  if [ -n "$id" ]; then
    local metadata
    metadata="$("$KCADM" get "clients/$id" -r "$KEYCLOAK_REALM" | tr -d '[:space:]')"
    if [[ "$metadata" != *'"sdlc.gateway.managed":"true"'* ]]; then
      echo "Keycloak client $name already exists and is not managed by this setup." >&2
      exit 1
    fi
  else
    "$KCADM" create clients -r "$KEYCLOAK_REALM" -s "clientId=$name" \
      -s protocol=openid-connect -s enabled=true -s 'attributes."sdlc.gateway.managed"=true' >&2
    id="$(client_id "$name")"
  fi
  if [ -z "$id" ] || [[ "$id" == *$'\n'* ]]; then echo "Expected one client named $name." >&2; exit 1; fi
  printf '%s' "$id"
}
mapper_id() {
  "$KCADM" get "clients/$1/protocol-mappers/models" -r "$KEYCLOAK_REALM" --fields id,name --format csv --noquotes \
    | { grep ",$2\$" || true; } | cut -d, -f1
}
ensure_mapper() {
  local client="$1" name="$2" kind="$3" id
  shift 3
  id="$(mapper_id "$client" "$name")"
  if [ -n "$id" ]; then
    local actual
    actual="$("$KCADM" get "clients/$client/protocol-mappers/models/$id" -r "$KEYCLOAK_REALM" --fields protocolMapper --format csv --noquotes)"
    [ "$actual" = "$kind" ] || { echo "Conflicting mapper $name." >&2; exit 1; }
    "$KCADM" update "clients/$client/protocol-mappers/models/$id" -r "$KEYCLOAK_REALM" "$@"
  else
    "$KCADM" create "clients/$client/protocol-mappers/models" -r "$KEYCLOAK_REALM" \
      -s "name=$name" -s protocol=openid-connect -s "protocolMapper=$kind" -s consentRequired=false "$@"
  fi
}

home_group="$("$KCADM" get groups -r "$KEYCLOAK_REALM" -q 'search=home-assistant-users' --fields id,name --format csv --noquotes \
  | { grep ',home-assistant-users$' || true; } | cut -d, -f1)"
if [ -z "$home_group" ]; then
  "$KCADM" create groups -r "$KEYCLOAK_REALM" -s name=home-assistant-users
  home_group="$("$KCADM" get groups -r "$KEYCLOAK_REALM" -q 'search=home-assistant-users' --fields id,name --format csv --noquotes \
    | { grep ',home-assistant-users$' || true; } | cut -d, -f1)"
fi
if [ -z "$home_group" ] || [[ "$home_group" == *$'\n'* ]] ||
  [ "$("$KCADM" get "groups/$home_group" -r "$KEYCLOAK_REALM" --fields path --format csv --noquotes)" != '/home-assistant-users' ]; then
  echo 'Expected exactly one top-level home-assistant-users group.' >&2
  exit 1
fi
home_discovery_name=home-assistant-discovery
home_discovery_marker=/gateway-identity/home-assistant-discovery.id
home_discovery_user="$("$KCADM" get users -r "$KEYCLOAK_REALM" -q "username=$home_discovery_name" -q exact=true --fields id --format csv --noquotes)"
if [ -z "$home_discovery_user" ]; then
  if [ -e "$home_discovery_marker" ]; then
    echo 'The managed Home Assistant discovery identity was removed; refusing to recreate it automatically.' >&2
    exit 1
  fi
  "$KCADM" create users -r "$KEYCLOAK_REALM" -s "username=$home_discovery_name" -s enabled=true -s emailVerified=true \
    -s 'email=home-assistant-discovery@example.test' -s firstName=Home -s lastName=Discovery
  home_discovery_user="$("$KCADM" get users -r "$KEYCLOAK_REALM" -q "username=$home_discovery_name" -q exact=true --fields id --format csv --noquotes)"
  [ -n "$home_discovery_user" ] && [[ "$home_discovery_user" != *$'\n'* ]] || { echo 'Expected one Home Assistant discovery identity.' >&2; exit 1; }
  "$KCADM" set-password -r "$KEYCLOAK_REALM" --username "$home_discovery_name" --new-password="$GATEWAY_HOME_DISCOVERY_PASSWORD"
  "$KCADM" update "users/$home_discovery_user/groups/$home_group" -r "$KEYCLOAK_REALM" -n
  umask 077
  printf '%s\n' "$home_discovery_user" > "$home_discovery_marker"
else
  [[ "$home_discovery_user" != *$'\n'* ]] || { echo 'Expected one Home Assistant discovery identity.' >&2; exit 1; }
  if [ ! -f "$home_discovery_marker" ] || [ "$(cat "$home_discovery_marker")" != "$home_discovery_user" ]; then
    echo 'Home Assistant discovery identity already exists and is not managed by this setup.' >&2
    exit 1
  fi
fi
if [ "$("$KCADM" get "users/$home_discovery_user" -r "$KEYCLOAK_REALM" --fields enabled --format csv --noquotes)" != 'true' ]; then
  echo 'Home Assistant discovery identity is disabled; it was not re-enabled.' >&2
  exit 1
fi
home_discovery_groups="$("$KCADM" get "users/$home_discovery_user/groups" -r "$KEYCLOAK_REALM" --fields path --format csv --noquotes)"
if [ "$home_discovery_groups" != '/home-assistant-users' ]; then
  echo 'Home Assistant discovery identity must belong only to home-assistant-users; group membership was not changed.' >&2
  exit 1
fi

web="$(ensure_client "$GATEWAY_RESOURCE")"
"$KCADM" update "clients/$web" -r "$KEYCLOAK_REALM" \
  -s enabled=true -s publicClient=false -s "secret=$GATEWAY_WEB_CLIENT_SECRET" \
  -s standardFlowEnabled=true -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=false -s fullScopeAllowed=false \
  -s "redirectUris=[\"$GATEWAY_SCHEME://$HOST/oauth2/callback/keycloak\"]" -s 'webOrigins=[]' \
  -s 'attributes."standard.token.exchange.enabled"=true'
m2m="$(ensure_client mcp-gateway-m2m)"
"$KCADM" update "clients/$m2m" -r "$KEYCLOAK_REALM" \
  -s enabled=true -s publicClient=false -s "secret=$GATEWAY_M2M_CLIENT_SECRET" \
  -s standardFlowEnabled=false -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=true -s fullScopeAllowed=false
if ! "$KCADM" get roles/mcp-discovery -r "$KEYCLOAK_REALM" >/dev/null 2>&1; then
  "$KCADM" create roles -r "$KEYCLOAK_REALM" -s name=mcp-discovery \
    -s 'description=May discover MCP tools without invoking them'
fi
if [ "$("$KCADM" get roles/mcp-discovery -r "$KEYCLOAK_REALM" --fields composite --format csv --noquotes)" != 'false' ]; then
  echo 'The discovery role must not be composite.' >&2
  exit 1
fi
discovery="$(ensure_client mcp-gateway-discovery)"
"$KCADM" update "clients/$discovery" -r "$KEYCLOAK_REALM" \
  -s enabled=true -s publicClient=false -s "secret=$GATEWAY_DISCOVERY_CLIENT_SECRET" \
  -s standardFlowEnabled=false -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=true -s fullScopeAllowed=true
discovery_user="$("$KCADM" get "clients/$discovery/service-account-user" -r "$KEYCLOAK_REALM" --fields id --format csv --noquotes)"
[ -n "$discovery_user" ] || { echo 'Discovery service account not found.' >&2; exit 1; }
"$KCADM" add-roles -r "$KEYCLOAK_REALM" --uid "$discovery_user" --rolename mcp-discovery
vscode="$(ensure_client mcp-gateway-vscode)"
"$KCADM" update "clients/$vscode" -r "$KEYCLOAK_REALM" -s enabled=true -s publicClient=true \
  -s standardFlowEnabled=true -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=false -s fullScopeAllowed=false \
  -s 'redirectUris=["http://127.0.0.1:33418/","https://vscode.dev/redirect"]' -s 'webOrigins=[]' \
  -s 'attributes."pkce.code.challenge.method"=S256'

home_oidc="$(ensure_client home-assistant-oidc)"
"$KCADM" update "clients/$home_oidc" -r "$KEYCLOAK_REALM" -s enabled=true -s publicClient=true \
  -s standardFlowEnabled=true -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=false -s fullScopeAllowed=false \
  -s "redirectUris=[\"https://$HOMEASSISTANT_HOSTNAME/auth/oidc/callback\"]" -s 'webOrigins=[]' \
  -s 'attributes."pkce.code.challenge.method"=S256'
home_resource="$(ensure_client "$HOME_TARGET")"
"$KCADM" update "clients/$home_resource" -r "$KEYCLOAK_REALM" -s enabled=true -s bearerOnly=true \
  -s standardFlowEnabled=false -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=false

for client in "$vscode" "$web" "$home_oidc"; do
  ensure_mapper "$client" sdlc-mcp-groups oidc-group-membership-mapper \
    -s 'config."claim.name"=groups' -s 'config."full.path"=false' \
    -s 'config."id.token.claim"=true' -s 'config."access.token.claim"=true' -s 'config."userinfo.token.claim"=true'
done
ensure_mapper "$vscode" sdlc-gateway-audience oidc-audience-mapper \
  -s "config.\"included.client.audience\"=$GATEWAY_RESOURCE" -s 'config."access.token.claim"=true' -s 'config."id.token.claim"=false'

for entry in "mcp-gateway-root|$GATEWAY_SCHEME://$HOST" "mcp-gateway-virtual|$GATEWAY_SCHEME://$HOST/virtual/sdlc/mcp"; do
  name="${entry%%|*}"
  resource="${entry#*|}"
  id="$(ensure_client "$name")"
  "$KCADM" update "clients/$id" -r "$KEYCLOAK_REALM" -s enabled=true -s bearerOnly=true \
    -s standardFlowEnabled=false -s directAccessGrantsEnabled=false -s "attributes.resource_url=$resource"
done

for target in "$FORGEJO_TARGET" "$WIKI_TARGET" "$HOME_TARGET"; do
  target_uuid="$(client_id "$target")"
  [ -n "$target_uuid" ] || { echo "Keycloak backend client $target does not exist." >&2; exit 1; }
  scope_id="$("$KCADM" get client-scopes -r "$KEYCLOAK_REALM" --fields id,name --format csv --noquotes \
    | { grep ",$target\$" || true; } | cut -d, -f1)"
  if [ -z "$scope_id" ]; then
    "$KCADM" create client-scopes -r "$KEYCLOAK_REALM" -s "name=$target" -s protocol=openid-connect \
      -s 'description=Optional audience for the local MCP gateway exchange'
    scope_id="$("$KCADM" get client-scopes -r "$KEYCLOAK_REALM" --fields id,name --format csv --noquotes \
      | { grep ",$target\$" || true; } | cut -d, -f1)"
    "$KCADM" create "client-scopes/$scope_id/protocol-mappers/models" -r "$KEYCLOAK_REALM" \
      -s name=sdlc-backend-audience -s protocol=openid-connect -s protocolMapper=oidc-audience-mapper \
      -s "config.\"included.client.audience\"=$target" -s 'config."access.token.claim"=true' -s 'config."id.token.claim"=false'
  else
    mapper="$("$KCADM" get "client-scopes/$scope_id/protocol-mappers/models" -r "$KEYCLOAK_REALM" --fields name --format csv --noquotes)"
    [ "$mapper" = 'sdlc-backend-audience' ] || { echo "Conflicting audience scope $target." >&2; exit 1; }
  fi
  "$KCADM" update "clients/$web/optional-client-scopes/$scope_id" -r "$KEYCLOAK_REALM" -n
  "$KCADM" update "clients/$discovery/optional-client-scopes/$scope_id" -r "$KEYCLOAK_REALM" -n
done
echo 'Gateway Keycloak clients and audience scopes are configured.'
