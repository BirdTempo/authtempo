import { applyD1Migrations, env } from "cloudflare:test";
import { SCHEMA_VERSION } from "@authtempo/core";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import type { NamingOptions } from "../../src/storage/names.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { mappingCases, sqlNames as sqlNamesOn } from "../mapping-cases.js";
import { statementsOf } from "./sql.js";

export { at, eq } from "../mapping-cases.js";

/** The SQL names of one naming on the test D1 database, also for the Better Auth columns that core does not read (accessToken). */
export const sqlNames = (naming: Omit<NamingOptions, "pgSchema">) => sqlNamesOn(naming, env.DB);

/**
 * The STAGED database of plan 12h Task 8, with Better Auth's own SQLite
 * tables. It holds the shipped compat files before the one of
 * SCHEMA_VERSION. An app has such a database before it applies the new
 * file. It uses the default names in each suite. The tables are made once
 * for each test file.
 */
async function oldStore() {
  const cut = env.COMPAT_MIGRATIONS.findIndex((m) => m.name.includes(`_schema_v${SCHEMA_VERSION}`));
  if (cut < 1) throw new Error(`no compat migration file of version ${SCHEMA_VERSION}`);
  const made = await env.STAGED.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'",
  ).first("name");
  if (made === null) {
    await env.STAGED.batch(statementsOf(BETTER_AUTH_SQLITE).map((s) => env.STAGED.prepare(s)));
  }
  await applyD1Migrations(env.STAGED, env.COMPAT_MIGRATIONS.slice(0, cut));
  const s = betterAuthSchemaStorage({ dialect: "d1", db: env.STAGED });
  return { adapter: s.storage, close: async () => {} };
}

/**
 * Core's conformance suite and the mapping tests on the D1 database of one
 * test file, with one naming. The file builds the tables and runs the
 * migration first. The cases are in `test/mapping-cases.ts`, which imports
 * no Workers module, so the SQLite drivers of plan 12g run them too.
 */
export function d1MappingSuite(label: string, naming: Omit<NamingOptions, "pgSchema">): void {
  mappingCases(
    {
      conformance: `Better Auth tables on D1, ${label}`,
      mapping: `the Better Auth mapping on D1, ${label}`,
    },
    naming,
    env.DB,
    () => betterAuthSchemaStorage({ dialect: "d1", db: env.DB, ...naming }).storage,
    // A ping sends the 2 version reads, the index list, and the read of the one unique index (plan 12h).
    { pingStatements: 4, oldStore, ping: true },
  );
}
