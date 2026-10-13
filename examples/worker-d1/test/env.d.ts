// @cloudflare/vitest-plugin types `env` as `Cloudflare.Env` (checked on
// 2026-10-09 for examples/worker). This file has no top-level import, so the
// namespace stays global. The inline import type keeps it that way.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    BASE_URL: string;
    AUTH_SECRET: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
