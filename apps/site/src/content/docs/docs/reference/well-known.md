---
title: Well-known documents
description: The metadata documents that auth.wellKnown serves at the origin root for the OAuth provider.
type: reference
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.13
  - packages/core/src/http/well-known.ts
  - packages/core/README.md "OAuth 2.1 and OIDC provider"
---

**For:** a developer who runs the OAuth provider, or a client that reads its metadata.

**What it does:** `auth.wellKnown(request)` serves three documents at the origin root. Mount it for each path that starts with `/.well-known/`.

## Before you start

- Set `oauth` in the config. While `oauth` is off, every path answers 404.

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

- `code_challenge_methods_supported` is `["S256"]`.
- `token_endpoint_auth_methods_supported` is `["none"]`. Every client is public.
- The signing algorithm list names the configured `jwtMint.alg` alone, EdDSA or ES256. Core does not sign with RS256.
- `registration_endpoint` is present while `oauth.registration.dynamic` is on.
- `client_id_metadata_document_supported` tells whether `oauth.registration.cimd` is on.

## Next

- [Be the OAuth and OIDC provider for MCP clients](/docs/guides/oauth-provider/)
- [Routes](/docs/reference/routes/#get-oauth-authorize)
- [Tokens and prefixes](/docs/reference/tokens/)
