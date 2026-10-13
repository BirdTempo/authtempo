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
| `@tempo-auth/legacy-hashes` | Verifies bcrypt, Argon2id, PBKDF2, scrypt, and Firebase scrypt hashes at sign-in and rehashes to PBKDF2. Pure JavaScript. bcryptjs is BSD-3-Clause (see `NOTICE`). |
| `@tempo-auth/import` | `tempo-auth-import`: moves users from Supabase Auth, Clerk, Auth0, Firebase, Auth.js, and Cognito through the storage port. A second run writes nothing. |
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
| `pnpm typecheck:configs` | `tsc` on every `vitest*.config.ts` (one root task). |
| `pnpm lint` | Biome. |
| `pnpm build` | Emit `dist` for the publishable packages. |

## Rules that the code enforces

- A POST with an `Origin` header not in `trustedOrigins` gets 403.
- Every token is stored as a SHA-256 hash. The clear token appears once.
- A password row is a credential under the claim rule: a proof of an unverified address deletes it, except the row the verify link confirms.
- An API token is a credential of one verified user, never a session. Only a session creates or revokes one, and `auth.session` answers null to a token, so every route that needs a session refuses a token.
- No social provider widens the linking rule: an address counts as verified only when the provider says so with a boolean `true`. No provider access token or refresh token is stored or logged.
- A magic link is single use. Two clicks race for one conditional update.
- A compatibility package never widens a promise of core: an option that core cannot keep stops the factory at construction, and the one error lists every such option.
- A `next` path must start with `/` and not `//`. Anything else becomes `/`.
- Core, the D1 adapter, the compatibility package, legacy-hashes, and the
  import D1 Worker run on Workers with Node.js compatibility off. Workers turn
  it on by default from compatibility date 2026-08-04. So the example Worker
  and every Worker config of plan 9b set `no_nodejs_compat` and
  `no_nodejs_compat_v2`. The adapter-d1 test config sets none, and its comment
  says why. The example's test and the import package's test bundle their
  Worker and fail on any `node:` import. legacy-hashes runs its vectors in a
  proof Worker with both flags. The vitest pool cannot show
  this: it turns Node.js modules on for its own runner. The Postgres adapter
  needs `nodejs_compat`, and the import CLI runs on Node.
- An importer writes only rows that a core flow writes. An unverified source
  row stays unverified, and a second run of the same export writes nothing.
- At most two legacy password derives run at once per isolate, whatever
  seams an app chains: `@tempo-auth/legacy-hashes` and the Better Auth seam
  share core's `deriveGate`. The gate never refuses a sign-in.
- An import repair (`--repair`) writes only the rows that a `partial` record
  lacks, and never for a user that a claim verified since the import.
- A hook never widens a rank check or a limit. A before hook runs inside the
  flow's transaction, so a refusal leaves no row; an after hook runs after
  the commit, and a throw there is logged, never answered as a failure of a
  row that exists. The session hook may change `ip`, `userAgent`, and an
  `activeOrganizationId` of the user's own organizations only.
- An organization limit is a count in core (`organizations.limits`), never
  only a hook: the compatibility package maps Better Auth's numbers onto it.
- An email code is a proof of the address, as a magic link is. Core stores
  HMAC-SHA256 under the app secret of the row id and the code, keeps one
  live code per address, and spends a code at its fifth wrong guess. The
  guess count is a compare-and-set, so parallel guesses all count, on D1
  too.
- A TOTP code passes once. The check and the write of the last accepted
  step are one conditional update, so a replayed code fails on D1 and on
  Postgres. The secret is sealed with AES-256-GCM under a key from the app
  secret and bound to its user; the backup codes are keyed hashes. A
  second-factor challenge is a session in waiting: a reset and a password
  change delete it before they end the sessions.
- Core signs its tokens itself, on Web Crypto, with no supplier in the
  signing path. One key signs at a time, through a unique key; its private
  half is sealed under the app secret and bound to its key id. A retired key
  verifies for 24 hours and signs nothing. An OAuth code is spent at the
  first exchange, whatever the result; a refresh token used twice deletes
  its whole family; an access token passes only under its own resource.
- An OAuth consent decides on the request that core holds, not on the
  form: the form posts a short id, the held request ends at its first
  answer, and only the user that the page showed it to can answer it. A
  revoke under another client's id revokes nothing.
- With no `afterEnd` hook, a flow that ends sessions deletes them in one
  statement; with the hook, it deletes each row by id, so the hook fires
  once for each row that the flow ended.
