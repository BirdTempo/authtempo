# Real SAML fixtures (plan 12d Task 7)

Each file is a byte copy from a public test suite, fetched read-only on
2026-10-20 between 13:01 and 13:14 UTC (ruling 17 of plan 12d). Each URL
names the commit of the read. "Last change" is the last commit that changed
the file at that read. No file was edited after the copy.

## Accept list (Exclusive C14N, SHA-256, RSA-SHA256 on the Assertion)

| File | Source URL | Last change | SHA-256 of the copy | Valid clock |
| --- | --- | --- | --- | --- |
| `node-saml-root-signed-assertion-signed-1advice-signed.xml` | https://raw.githubusercontent.com/node-saml/node-saml/8ee28357955af8897d6a7acf4f05fb96aa89525a/test/static/signatures/valid/response.root-signed.assertion-signed.1advice-signed.xml | 54a1e0457f8e59a9b6947894072f7f9fb2bf8387 | 5c12b204e90de3e6ca5302581cbb0511997ac328cc1fefe3ccc03fcd9af10802 | 2020-09-25T16:30:00Z |
| `node-saml-root-signed-assertion-signed-2advice-signed.xml` | https://raw.githubusercontent.com/node-saml/node-saml/8ee28357955af8897d6a7acf4f05fb96aa89525a/test/static/signatures/valid/response.root-signed.assertion-signed.2advice-signed.xml | 54a1e0457f8e59a9b6947894072f7f9fb2bf8387 | 77cbee38f3859ac54ef8c254ecc2d77a040fe3526b4c0375c44588131a55a8ef | 2020-09-25T16:30:00Z |
| `node-saml-root-unsigned-assertion-signed-1advice-signed.xml` | https://raw.githubusercontent.com/node-saml/node-saml/8ee28357955af8897d6a7acf4f05fb96aa89525a/test/static/signatures/valid/response.root-unsigned.assertion-signed.1advice-signed.xml | 54a1e0457f8e59a9b6947894072f7f9fb2bf8387 | 1b8ef0ea175bc943c7c8807d2510e56e489d7dd490c367d9dfc79db5ccc3b487 | 2020-09-25T16:30:00Z |

The certificate of all three is `node-saml-cert.pem`, from
https://raw.githubusercontent.com/node-saml/node-saml/8ee28357955af8897d6a7acf4f05fb96aa89525a/test/static/cert.pem
(last change fa5b55d9a1773299e031a2b718a164949e640ae0, SHA-256
885bcdfc0552abeaa42e275a7a00e3c8eda0ddbc99942d064c979884b0be34c0). Its
`notAfter` is 2015-09-12T01:54:20Z: it verifies after that date, as spec 30
item 9 says. The valid clock is inside `NotBefore` 2020-09-25T16:00:00+00:00
and `NotOnOrAfter` 2020-09-25T17:00:00+00:00 of each Assertion.

Each of the three holds Advice Assertions with their own signatures, and two
sign the Response too, so they also hold ruling 19 (an inner enveloped
signature). One test suite made all three with one key. Their times end in
`+00:00`, not `Z`: the Response checks of Task 8 read a `Z` time only, so
these fixtures serve the signature check, not the whole Response check.

## Refused at `algorithm` (SHA-1)

| File | Source URL | Last change | SHA-256 of the copy | Signed element |
| --- | --- | --- | --- | --- |
| `node-saml-root-unsigned-assertion-signed-sha1.xml` | https://raw.githubusercontent.com/node-saml/node-saml/8ee28357955af8897d6a7acf4f05fb96aa89525a/test/static/signatures/valid/response.root-unsigned.assertion-signed.xml | 54a1e0457f8e59a9b6947894072f7f9fb2bf8387 | d820b9ce9ee926df7ba3250d4a317a698457b729d7fa595d1c3776928f6e8ce1 | Assertion |
| `crewjam-onelogin-response-sha1.base64` | https://raw.githubusercontent.com/crewjam/saml/346540312f721498fc75e69637d9250dd89f230b/testdata/TestSPCanHandleOneloginResponse_response | dbb13a85b906958362c63da2cacd2a6aebde1311 | 6df449716ac80e1820c3365d379adf1a4a5e8822c277e7fa901a1b278918f1ff | Response |

The certificate of the OneLogin Response is in
`crewjam-onelogin-idp-metadata.xml`, from
https://raw.githubusercontent.com/crewjam/saml/346540312f721498fc75e69637d9250dd89f230b/testdata/TestSPCanHandleOneloginResponse_IDPMetadata
(last change 60a32b32095ab361c827116afd3f0041874c6c9c, SHA-256
91e76d395c7900e2328aedf7d60992e259ab8aca3447d0fc850a8dd37505ea60). The
Response is base64 text, as the suite keeps it.

## Licenses

- node-saml/node-saml: MIT. `LICENSE-node-saml` is a copy of
  https://raw.githubusercontent.com/node-saml/node-saml/8ee28357955af8897d6a7acf4f05fb96aa89525a/LICENSE
  (SHA-256 1087d82ce57b6889801564d20d13e175680d423bf05369793ec2c8f310b10c3e).
- crewjam/saml: BSD 2-Clause. `LICENSE-crewjam-saml` is a copy of
  https://raw.githubusercontent.com/crewjam/saml/346540312f721498fc75e69637d9250dd89f230b/LICENSE
  (SHA-256 a335d6bb6742808eaddf489bc1725a0ea0b2fa07623c8d0932ddb2eda08d257f).

## Candidates read and not copied

- The ADFS Response of the OneLogin toolkits (python3-saml, ruby-saml,
  php-saml, java-saml: `adfs_response`), SHA-256 on the Assertion: both this
  verifier and xml-crypto 6.3.3 answer a digest mismatch (`reference`), so it
  is no valid signed Response.
- samlify `test/misc/response_signed_cert1.xml` and `cert2`: the signature
  covers the Issuer, not the Assertion. `signed_response_sha256.xml` has no
  Reference.
- crewjam `TestSPCanHandlePlaintextResponse_response` (TestShib), SHA-256:
  the signature is on the Response only, so its Assertion is unsigned.
- Every other Response of python3-saml, ruby-saml, php-saml, java-saml,
  samlify, xml-crypto, pysaml2, Clever/saml2, and crewjam/saml that the read
  found uses SHA-1, RSA-SHA256-MGF1, HMAC, or an encrypted Assertion.
