#!/bin/sh
set -eu

if [ "${BIND_ADDRESS:-127.0.0.1}" != 127.0.0.1 ]; then
  echo 'The local MCP gateway requires BIND_ADDRESS=127.0.0.1.' >&2
  exit 1
fi
for hostname in "${KEYCLOAK_HOSTNAME:-auth.localhost}" "${GATEWAY_HOSTNAME:-mcp-gateway.localhost}"; do
  if ! printf '%s\n' "$hostname" | grep -Eq '^([A-Za-z0-9-]+\.)*localhost$'; then
    echo 'The local MCP gateway and Keycloak must use localhost hostnames.' >&2
    exit 1
  fi
done
