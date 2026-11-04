#!/bin/sh
set -eu

for directory in /state /forgejo /wikijs /homeassistant; do
  [ -d "$directory" ] || { echo "Missing MCP certificate volume: $directory" >&2; exit 1; }
  chown 1000:1000 "$directory"
  chmod 0700 "$directory"
done
