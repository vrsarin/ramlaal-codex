#!/bin/sh
set -eu
# LITELLM_MASTER_KEY=$(cat /run/secrets/litellm-key)
# export LITELLM_MASTER_KEY
exec litellm --config /app/config.yaml --host 0.0.0.0 --port 4000
