# @authtempo/demo

The demo Worker of authtempo (plan 11b). Each visitor gets one sandbox: one Durable Object with its own SQLite store, secret, and alarm. The alarm deletes the sandbox 60 minutes after its creation.

The sandbox runs the real `createD1Adapter` and `createD1Limiter` of `@authtempo/adapter-d1` over `src/sqlite-d1.ts`, a D1 surface over `ctx.storage.sql`. The storage and limiter conformance suites of core run against it.

## Commands

Run each command from the repository root.

- `pnpm turbo run test --filter=@authtempo/demo --force`: the asset copy and the page scripts, then `wrangler deploy --dry-run` and the bundle scan. Then the pool tests and the Node tests run.
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
| New sandboxes per IP per hour (an IPv6 address counts by its /64) | 5 | `src/facts.ts:41` `sandboxesPerIp` |
| New sandboxes in total per hour | 600 | `src/facts.ts:43` `sandboxesTotal` |
| The window of both gate counts | 1 hour | `src/facts.ts:45` `windowMs` |
| The life of a sandbox from its creation, with no extension on use | 60 minutes | `src/facts.ts:47` `sandboxLifeMs` |
| Users per sandbox | 10 | `src/facts.ts:49` `usersPerSandbox` |
| Passkeys per sandbox | 10 | `src/facts.ts:50` `passkeysPerSandbox` |
| API tokens per sandbox | 10 | `src/facts.ts:51` `tokensPerSandbox` |
| Organizations per sandbox | 10 | `src/facts.ts:52` `organizationsPerSandbox` |
| Mails kept per sandbox, the newest first | 50 | `src/facts.ts:54` `mailsKept` |
| Request body, above which the Worker answers 413 | 16 KiB | `src/facts.ts:56` `bodyBytes` |

This table is a copy for a reader. `src/facts.ts` is the source. `test/limits.test.ts` and `test/timer.test.ts` hold each number. When a number changes, change this row in the same commit.

## Owner-run items

The owner runs each item below. No task of plan 11b runs one.

- Publication: the owner deploys the Worker and adds the custom domain `demo.authtempo.com` with its DNS record. Then set `workers_dev`, `preview_urls`, and the route in `wrangler.jsonc`, and set `DEMO_PUBLISHED` in `src/facts.ts` to `true`. Until then the `/demo/` page links no host.
- The WAF rule: at publication, add a WAF rate rule on the demo zone. Workers Free allows 100,000 requests a day (`src/limits.ts:19`). The rule only helps: the gate total of 600 sandboxes an hour stays the limit that we own.
- The startup time: at the first upload, read the Worker startup time that wrangler prints. The platform limit is 1 s. Without a pass, the upload fails.
- A real device: after publication, sign in with a real phone and a real authenticator app.
- Each release: add a `pkg@version` row with its date to `RELEASE_DATES` in `apps/site/src/data/releases.ts` (ruling 29 of the plan 11b lane). Without the row, `check-feed` fails the site build.
- The owner inputs:
  - `openapi` is in `DEMO_EXEMPT` by the lead's default (ruling 33). The owner may move it.
  - The reason texts of the parts turned off on `/demo/` (`DEMO_OFF` in `src/facts.ts`) are implementer text. The owner may change them.
  - The gate counts an IPv6 address by its /64, the key of core `ipKey`. The owner may choose /48 in core.
