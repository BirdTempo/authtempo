#!/bin/sh
# Makes the TLS fixtures of test/transport-identity.test.ts: a test CA and a
# leaf certificate for other.example, signed by that CA. Run it with OpenSSL
# 3.4 or later, which has -not_before and -not_after. The CA key is not kept,
# so each run makes a new CA. Both certificates end on 2036-11-03. After that
# date, the chain check fails the test: run this script again.
set -eu
cd "$(dirname "$0")"
NOT_BEFORE=20261103000000Z
NOT_AFTER=20361103000000Z
openssl req -x509 -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -noenc \
  -keyout ca.key -out ca.crt -subj "/CN=authtempo CLI test CA" \
  -not_before "$NOT_BEFORE" -not_after "$NOT_AFTER" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -noenc \
  -keyout leaf.pem -out leaf.csr -subj "/CN=other.example" \
  -addext "subjectAltName=DNS:other.example" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=serverAuth"
openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -set_serial 2 \
  -copy_extensions copyall -not_before "$NOT_BEFORE" -not_after "$NOT_AFTER" \
  -out leaf.crt
{
  echo "A TEST KEY of the authtempo CLI tests (test/transport-identity.test.ts)."
  echo "It guards nothing. Never use it outside these tests."
  cat leaf.pem
} >leaf.key
rm -f ca.key leaf.pem leaf.csr
