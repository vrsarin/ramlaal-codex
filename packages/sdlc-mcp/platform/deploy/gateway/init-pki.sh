#!/bin/sh
set -eu

umask 077
mkdir -p /private/v2
if [ ! -f /private/v2/ca.key ] && [ ! -f /private/v2/ca.crt ] && [ ! -f /private/v2/server.key ] && [ ! -f /private/v2/server.crt ]; then
  openssl req -x509 -newkey rsa:3072 -nodes -days 3650 \
    -subj '/CN=Local MCP Gateway CA' -addext 'basicConstraints=critical,CA:TRUE' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' -addext 'subjectKeyIdentifier=hash' \
    -keyout /private/v2/ca.key -out /private/v2/ca.crt >/dev/null 2>&1
  openssl req -new -newkey rsa:2048 -nodes -subj '/CN=gateway-idp-tls' \
    -addext 'subjectAltName=DNS:gateway-idp-tls' \
    -addext 'keyUsage=critical,digitalSignature,keyEncipherment' -addext 'extendedKeyUsage=serverAuth' \
    -keyout /private/v2/server.key -out /private/v2/server.csr >/dev/null 2>&1
  openssl x509 -req -in /private/v2/server.csr -CA /private/v2/ca.crt -CAkey /private/v2/ca.key \
    -CAcreateserial -days 825 -copy_extensions copy -out /private/v2/server.crt >/dev/null 2>&1
fi
for file in /private/v2/ca.key /private/v2/ca.crt /private/v2/server.key /private/v2/server.crt; do
  [ -s "$file" ] || { echo "Gateway TLS material is incomplete; refusing to overwrite it." >&2; exit 1; }
done
openssl verify -CAfile /private/v2/ca.crt /private/v2/server.crt >/dev/null
openssl x509 -checkend 86400 -noout -in /private/v2/server.crt >/dev/null
cp /private/v2/ca.crt /public/ca-v2.crt
chmod 644 /public/ca-v2.crt
