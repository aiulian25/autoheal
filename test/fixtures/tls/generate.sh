#!/usr/bin/env bash
# Test-only certificates, generated on demand and never committed: a trusted CA and an
# untrusted CA, each with a server certificate valid for the names the tests use.
set -euo pipefail
cd "$(dirname "$0")"
if [[ -f trusted-ca.pem && -f server.pem && -f untrusted-server.pem ]]; then
  exit 0
fi

server_names="DNS:localhost,IP:127.0.0.1,IP:::1,DNS:control-plane,DNS:ollama,DNS:gotify"
days=36500

make_authority() {
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days "$days" \
    -subj "/CN=$2" -keyout "$1-ca-key.pem" -out "$1-ca.pem" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
}

make_server() {
  local authority=$1 name=$2
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=autoheal-test" \
    -keyout "$name-key.pem" -out "$name.csr" 2>/dev/null
  openssl x509 -req -in "$name.csr" -CA "$authority-ca.pem" -CAkey "$authority-ca-key.pem" -CAcreateserial \
    -days "$days" -out "$name.pem" 2>/dev/null -extfile <(printf '%s\n' \
      "subjectAltName=$server_names" "basicConstraints=CA:FALSE" \
      "keyUsage=digitalSignature" "extendedKeyUsage=serverAuth,clientAuth")
  rm -f "$name.csr"
}

make_authority trusted "Autoheal test CA"
make_authority untrusted "Someone else's CA"
make_server trusted server
make_server untrusted untrusted-server
rm -f ./*.srl
# Readable by the container's non-root user in smoke tests; these keys protect nothing.
chmod 644 ./*.pem
