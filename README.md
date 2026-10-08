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
| `examples/worker` | A Worker that mounts the engine. The end-to-end test runs against it. |

The example pins vitest 4.1.11 and `@cloudflare/vitest-plugin` 1.3.7. The 1.4.0 plugin and the newest workers-types were younger than the one-day release age on 2026-10-09. The core uses vitest 5.0.3. The earliest day to move the example to plugin 1.4.0 and vitest 5 is 2026-10-10.

Adapters for D1 and Postgres, social sign-in, passkeys, the native handoff,
and organizations arrive in the later plans.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Install. pnpm 12.8.1, Node 22 or newer. |
| `pnpm test` | Run every package's tests through Turborepo. The cache is off for tests. |
| `pnpm typecheck` | `tsc --noEmit` in every package. |
| `pnpm lint` | Biome. |
| `pnpm build` | Emit `dist` for the publishable packages. |

## Rules that the code enforces

- A POST with an `Origin` header not in `trustedOrigins` gets 403.
- Every token is stored as a SHA-256 hash. The clear token appears once.
- A magic link is single use. Two clicks race for one conditional update.
- A `next` path must start with `/` and not `//`. Anything else becomes `/`.
- The core runs on Workers with no compatibility flag. The example Worker
  has none, and its test fails if the core gains a Node dependency.
