# tempo-auth

Authentication that the BirdTempo apps own. The engine, the flows, the
tokens, the cookies, and the tables are our code. Small audited libraries
supply primitives only, each behind a named seam.

Spec: `docs/superpowers/specs/2026-10-09-tempo-auth-design.md`.
Plans: `docs/superpowers/plans/README.md`.

## Packages

| Package | Role |
| --- | --- |
| `@tempo-auth/core` | The engine: `createAuth(config)` returns `handle`, `session`, and `api`. |
| `@tempo-auth/adapter-d1` | Storage on Cloudflare D1. Ships the migration. No compatibility flag. |
| `@tempo-auth/adapter-postgres` | Storage on Postgres through postgres.js. `nodejs_compat` on Workers. |
| `@tempo-auth/client` | The app side: `createClient` calls the routes and returns typed results. It runs in a browser, Expo, and Electron. |
| `@tempo-auth/handoff` | Native and desktop sign-in through the system browser, with openers for Expo and Electron. |
| `@tempo-auth/compat-better-auth` | Runs a Better Auth 1.7 app on tempo-auth through a package alias, on the app's own Better Auth tables. Fails at start on an option core cannot keep. |
| `examples/worker` | A Worker that mounts the engine. The end-to-end test runs against it. |

The example pins `@cloudflare/vitest-plugin` 1.4.0 and runs vitest 5.0.3, the same as core.

Organizations are in core behind `organizations: {}`. Passwords are in core behind `password: {}`; one hash needs Workers Paid.

The D1 and Postgres adapters ship an owned limiter on the `ta_limit` table. The memory limiter is for tests. `auth.api.sweepExpired()` deletes expired rows, including limit windows, and runs from a scheduled handler.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Install. pnpm 12.8.1, Node 22 or newer. |
| `docker compose up -d` | Start Postgres on port 5439. Run it before `pnpm test`. The Postgres tests fail without it. |
| `pnpm test` | Run every package's tests through Turborepo. The cache is off for tests. |
| `pnpm typecheck` | `tsc --noEmit` in every package. |
| `pnpm lint` | Biome. |
| `pnpm build` | Emit `dist` for the publishable packages. |

## Rules that the code enforces

- A POST with an `Origin` header not in `trustedOrigins` gets 403.
- Every token is stored as a SHA-256 hash. The clear token appears once.
- A password row is a credential under the claim rule: a proof of an unverified address deletes it, except the row the verify link confirms.
- A magic link is single use. Two clicks race for one conditional update.
- A compatibility package never widens a promise of core: an option that core cannot keep stops the factory at construction, and the one error lists every such option.
- A `next` path must start with `/` and not `//`. Anything else becomes `/`.
- The core runs on Workers with no compatibility flag. The example Worker
  has none, and its test fails if the core gains a Node dependency.
