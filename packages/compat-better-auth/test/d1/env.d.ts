import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      COMPAT_MIGRATIONS: D1Migration[];
      COMPAT_MIGRATIONS_BEFORE_17: D1Migration[];
    }
  }
}
