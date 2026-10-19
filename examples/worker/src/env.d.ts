interface Env {
  BASE_URL: string;
  AUTH_SECRET: string;
  TEST_MODE: string;
  /** "1" turns on the conformance mode of plan 12e Task 17; wrangler.jsonc keeps "0". */
  CONFORMANCE_MODE: string;
  /** The password of the conformance test user; read only while CONFORMANCE_MODE is "1". */
  CONFORMANCE_PASSWORD?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Development only: the source of a RegExp for an Expo Go redirect, for example ^exp://192\.168\.1\.20:8081/--/auth$. */
  DEV_REDIRECT_PATTERN?: string;
  /** The SHA-256 hex of the operator secret. It turns on POST /auth/operator/keys/rotate (plan 11c). */
  OPERATOR_SECRET_HASH?: string;
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
    /** From the vars of wrangler.jsonc; the conformance test reads that it is "0". */
    CONFORMANCE_MODE: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    BA_DB: D1Database;
    COMPAT_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
