interface Env {
  BASE_URL: string;
  AUTH_SECRET: string;
  TEST_MODE: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DB: D1Database;
}

// @cloudflare/vitest-plugin 1.3.7 types `env` as `Cloudflare.Env`, not `ProvidedEnv`
// (checked in types/cloudflare-test.d.ts on 2026-10-09). This file has no top-level
// import, so `Env` stays global. The inline import type keeps it that way.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
