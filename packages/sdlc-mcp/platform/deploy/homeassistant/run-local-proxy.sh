#!/usr/bin/with-contenv sh
set -eu
export XDG_DATA_HOME=/sdlc-caddy-data
export XDG_CONFIG_HOME=/tmp/sdlc-caddy-config
exec /usr/local/bin/caddy run --config /scripts/Caddyfile --adapter caddyfile
