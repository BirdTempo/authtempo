import type { Sql } from "postgres";
import { BetterAuthCompatError } from "../compat-error.js";
import { betterAuthSchemaStorage, type D1DatabaseLike } from "../storage/index.js";
import {
  BETTER_AUTH_TABLES,
  type BetterAuthTable,
  type NamingOptions,
  snake,
  TABLE_FIELDS,
} from "../storage/names.js";
import type { CompatDatabase } from "../types.js";

// The symbols drizzle-orm 0.45.2 sets on a table object (table.js and
// table.utils.js, read 2026-10-10). Read here, so drizzle-orm is not a dependency.
const NAME = Symbol.for("drizzle:Name");
const SCHEMA = Symbol.for("drizzle:Schema");
const COLUMNS = Symbol.for("drizzle:Columns");

export interface DrizzleAdapterConfig {
  provider: "pg" | "sqlite" | "mysql";
  /** Drizzle table objects by Better Auth model name, as Better Auth's own drizzleAdapter takes them. */
  schema?: Record<string, unknown>;
  usePlural?: boolean;
  /** Accepted: core runs every multi-row write in a transaction. */
  transaction?: boolean;
  /** Accepted: logs only. */
  debugLogs?: unknown;
  [key: string]: unknown;
}

/** Table names, column names, the casing, and the Postgres schema, read from Drizzle table objects. */
export function namesFromDrizzle(
  schema: Record<string, unknown> | undefined,
  usePlural: boolean,
): NamingOptions {
  const tables: Partial<Record<BetterAuthTable, string>> = {};
  const columns: Partial<Record<BetterAuthTable, Record<string, string>>> = {};
  let snakeVotes = 0;
  let camelVotes = 0;
  let pgSchema: string | undefined;
  for (const t of BETTER_AUTH_TABLES) {
    const table = schema?.[t] as Record<symbol, unknown> | undefined;
    if (!table) {
      if (usePlural) tables[t] = `${t}s`;
      continue;
    }
    const name = table[NAME];
    if (typeof name === "string") tables[t] = name;
    const s = table[SCHEMA];
    if (typeof s === "string") {
      if (pgSchema !== undefined && pgSchema !== s) {
        throw new BetterAuthCompatError([
          `database.schema: the tables sit in two Postgres schemas (${pgSchema}, ${s}); tempo-auth needs one`,
        ]);
      }
      pgSchema = s;
    }
    const cols = table[COLUMNS] as Record<string, { name?: unknown }> | undefined;
    const map: Record<string, string> = {};
    for (const f of TABLE_FIELDS[t]) {
      const c = cols?.[f]?.name;
      if (typeof c !== "string") continue;
      map[f] = c;
      if (f !== snake(f)) {
        if (c === snake(f)) snakeVotes++;
        else if (c === f) camelVotes++;
      }
    }
    columns[t] = map;
  }
  if (snakeVotes > 0 && camelVotes > 0) {
    throw new BetterAuthCompatError([
      "database.schema: the Drizzle columns mix camelCase and snake_case; name every column of one table set in one casing",
    ]);
  }
  return {
    casing: snakeVotes > 0 ? "snake" : "camel",
    tables,
    columns,
    ...(pgSchema !== undefined ? { pgSchema } : {}),
  };
}

function isD1(c: unknown): c is D1DatabaseLike {
  return (
    typeof c === "object" &&
    c !== null &&
    typeof (c as { prepare?: unknown }).prepare === "function" &&
    typeof (c as { batch?: unknown }).batch === "function"
  );
}

function isPostgresJs(c: unknown): c is Sql {
  return (
    typeof c === "function" &&
    typeof (c as { unsafe?: unknown }).unsafe === "function" &&
    typeof (c as { begin?: unknown }).begin === "function"
  );
}

const ACCEPTED_CONFIG = new Set(["provider", "schema", "usePlural", "transaction", "debugLogs"]);

/** Better Auth's `drizzleAdapter(db, config)`, answered with the Better Auth schema storage. */
export function drizzleAdapter(
  db: { $client?: unknown },
  config: DrizzleAdapterConfig,
): CompatDatabase {
  const refused = Object.keys(config)
    .filter((k) => !ACCEPTED_CONFIG.has(k))
    .map(
      (k) =>
        `database.${k}: drizzleAdapter accepts provider, schema, usePlural, transaction, and debugLogs only`,
    );
  if (refused.length > 0) throw new BetterAuthCompatError(refused);
  const naming = namesFromDrizzle(config.schema, config.usePlural === true);
  if (config.provider === "pg") {
    if (!isPostgresJs(db.$client)) {
      throw new BetterAuthCompatError([
        "database: drizzleAdapter needs a Drizzle database on postgres.js (drizzle-orm/postgres-js); other drivers are refused",
      ]);
    }
    return betterAuthSchemaStorage({ dialect: "postgres", sql: db.$client, ...naming });
  }
  if (config.provider === "sqlite") {
    if (!isD1(db.$client)) {
      throw new BetterAuthCompatError([
        "database: drizzleAdapter needs a Drizzle database on D1 (drizzle-orm/d1); other SQLite drivers are refused",
      ]);
    }
    const { pgSchema: _, ...d1Naming } = naming;
    return betterAuthSchemaStorage({ dialect: "d1", db: db.$client, ...d1Naming });
  }
  throw new BetterAuthCompatError([
    `database.provider: "${config.provider}" is refused; tempo-auth runs on Postgres and D1`,
  ]);
}
