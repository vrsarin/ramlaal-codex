#!/bin/sh
set -eu

if forgejo admin user list | awk 'NR > 1 { print $2 }' | grep -Fqx "$FORGEJO_ADMIN_USERNAME"; then
  forgejo admin user change-password \
    --username "$FORGEJO_ADMIN_USERNAME" \
    --password="$FORGEJO_ADMIN_PASSWORD" \
    --must-change-password=false
else
  forgejo admin user create \
    --username "$FORGEJO_ADMIN_USERNAME" \
    --password="$FORGEJO_ADMIN_PASSWORD" \
    --email "$FORGEJO_ADMIN_EMAIL" \
    --admin \
    --must-change-password=false
fi

oidc_id=$(forgejo admin auth list | awk '$2 == "Keycloak" { print $1; exit }')
oidc_discovery_url="https://$KEYCLOAK_HOSTNAME/realms/$KEYCLOAK_REALM/.well-known/openid-configuration"

if [ -n "$oidc_id" ]; then
  forgejo admin auth update-oauth \
    --id "$oidc_id" \
    --name Keycloak \
    --provider openidConnect \
    --key "$FORGEJO_OIDC_CLIENT_ID" \
    --secret="$FORGEJO_OIDC_CLIENT_SECRET" \
    --auto-discover-url "$oidc_discovery_url" \
    --scopes openid \
    --scopes profile \
    --scopes email \
    --group-claim-name forgejo_group_membership \
    --admin-group developers
else
  forgejo admin auth add-oauth \
    --name Keycloak \
    --provider openidConnect \
    --key "$FORGEJO_OIDC_CLIENT_ID" \
    --secret="$FORGEJO_OIDC_CLIENT_SECRET" \
    --auto-discover-url "$oidc_discovery_url" \
    --scopes openid \
    --scopes profile \
    --scopes email \
    --group-claim-name forgejo_group_membership \
    --admin-group developers
fi
