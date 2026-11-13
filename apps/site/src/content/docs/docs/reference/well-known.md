---
title: Well-known documents
description: The metadata documents that auth.wellKnown serves at the origin root for the OAuth provider and for passkey related origins.
type: reference
sources:
  - packages/core/src/http/well-known.ts
  - packages/core/README.md "OAuth 2.1 and OIDC provider"
---

**For:** a developer who runs the OAuth provider, or a client that reads its metadata.

**What it does:** `auth.wellKnown(request)` serves the OAuth documents and the passkey related origins document at the origin root. Mount it for each path that starts with `/.well-known/`.

## Before you start

- Set `oauth` in the config. While `oauth` is off, every OAuth path answers 404. [OAuth provider](/docs/reference/config/#oauth-provider) lists its keys.
- For the related origins document, set `passkey.relatedOrigins: true`. [Passkeys](/docs/reference/config/#passkeys) lists its keys.

## The documents

The issuer is `baseURL` plus `basePath`, such as `https://api.example.com/auth`.

| Path | Document | Standard |
| --- | --- | --- |
| `/.well-known/oauth-authorization-server<basePath>` | The authorization server metadata | RFC 8414, section 3 |
| `/.well-known/oauth-authorization-server` | The same document | A form that some clients read |
| `/.well-known/openid-configuration` and `/.well-known/openid-configuration<basePath>` | The same document | OpenID Connect Discovery 1.0 |
| `/.well-known/oauth-protected-resource<resource path>` | The metadata of one `oauth.resources` entry | RFC 9728 |
| `/.well-known/oauth-protected-resource` | The metadata of the first `oauth.resources` entry on the origin | A form that some clients read |

- The routes `GET /.well-known/oauth-authorization-server` and `GET /.well-known/openid-configuration` under `basePath` answer the same document, for clients that read it under the issuer.
- A resource with the path `/mcp` has its document at `/.well-known/oauth-protected-resource/mcp`.

## The answers

- A GET answers 200 with `cache-control: public, max-age=300` and `access-control-allow-origin: *`.
- An OPTIONS answers 204 with the CORS headers of a GET.
- Any other method answers 405 with `allow: GET`.
- An unknown path answers 404.

## The fields

Each member states what the code does under the config, no more and no less. Each list reads the constant or the config value that the code reads.

| Member | Value |
| --- | --- |
| `issuer` | `baseURL` plus `basePath` |
| `authorization_endpoint`, `token_endpoint`, `revocation_endpoint`, `introspection_endpoint`, `end_session_endpoint`, `userinfo_endpoint` | The route under the issuer, such as `<issuer>/oauth/token` |
| `registration_endpoint` | `<issuer>/oauth/register`, present only while `oauth.registration.dynamic` is on |
| `device_authorization_endpoint` | `<issuer>/oauth/device_authorization`, present only while `oauth.device` is on |
| `jwks_uri` | `<issuer>/jwks` |
| `scopes_supported` | The built-in scopes and the keys of `oauth.scopes` |
| `response_types_supported` | `["code"]` |
| `response_modes_supported` | `["query"]`. Stated, because the RFC 8414 default adds `fragment` |
| `grant_types_supported` | `authorization_code`, `refresh_token`, and `client_credentials`; the device grant while `oauth.device` is on |
| `token_endpoint_auth_methods_supported`, `revocation_endpoint_auth_methods_supported` | `none`, `client_secret_basic`, `client_secret_post`, and `private_key_jwt` |
| `introspection_endpoint_auth_methods_supported` | The same list without `none`: introspection takes a confidential client only |
| `token_endpoint_auth_signing_alg_values_supported` | The algs of a client assertion: `EdDSA`, `Ed25519`, `ES256`, `RS256`, and `PS256` |
| `code_challenge_methods_supported` | `["S256"]` |
| `subject_types_supported` | `["public", "pairwise"]` |
| `id_token_signing_alg_values_supported` | The configured `jwtMint.alg` alone: EdDSA, ES256, or RS256 |
| `dpop_signing_alg_values_supported` | `oauth.dpop.algs` |
| `claims_supported` | The ID token claims and the user claims of the `email` and `profile` scopes |
| `request_parameter_supported`, `request_uri_parameter_supported`, `claims_parameter_supported` | `false` |
| `backchannel_logout_supported`, `backchannel_logout_session_supported` | True while `oauth.fetch` is set: core posts each sign-out token through it |
| `authorization_response_iss_parameter_supported` | `true`: every redirect to a client carries `iss` (RFC 9207) |
| `client_id_metadata_document_supported` | True while `oauth.registration.cimd` is on |

- A relying party that accepts RS256 only needs `jwtMint.alg: "RS256"`. Every JWT of the deployment then signs with RS256.
- A registration may ask only for what this document names, and it refuses the rest. It also refuses `client_credentials`, which only `api.oauth.clients` gives.

The document of a protected resource holds `resource`, `authorization_servers` (the issuer), `scopes_supported`, `bearer_methods_supported` (`["header"]`), and `dpop_signing_alg_values_supported` (`oauth.dpop.algs`).

## The related origins document

- `GET /.well-known/webauthn` answers `{ origins }`: the origins of `passkey.origins` outside the domain tree of `rpID`, in config order (WebAuthn Level 3).
- Only a request to the `rpID` host gets it, and only with `passkey.relatedOrigins: true`. Any other host answers 404.
- The answer has `content-type: application/json`, `cache-control: public, max-age=300`, and `access-control-allow-origin: *`.
- The ceremonies check each origin against `passkey.origins` again. The document tells the browser which origins may use the RP ID.

## Next

- [Be the OAuth and OIDC provider for MCP clients](/docs/guides/oauth-provider/)
- [Routes](/docs/reference/routes/#get-oauth-authorize)
- [Tokens and prefixes](/docs/reference/tokens/)
