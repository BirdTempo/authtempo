# @authtempo/demo

The demo Worker of authtempo (plan 11b). Each visitor gets one sandbox: one Durable Object with its own SQLite store, secret, and alarm. The alarm deletes the sandbox 60 minutes after its creation.

The sandbox runs the real `createD1Adapter` and `createD1Limiter` of `@authtempo/adapter-d1` over `src/sqlite-d1.ts`, a D1 surface over `ctx.storage.sql`. The storage and limiter conformance suites of core run against it.

## Commands

Run each command from the repository root.

- `pnpm turbo run test --filter=@authtempo/demo --force`: the asset copy and the page scripts, the pool tests, the Node tests, then `wrangler deploy --dry-run` and the bundle scan.
- `pnpm --filter @authtempo/demo typecheck`: the Worker source, the page scripts, and the tests.
- `pnpm --filter @authtempo/demo dev`: the Worker on your machine.

The package is private. It has no publication: `workers_dev` and `preview_urls` are off, and it has no route.
