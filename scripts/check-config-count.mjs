// Run this script through `pnpm typecheck:configs`. tsc is on PATH only there.
// Plan 9b: fail the config typecheck when it finds fewer config files than
// the known count. An empty or shrunken include in tsconfig.configs.json
// would otherwise pass with no file checked.
import { execFileSync } from "node:child_process";

// Counted 2026-10-11: 11 with packages/import/vitest.d1.config.ts (plan 9b
// Task 14). Plan 11a adds apps/site (12), then examples/worker-d1 (13, Task 6)
// and examples/worker-postgres (14, Task 7). Plan 11c adds
// packages/cli/vitest.config.ts (15, Task 3). Plan 12b adds
// packages/captcha-turnstile (16, Task 10), packages/breach-check (17,
// Task 11), and examples/pbkdf2-probe (18, Task 13). Plan 11d adds
// packages/verify (19, Task 9), then packages/react and examples/react (21,
// Task 10), packages/sdk-conformance (22, Task 13), and packages/next and
// examples/next (24, Task 11). Plan 11d2 adds packages/hono and
// examples/hono (26, Task 2), then packages/express and examples/express
// (28, Task 3), then packages/astro (29, Task 4; the example has no vitest
// config), then packages/sveltekit (30, Task 5; the example has no vitest
// config), then packages/react-router and examples/react-router (32,
// Task 6), then packages/vue (33, Task 7; the Nuxt example has no vitest
// config), then packages/solid and examples/solid (35, Task 8), then
// packages/fastify and examples/fastify (37, Task 9), then
// packages/tanstack-start (38, Task 10; the example has no vitest config),
// then examples/elysia and examples/nestjs (40, Task 14). Plan 11e adds
// packages/mcp (41, Task 5), then examples/mcp-server (42, Task 13). The
// config of examples/mcp-server came in Task 12, and Task 13 raises the
// minimum. Then plan 11e adds packages/mcp/vitest.pool.config.ts (43, Task 16).
// Plan 11g adds packages/core/vitest.answers.config.ts (44, Task 5).
// Plan 11b adds apps/demo (45, Task 8), then apps/demo/vitest.node.config.ts (46,
// Task 10).
// Plan 12h adds packages/observe/vitest.config.ts and vitest.pool.config.ts (48, Task 10).
// Raise this number when a package adds a vitest config.
const MINIMUM = 48;

const listed = execFileSync("tsc", ["-p", "tsconfig.configs.json", "--listFilesOnly"], {
  encoding: "utf8",
});
const found = listed
  .split("\n")
  .filter((line) => /\/(packages|examples|apps)\/.+\/vitest[^/]*\.config\.m?ts$/.test(line)).length;

if (found < MINIMUM) {
  console.error(
    `typecheck:configs found ${found} vitest config files. Expected at least ${MINIMUM}.`,
  );
  process.exit(1);
}
console.log(`typecheck:configs checked ${found} vitest config files (minimum ${MINIMUM}).`);
