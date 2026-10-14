---
title: Seams and dependencies
description: The libraries that authtempo uses, the seam that holds each one, and what happens on the day one changes.
type: explanation
sources:
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 2
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 13
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 8.3
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 18
  - pnpm-workspace.yaml
---

**For:** a reviewer who must judge the supply chain of authtempo, or a developer who replaces a library.

**What it does:** this page lists each library, the seam around it, and the promise that stays with core.

## Before you start

- Read [Architecture](/docs/concepts/architecture/) for the rule "own what you sell".

## The rule of a seam

Each supplier sits behind one module that does not carry its name. A replacement plugs into the same calls. No code outside the seam imports the library, with two exceptions that the table marks: zod in the routes, and postgres in two packages. So a change of the library changes one file, and no promise of the product.

## The libraries

| Library | Version | Role | Seam |
| --- | --- | --- | --- |
| jose | 6.2.12 | Verifies the ID tokens of Google, Apple, and the OIDC providers, reads their key sets, and signs the Apple client secret | `core/src/seams/jwt.ts` |
| @simplewebauthn/server | 14.0.3 | The two passkey ceremonies: generate and verify | `core/src/seams/webauthn.ts` |
| zod | 4.6.5 | Checks the request bodies | Direct, in the routes only |
| postgres | 3.4.9 | The Postgres driver | `@authtempo/adapter-postgres`, and the run time of the `@authtempo/import` CLI |
| @noble/hashes | 2.4.0 | The scrypt verify of Better Auth hashes, and the scrypt, Argon2id, and PBKDF2 verify of imported hashes | `compat-better-auth/src/hash.ts`, `legacy-hashes/src/derive.ts` |
| bcryptjs | 3.0.3 | The bcrypt verify of imported hashes | `legacy-hashes/src/derive.ts` |

Web Crypto gives the hashes, the random values, the HMACs, the seals, and the signatures. It is a platform API, not a library.

## What core owns

- **The tokens that core signs.** Core signs its session JWTs, its access tokens, and its ID tokens on Web Crypto. jose verifies the ID tokens of other issuers. jose also signs the Apple client secret, through the same seam.
- **The password hash.** The default is PBKDF2 on Web Crypto, through the hash seam `core/src/seams/password-hash.ts`. The stored form names its algorithm, so a later seam can replace it and rehash at sign-in.
- **The limits.** The adapters ship a limiter on the app's own database. A limit is never only a setting of a supplier.
- **The search of the docs.** The search index is a file of the docs build. No search service holds it.

## The day a library changes

- A new version of a library is a change in its seam file and its tests. The tests of the flows run on the seam, so they show a change of behavior.
- A library that stops is replaced in its seam. jose can go to another JWT library. @simplewebauthn/server can go to another WebAuthn library.
- A library that adds a feature changes nothing until the seam uses it.

## How a version is chosen

Each version is pinned exact. A new version must be at least one day old, by the `minimumReleaseAge` of the workspace. An install script of a new package must be read, and listed in `allowBuilds` with the reason, or the package is refused.

## Next

- [Architecture](/docs/concepts/architecture/)
- [The evidence rules](/docs/concepts/evidence/)
- [The threat model](/docs/concepts/threat-model/)
