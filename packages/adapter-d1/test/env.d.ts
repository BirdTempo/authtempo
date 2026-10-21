import type { D1Migration } from "cloudflare:test";

// @cloudflare/vitest-plugin 1.3.7 types `env` as `Cloudflare.Env`, not `ProvidedEnv`
// (checked in types/cloudflare-test.d.ts on 2026-10-09).
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      STAGED: D1Database;
      DDL_DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
