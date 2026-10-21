# authtempo

Authentication you own. The engine, the flows, the tokens, the cookies,
and the tables are your code. Small audited libraries supply primitives
only, each behind a named seam.

Spec: `docs/superpowers/specs/2026-10-09-tempo-auth-design.md`.
Plans: `docs/superpowers/plans/README.md`.

## Packages

| Package | Role |
| --- | --- |
| `@authtempo/core` | The engine: `createAuth(config)` returns `handle`, `session`, and `api`. |
| `@authtempo/adapter-d1` | Storage on Cloudflare D1. Ships the migration. No compatibility flag. |
| `@authtempo/adapter-postgres` | Storage on Postgres through postgres.js. `nodejs_compat` on Workers. |
| `@authtempo/client` | The app side: `createClient` calls the routes and returns typed results. It runs in a browser, Expo, and Electron. |
| `@authtempo/handoff` | Native and desktop sign-in through the system browser, with openers for Expo and Electron. |
| `@authtempo/verify` | Tells a resource server who the caller is: it reads the bearer of a request and verifies the access token. It imports no Node module. `@authtempo/verify/mcp` gives `requireMcpAuth` for an app's own MCP server. |
| `@authtempo/compat-better-auth` | Runs a Better Auth 1.7 app on authtempo through a package alias, on the app's own Better Auth tables. Fails at start on an option core cannot keep. |
| `@authtempo/legacy-hashes` | Verifies bcrypt, Argon2id, PBKDF2, scrypt, and Firebase scrypt hashes at sign-in and rehashes to PBKDF2. Pure JavaScript. bcryptjs is BSD-3-Clause (see `NOTICE`). |
| `@authtempo/import` | The readers and `importUsers`: moves users from Supabase Auth, Clerk, Auth0, Firebase, Auth.js, Cognito, and WorkOS through the storage port. A second run writes nothing. The command is `authtempo import` in `@authtempo/cli`. `authtempo import verify` checks that the database holds the whole export. |
| `@authtempo/cli` | `authtempo`: `init` (a new app from the example of a stack), `migrate` (Postgres and D1, after the version gate), `import`, `check` (a deployment against core's promises), and `keys rotate`. It also has `secret` (a new app secret or operator secret) and `info` (a support report with no secret value). `secret status` and `secret rewrap` count and reseal the rows of each secret version. Node 22 or newer. `authtempo-import` stays for one release. |
| `@authtempo/observe` | Owned sinks for the events of core: Workers Logs, Analytics Engine, and OTLP JSON over HTTP. No runtime dependency. |
| `@authtempo/mcp` | `authtempo-mcp`: the MCP server for a coding agent. On stdio in the project, it serves `docs.search`, `docs.read`, `version`, `scaffold`, `migrate.plan`, `migrate.run`, `schema.migrate`, and `check`. The last five tools run the CLI in process. The remote Worker serves only the tools `docs.search`, `docs.read`, and `version`, with the docs resources and the prompts, at the planned address `https://mcp.authtempo.com/mcp` (`REMOTE_MCP_URL`). `authtempo mcp` writes its editor config. |
| `@authtempo/site` | The docs and the root pages: one Worker of static assets. Private; the owner publishes it. |
| `@authtempo/demo` | The demo Worker: each sign-in method on test data, one Durable Object per visitor sandbox, deleted 60 minutes after it starts. Private; the owner publishes it at a planned address. |
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
  seams an app chains: `@authtempo/legacy-hashes` and the Better Auth seam
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
- No flag of `authtempo` takes a secret as its value. A connection string
  and the operator secret come from the name of a variable or a file, and
  no output line holds a secret that the command read.
- `authtempo secret` prints a new secret once, or writes it to a new file
  that only its owner can read, and replaces no file.
- `authtempo migrate` reads the schema version first and stops, before any
  write, on a database newer than its core. `authtempo check` counts a
  skipped check as no pass, and exits 1 on any failure.
- No tool of `authtempo-mcp` takes a secret as an input, and no tool writes
  outside the folder that the editor starts it in. A write to a database
  needs a plan of the same server run and `confirm: true`.
- The remote MCP server serves the docs only, holds no user data, and limits
  each caller in its own code before any supplier limit.
- The OpenAPI document lists exactly the routes of `ROUTES`, and each code
  that a route answers is in `ERRORS` or `OAUTH_ERRORS`. Core's test run
  holds every answer to its schema.
- A move from another provider ends with `authtempo import verify`, which
  exits 0 only when the database holds the whole export. A compat file of
  the Better Auth path is never edited: an edited copy stops the next
  `authtempo migrate`.
- The site and the demo load nothing from another origin and set no
  tracker. The site sets no cookie.
- The demo holds no secret and sends no request out of its Worker. Each
  limit of the demo is our own code.
- Every operator act writes an audit row in the transaction of the act. Core
  never changes or deletes an audit row. An operator secret reaches only the
  scopes of its config entry, and an impersonation never reaches an operator
  route, a re-authentication, or a second-factor change.
- Core sends no event anywhere without a sink of the app. With no sink it
  writes only the fault lines it wrote before plan 12h, plus one line when
  the waitUntil of the app throws. No event holds a secret, a credential,
  free text, or a raw email.

## Owner-run items of the site and the demo

The owner runs or decides each item below. No task of plan 11b runs one. This is the one list for `apps/site` and `apps/demo`.

### Publication

- The site: publish the site Worker and add its custom domain. Publication is on hold since 2026-10-11. Until then no reader sees the root pages.
- `/pricing/` and `/security/`: do not publish them before plan 12j sets the license. Until then `/pricing/` says "The license is not set yet.", and `/security/` says that the reporting channel is not set yet.
- `REPO_URL`: set the repository address for the GitHub link of the site header (ruling 7 of the plan 11b lane). Until then the header has no such link.
- The docs search: at publication, search the docs for `passkey` under the new CSP of the site. A search that fails shows that the CSP blocks Pagefind.
- The demo: deploy the demo Worker and add the custom domain `demo.authtempo.com` with its DNS record. Then set `workers_dev`, `preview_urls`, and the route in `apps/demo/wrangler.jsonc`, and set `DEMO_PUBLISHED` in `apps/demo/src/facts.ts` to `true`. Until then `/demo/` links no host and gives the local command.
- The startup time: at the first upload of the demo, read the Worker startup time that wrangler prints. The platform limit is 1 s, and an upload over it fails.
- A real device: after publication, sign in to the demo with a real phone and a real authenticator app.

### The request budget of the demo (final review m7)

- At publication, add a WAF rate rule on the demo zone, and choose the Workers plan. No owned limit holds the count of requests in full.
- One request makes at most four Durable Object calls. The count of `apps/demo/src/flood.ts` takes 600 requests per IP per minute in each isolate, and it is weak, because each isolate counts alone.
- Workers Free has daily quotas of 100,000 requests, and also of 100,000 Durable Object requests and 100,000 rows written. A call over a quota fails until 00:00 UTC. The source is the Durable Objects pricing page, last updated 2026-10-18, read 2026-10-20.
- With four Durable Object calls a request, a flood ends the Durable Object quota after about 25,000 requests. The demo then stops for the rest of that day.
- One new sandbox writes 24 rows by the SQLite cursor counts of a local pool probe (2026-10-20), and each flow writes more. So on Workers Free, the rows-written quota ends after about 4,100 new sandboxes a day. At the gate total of 600 an hour, that is about seven hours. Choose the plan, or a lower gate total, with this number.
- On Workers Paid, Cloudflare bills each request and each Durable Object call of such a flood.
- The gate total of 600 sandboxes an hour is one pool for all visitors. One IPv6 /48 holds 65,536 /64 keys, so one host can fill the total in 120 requests. The /64 or /48 key of core `ipKey` is an owner choice.

### The IP rule and point-in-time recovery (final review I4)

- The demo deletes each IP within one hour: the gate alarm and the sandbox alarm delete the rows.
- Cloudflare can restore the store of a SQLite-backed Durable Object to any point of the past 30 days. The SQLite storage API page says so. The page was last updated 2026-09-21, and it was read on 2026-10-20.
- So the account can restore a deleted IP for 30 days. Spec 24 item 11 says that the demo stores no IP past one hour. Choose the words of the spec and of `/demo/`, or an owned change that keeps no clear IP.

### The compare facts (final review m4 and m6)

- `/compare/` states each Better Auth fact with its public source and the read date 2026-10-14. `FACT_MAX_DAYS` is 180.
- From 2027-04-13, check-facts fails every site test run. Each later lane that runs the whole repository then fails, whatever its change. Before that day, read each source of `SOURCES` in `apps/site/src/data/compare.ts` again, and change each read date.
- The plan 11b fix wave read the docs sitemap of better-auth.com on 2026-10-20. Its docs paths are `BETTER_AUTH_DOCS` in `apps/site/src/data/better-auth-docs.ts`, and check-facts fails a docs source outside it. Replace the list at the refresh. It did not read the GitHub and npm sources again, because it made no request to those hosts. Check them at the refresh.
- check-claims allows three phrases that name Better Auth outside `/compare/`, for the compatibility package (`ALLOWED_PHRASES` in `apps/site/scripts/check-claims.ts`). Ruling 42 asked for a rule on any competitor name. The owner may change the list.

### Each release

- Add a `pkg@version` row with its date to `RELEASE_DATES` in `apps/site/src/data/releases.ts` (ruling 29 of the plan 11b lane). Without the row, `check-feed` fails the site build.

### Owner inputs

- `openapi` is in `DEMO_EXEMPT` by the default of the lead (ruling 33). The owner may move it.
- The reason texts of `DEMO_EXEMPT` and `DEMO_OFF` in `apps/demo/src/facts.ts` are implementer text, and `/demo/` shows each one. The owner may change them.
- `apps/site/scripts/build-agent.ts` writes git HEAD into `dist/agent/index.json`, and Turbo does not hash HEAD (ruling 24). So a cached site build can serve the commit of an older run. The fix drops the commit from the index or makes it a hashed input of the build. Each option changes the index of `@authtempo/mcp`.
