interface Env {
  BASE_URL: string;
  AUTH_SECRET: string;
  TEST_MODE: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Development only: the source of a RegExp for an Expo Go redirect, for example ^exp://192\.168\.1\.20:8081/--/auth$. */
  DEV_REDIRECT_PATTERN?: string;
  DB: D1Database;
  /** Better Auth 1.7's tables with compat migration 0001, for the compat instance (plan 9). */
  BA_DB: D1Database;
}

// @cloudflare/vitest-plugin 1.3.7 types `env` as `Cloudflare.Env`, not `ProvidedEnv`
// (checked in types/cloudflare-test.d.ts on 2026-10-09). This file has no top-level
// import, so `Env` stays global. The inline import type keeps it that way.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    BA_DB: D1Database;
    COMPAT_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
