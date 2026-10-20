interface Env {
  BASE_URL: string;
  AUTH_SECRET: string;
  TEST_MODE: string;
  /** "1" in wrangler.conformance.jsonc only; the conformance entry of plan 12e serves nothing without it. */
  CONFORMANCE_MODE?: string;
  /** The password of the conformance test user; read only while CONFORMANCE_MODE is "1". */
  CONFORMANCE_PASSWORD?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Development only: the source of a RegExp for an Expo Go redirect, for example ^exp://192\.168\.1\.20:8081/--/auth$. */
  DEV_REDIRECT_PATTERN?: string;
  /** The SHA-256 hex of the operator secret. It turns on POST /auth/operator/keys/rotate (plan 11c). */
  OPERATOR_SECRET_HASH?: string;
  /**
   * A JSON text of [{ name, secretHash, scopes }]: the named operator secrets of plan 12f.
   * When it is set, the Worker reads it and not OPERATOR_SECRET_HASH.
   */
  OPERATOR_SECRETS?: string;
  /** "1" turns on the operator user, session, and audit tools of plan 12f, with the organization "platform". */
  OPERATOR_USERS?: string;
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
