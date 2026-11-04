#!/bin/sh
set -eu
umask 077

if [ ! -e /secrets/ca-password ] && [ ! -e /secrets/provisioner-password ]; then
  openssl rand -base64 48 > /secrets/ca-password
  openssl rand -base64 48 > /secrets/provisioner-password
fi
for file in /secrets/ca-password /secrets/provisioner-password; do
  [ -s "$file" ] || { echo "Step CA password files are incomplete; refusing to replace them." >&2; exit 1; }
  chown 1000:1000 "$file"
  chmod 600 "$file"
done
chown 1000:1000 /secrets
chmod 700 /secrets
chown 1000:1000 /public
chmod 755 /public
