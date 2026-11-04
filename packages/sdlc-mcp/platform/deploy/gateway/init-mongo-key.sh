#!/bin/sh
set -eu

if [ ! -s /keyfile/key ]; then
  umask 077
  head -c 756 /dev/urandom | base64 > /keyfile/key
fi
chown 999:999 /keyfile/key
chmod 400 /keyfile/key
