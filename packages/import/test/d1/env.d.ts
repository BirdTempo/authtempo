declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    /** The compatibility package's D1 migrations, for the Better Auth tables (plan 9b2). */
    COMPAT_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
