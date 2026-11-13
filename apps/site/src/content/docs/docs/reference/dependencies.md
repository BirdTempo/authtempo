---
title: Dependencies
description: Each package that an app installs with a released authtempo package, with its version, its user, and the reason it is there.
type: reference
sources:
  - release/dependencies.json
---

**For:** a developer or a security reviewer who must know what an app installs with authtempo.

**What it does:** this page lists each runtime dependency and each peer dependency of the released packages, from `release/dependencies.json`. A site check holds each table row to the file, both ways.

## Before you start

- Read [Security policy](/docs/reference/security-policy/) for how a supplier advisory is recorded.

## The rule

Each direct dependency of a workspace package has a row in `release/dependencies.json`, with its users, its reason, and the date of the read. A runtime row also names its seam: the one module that calls the package. The release check `check-dependencies` fails on a dependency with no row. It also fails on a license outside MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, and 0BSD in the runtime closure, except an exemption of `release/license-exempt.json`. The release check `check-osv` fails on an open advisory of the closure.

A runtime dependency installs with the package. A peer dependency is a package that the app installs itself, at a version in the range. The column "Used by" names the released packages only.

## The dependencies

| Package | Kind | Versions | Used by | Reason |
| --- | --- | --- | --- | --- |
| `@libsql/client` | peer | `^0.18.0` | `@authtempo/adapter-sqlite` | The app brings its own libSQL client for a remote libSQL database, and the libsql entry of the SQLite adapter uses that client. The peer is optional. |
| `@libsql/client` | runtime | `0.18.0` | `@authtempo/cli` | The CLI opens a libSQL database with it for migrate and check. The seam loads it only for a libSQL URL. |
| `@libsql/core` | runtime | `0.18.0` | `@authtempo/cli` | The CLI reads a libSQL URL with its config and URI parsers, so the transport rule judges the host that the driver connects to. |
| `@modelcontextprotocol/server` | runtime | `2.3.1` | `@authtempo/mcp` | The MCP server package and the MCP example answer the protocol with it (spec 13, update of 2026-10-14). |
| `@noble/hashes` | runtime | `2.4.0` | `@authtempo/compat-better-auth`, `@authtempo/legacy-hashes` | The compat package verifies Better Auth scrypt hashes with it, and legacy-hashes derives the old hash forms with it (spec 13). |
| `@simplewebauthn/server` | runtime | `14.0.3` | `@authtempo/core` | Core runs the WebAuthn ceremonies with it (spec 13). |
| `@solidjs/start` | peer | `^2.0.6` | `@authtempo/solid` | The app brings its own SolidStart; the Solid package binds to that copy. |
| `@sveltejs/kit` | peer | `^3.0.1` | `@authtempo/sveltekit` | The app brings its own SvelteKit; the SvelteKit package binds to that copy. |
| `astro` | peer | `^7.3.8` | `@authtempo/astro` | The app brings its own Astro; the Astro package binds to that copy. |
| `bcryptjs` | runtime | `3.0.3` | `@authtempo/legacy-hashes` | legacy-hashes verifies imported bcrypt hashes with it (spec 13, amendment of 2026-10-11). |
| `better-sqlite3` | peer | `^13.0.3` | `@authtempo/adapter-sqlite` | The app brings its own better-sqlite3 database, and the better-sqlite3 entry of the SQLite adapter uses it. The peer is optional. |
| `express` | peer | `^5.2.1` | `@authtempo/express` | The app brings its own Express; the Express package binds to that copy. |
| `fastify` | peer | `^5.12.5` | `@authtempo/fastify` | The app brings its own Fastify; the Fastify package binds to that copy. |
| `h3` | peer | `^1.15.11` | `@authtempo/vue` | The app brings its own h3; the Vue package binds its server helpers to that copy. |
| `hono` | peer | `^4.13.13` | `@authtempo/hono` | The app brings its own Hono; the Hono package binds to that copy. |
| `jose` | runtime | `6.2.12` | `@authtempo/core` | Core verifies ID tokens and fetches each JWKS with it (spec 13). |
| `mysql2` | peer | `^3.24.5` | `@authtempo/adapter-mysql` | The app brings its own mysql2 pool and opens the database, and the MySQL adapter uses that pool. |
| `mysql2` | runtime | `3.24.5` | `@authtempo/cli` | The CLI connects to MySQL with it for migrate and check. |
| `next` | peer | `^16.4.0` | `@authtempo/next` | The app brings its own Next.js; the Next.js package binds to that copy. |
| `parseurl` | runtime | `1.3.3` | `@authtempo/express` | The Express adapter reads the raw path and query of the request line with it, as the Express router does. |
| `postgres` | peer | `^3.4.9` | `@authtempo/adapter-postgres`, `@authtempo/compat-better-auth` | The app brings its own postgres driver and opens the database; the Postgres adapter and the compat package use that client. |
| `postgres` | runtime | `3.4.9` | `@authtempo/cli` | The CLI connects to Postgres with it for migrate and import, and two examples open their database with it (spec 13). |
| `react` | peer | `^19.0.0` | `@authtempo/compat-better-auth`, `@authtempo/react` | The app brings its own React; the React package and the compat client hooks bind to that copy. |
| `react-router` | peer | `^8.4.0` | `@authtempo/react-router` | The app brings its own React Router; the React Router package binds to that copy. |
| `solid-js` | peer | `^1.9.17` | `@authtempo/solid` | The app brings its own Solid; the Solid package binds to that copy. |
| `vitest` | peer | `^5.0.3` | `@authtempo/client`, `@authtempo/core` | The conformance kits of core and client import vitest. An adapter, a limiter, or an SDK runs a kit in its own test run, which brings vitest. The peer is optional. |
| `vue` | peer | `^3.5.43` | `@authtempo/vue` | The app brings its own Vue; the Vue package binds to that copy. |
| `zod` | runtime | `4.6.6` | `@authtempo/core`, `@authtempo/mcp` | Core validates each request body with it, and the MCP server declares its tool schemas with it (spec 13). |

## Next

- [Security policy](/docs/reference/security-policy/)
- [Deprecations](/docs/reference/deprecations/)
- [Resources](/docs/resources/)
