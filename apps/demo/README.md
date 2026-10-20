# @authtempo/demo

The demo Worker of authtempo (plan 11b). Each visitor gets one sandbox: one Durable Object with its own SQLite store, secret, and alarm. The alarm deletes the sandbox 60 minutes after its creation.

The sandbox runs the real `createD1Adapter` and `createD1Limiter` of `@authtempo/adapter-d1` over `src/sqlite-d1.ts`, a D1 surface over `ctx.storage.sql`. The storage and limiter conformance suites of core run against it.

## Commands

Run each command from the repository root.

- `pnpm turbo run test --filter=@authtempo/demo --force`: Turbo runs the build first. The build writes `src/migrations.gen.ts`, the assets, the page scripts, and the bundle of `wrangler deploy --dry-run` with its scan. Then the pool tests and the Node tests read them. Only the build writes `dist` (ruling 44 of the plan 11b lane), so the test and the typecheck need it first.
- `pnpm --filter @authtempo/demo typecheck`: the Worker source, the page scripts, and the tests.
- `pnpm --filter @authtempo/demo dev`: the Worker on your machine. Open `https://localhost:8787/`. `scripts/dev.mjs` runs `wrangler dev` over local https on port 8787 and sets `DEMO_ORIGIN` to that origin. So core trusts the page origin, and each mail link and provider URL leads back to the local run. `DEMO_PORT` names another port. wrangler makes its own certificate, so the browser asks you to accept it. `test/node/dev.test.ts` starts the script on a free port and sends a magic-link request from the page origin.

The package is private. It has no publication: `workers_dev` and `preview_urls` are off, and it has no route.

## What the demo shows

`DEMO_FEATURES` in `src/facts.ts` lists the route features that the demo turns on, and `DEMO_EXEMPT` names each other feature with its reason. `test/coverage.test.ts` holds both lists to `ROUTES` of core, both ways. The `/demo/` page of the site reads the same entry, `@authtempo/demo/facts`.

The mail of a sandbox goes to its mailbox page. Social sign-in uses the demo provider of `src/provider.ts`, which core reaches through `social.fetch`. No request leaves the Worker.

## The limits

Each limit is our own code. `src/gate.ts` checks the gate limits, and `src/limits.ts` checks the sandbox limits. A refusal answers 429 `demo_limit` with the name of the limit. No Cloudflare setting holds a limit alone.

| Limit | Value | Source line |
| --- | --- | --- |
| New sandboxes per IP per hour (an IPv6 address counts by its /64) | 5 | `src/facts.ts:115` `sandboxesPerIp` |
| New sandboxes in total per hour | 600 | `src/facts.ts:117` `sandboxesTotal` |
| The window of both gate counts | 1 hour | `src/facts.ts:119` `windowMs` |
| The life of a sandbox from its creation, with no extension on use | 60 minutes | `src/facts.ts:121` `sandboxLifeMs` |
| Users per sandbox | 10 | `src/facts.ts:123` `usersPerSandbox` |
| Passkeys per sandbox | 10 | `src/facts.ts:124` `passkeysPerSandbox` |
| API tokens per sandbox | 10 | `src/facts.ts:125` `tokensPerSandbox` |
| Organizations per sandbox | 10 | `src/facts.ts:126` `organizationsPerSandbox` |
| Mails kept per sandbox, the newest first | 50 | `src/facts.ts:128` `mailsKept` |
| Request body, above which the Worker answers 413 | 16 KiB | `src/facts.ts:130` `bodyBytes` |
| Requests per IP per minute in one isolate, before any Durable Object call (weak: each isolate counts alone) | 600 | `src/facts.ts:136` `requestsPerIpPerMinute` |

This table is a copy for a reader. `src/facts.ts` is the source. `test/limits.test.ts` and `test/timer.test.ts` hold each number. When a number changes, change this row in the same commit.

## Owner-run items

The owner list of the site and the demo is one list, in the section "Owner-run items of the site and the demo" of the root `README.md`.
