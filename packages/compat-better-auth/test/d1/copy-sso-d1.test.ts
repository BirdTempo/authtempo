import { applyD1Migrations, env } from "cloudflare:test";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { copySsoSuite } from "../copy-sso-suite.js";
import {
  BETTER_AUTH_SQLITE,
  BETTER_AUTH_SSO_ROWS_SQLITE,
  BETTER_AUTH_SSO_SQLITE,
} from "../fixtures.js";
import { counting } from "./counting.js";
import { execD1 } from "./schema.js";

// Better Auth's own SQLite tables and rows, then the shipped compat migrations.
// Each call of the copy runs on a new storage over a counting binding, as one
// Worker invocation: D1 Free allows 50 queries per invocation (D1 limits
// page, read 2026-10-21).
await execD1(BETTER_AUTH_SQLITE);
await execD1(BETTER_AUTH_SSO_SQLITE);
await execD1(BETTER_AUTH_SSO_ROWS_SQLITE);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

copySsoSuite("D1", async () => ({
  fresh: () => {
    const { db, count } = counting(env.DB);
    return {
      database: betterAuthSchemaStorage({ dialect: "d1", db }),
      statements: () => count.queries,
    };
  },
  close: async () => {},
}));
