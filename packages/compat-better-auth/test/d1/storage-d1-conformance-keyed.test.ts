import { applyD1Migrations, env } from "cloudflare:test";
import { runAdapterConformance } from "@tempo-auth/core/conformance";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { sqlNames } from "./mapping-suite.js";
import { execD1 } from "./schema.js";

// Core's conformance suite on Better Auth's own SQLite SQL as recorded, with
// its seven foreign keys (plan 9b: the suite's fixtures are key-valid). The
// mapping tests in mapping-suite.ts get parent rows too; storage-d1.test.ts
// runs them and this suite on the tables without the keys as well.
await execD1(BETTER_AUTH_SQLITE);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

const { truncate } = sqlNames({});
runAdapterConformance("Better Auth tables on D1, with the foreign keys", async () => {
  await truncate();
  return {
    adapter: betterAuthSchemaStorage({ dialect: "d1", db: env.DB }).storage,
    close: truncate,
  };
});
