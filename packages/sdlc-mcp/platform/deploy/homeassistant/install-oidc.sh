#!/bin/sh
set -eu
if [ -f /target/.sdlc-oidc-version ]; then
  if [ "$(cat /target/.sdlc-oidc-version)" != '1.2.1' ]; then
    echo 'Existing Home Assistant OIDC component has a different managed version; upgrade explicitly.' >&2
    exit 1
  fi
  test -f /target/manifest.json || { echo 'Managed OIDC component is incomplete.' >&2; exit 1; }
  exit 0
fi
if [ -n "$(ls -A /target)" ]; then
  echo 'OIDC component volume is not empty and is not managed by this setup.' >&2
  exit 1
fi
cp -R /component/. /target/
printf '%s\n' '1.2.1' > /target/.sdlc-oidc-version
