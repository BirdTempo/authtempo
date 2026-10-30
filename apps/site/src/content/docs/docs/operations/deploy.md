---
title: Deploy
description: Put an API with authtempo into production on Workers, on Node, or on Bun, with every setting that a deploy needs.
type: how-to
sources:
  - examples/worker/wrangler.jsonc
  - README.md "Rules that the code enforces"
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 9
  - packages/core/README.md "Limits in version 1"
  - docs/superpowers/plans/2026-10-14-11a-docs-site.md "Task 13"
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 31
  - docs/superpowers/plans/2026-10-14-12h-observability.md "Task 13"
sidebar:
  order: 1
---

**For:** an operator who deploys an API with authtempo for the first time.

**What it does:** this guide lists each setting of a production deploy, and the fault that each one prevents.

## Before you start

- An API that passes its tests. Do a [getting started tutorial](/docs/start/) first.
- A Cloudflare account, on Workers. With `password`, a Workers Paid plan.

## Steps

1. Set `baseURL` to the origin of the API, with `https:`.
2. Put each origin of the app in `trustedOrigins`, and each app scheme of a native app.
3. Store `secret` as a secret of 32 characters or more, never in the code. It needs an estimate of 100 bits or more: make one with `openssl rand -base64 32`.
4. Use the owned limiter of your adapter: `createD1Limiter` or `createPostgresLimiter`.
5. Replace the mail port with a call to your mail provider.
6. Apply every migration before the first request. [Upgrades](/docs/operations/upgrades/) tells how.
7. Run `auth.api.sweepExpired()` on a schedule, such as once an hour.
8. Off Workers, pass `clientIp`, and read only the header that your server or proxy sets. Without it, every request with no client IP is one client for each per-IP limit. In the body budget, it is one client of 4 MiB.
9. Deploy.
10. Sign in once by each method that the API serves.
11. Run `authtempo check` with the base URL of the API. Each check must pass, or skip for a feature that is off.
12. Point a probe at `GET /auth/health`. With `observe.readiness: true`, point the readiness probe at `GET /auth/ready`.

## The probes

`GET /auth/health` answers 200 `{ "status": "ok" }` in every deployment. It reads no storage, so it shows that the process answers. `GET /auth/ready` exists only with `observe.readiness: true`. It checks the store, and answers 200 `{ "status": "ready" }` or 503 `not_ready` with the reason `storage` or `schema`. It holds one result for 10 seconds, so a probe that calls it often makes one storage call in each window. Neither route counts on a limiter.

On Workers, no host runs a probe. Point an external monitor at the route, once a minute:

```sh
curl -fsS https://api.example.com/auth/health
```

On Node, a container probe calls the route from inside the container:

```text
HEALTHCHECK --interval=30s CMD node -e "fetch('http://localhost:3000/auth/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
```

On Bun, the same probe runs with `bun`:

```text
HEALTHCHECK --interval=30s CMD bun -e "fetch('http://localhost:3000/auth/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
```

With `observe.readiness: true`, a probe can call `/auth/ready` in place of `/auth/health`. Then the container is healthy only while the store answers. With readiness off, `/auth/ready` answers 404, and the container stays unhealthy.

Use `GET`: a `HEAD` request to these routes answers 404.

## The Workers settings

| Setting | Value | Without it |
| --- | --- | --- |
| `compatibility_date` | `2026-09-30`, the date of the examples | Another date can change the default flags. |
| `compatibility_flags` on D1 | `no_nodejs_compat`, `no_nodejs_compat_v2` | Node.js compatibility is on by default from 2026-08-04. |
| `compatibility_flags` on Postgres | `nodejs_compat` | postgres.js cannot open a socket. |
| `triggers.crons` | `["17 * * * *"]` | Expired rows stay in the database forever. |
| `AUTH_SECRET` | `pnpm --filter my-app exec wrangler secret put AUTH_SECRET` | The secret lies in the config, readable by each person with the repo. |
| The plan | Workers Paid with `password` | One PBKDF2 hash needs more CPU than Workers Free gives one request. |

## How it behaves

- The memory limiter counts per isolate. On Workers the real limit is the limit times the isolate count, so it is for tests only.
- The default `clientIp` reads `cf-connecting-ip`. Only Cloudflare sets it, so off Workers a caller can set it.
- A request with no client IP counts against one shared IP budget.
- A host with no `clientIp` makes every caller with no client IP one client of 4 MiB in the budget of the large body reads. On Node or Bun, one caller that stalls large posts can hold that share. Then the SAML ACS, the Apple callback, and SCIM answer 503 to every caller with no client IP, for up to 10 s. The callers with an IP key still read.
- Keep the API on its own registrable domain. A sibling subdomain cannot set the `__Host-` session cookie, but it can set the trust cookie for the parent domain.

:::caution
Warning: a new `secret` that replaces the old value locks every user with the second factor out of it. Add it as a new version with the steps on [Secrets](/docs/operations/secrets/).
:::

## If it fails

- Every route answers 500 with a storage error: a migration is missing. The adapter throws `schema_mismatch` until the migrations run.
- [`origin_not_trusted`](/docs/reference/errors/#origin_not_trusted): the app's origin is not in `trustedOrigins`.
- [`rate_limited`](/docs/reference/errors/#rate_limited) for every caller: the host gives no client IP, so all callers share one budget.
- [`body_busy`](/docs/reference/errors/#body_busy) at the SAML ACS for every caller with no client IP: the host gives none, so one caller holds their one share.
- A sign-in request answers 500: the mail port throws.
- `GET /auth/ready` answers 503 `not_ready` with `schema`: a migration is missing. With `storage`, the store does not answer in 3 seconds, or it throws.
- `authtempo check` names a code. [authtempo check](/docs/reference/cli/check/) gives the fix of each code.

## Next

- [Secrets](/docs/operations/secrets/)
- [Observability](/docs/operations/observability/)
- [Runtimes and compatibility flags](/docs/reference/runtimes/)
