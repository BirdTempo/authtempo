import { StorageError } from "@tempo-auth/core";
import { META_TABLE, SCHEMA_VERSION_KEY, schemaVersionGate } from "@tempo-auth/core/sql";
import type { Sql } from "postgres";
import { ISSUERS } from "./mapping.js";
import { BETTER_AUTH_TABLES, type BetterAuthTable, type Names } from "./names.js";

/** The mapping version in ta_meta. A mapping change that needs new columns is migration 0002 and the value 2. */
export const COMPAT_SCHEMA_VERSION = 1;
export const COMPAT_META_KEY = "compat_better_auth";
export const MIGRATION_NAME = "0001_compat_better_auth";

/** Postgres: now, cut to the millisecond precision that core reads back. */
const MS_NOW = "date_trunc('milliseconds', now())";

/** The core columns with no Better Auth column. `from` fills existing rows. */
const ADDED: readonly {
  table: BetterAuthTable;
  field: string;
  type: "date" | "text";
  from?: string;
}[] = [
  { table: "account", field: "taLinkedAt", type: "date", from: "createdAt" },
  { table: "session", field: "taLastSeenAt", type: "date", from: "updatedAt" },
  { table: "verification", field: "taPurpose", type: "text" },
  { table: "verification", field: "taValueHash", type: "text" },
  { table: "verification", field: "taConsumedAt", type: "date" },
  { table: "verification", field: "taData", type: "text" },
  { table: "passkey", field: "taUpdatedAt", type: "date", from: "createdAt" },
  { table: "organization", field: "taUpdatedAt", type: "date", from: "createdAt" },
  { table: "member", field: "taUpdatedAt", type: "date", from: "createdAt" },
  { table: "invitation", field: "taTokenHash", type: "text" },
  { table: "invitation", field: "taAcceptedAt", type: "date" },
  { table: "invitation", field: "taUpdatedAt", type: "date", from: "createdAt" },
];

/** The keys core's conformance suite needs and Better Auth lacks, plus core's two lookup indexes. (issuer, accountId) is separate: see SqliteVariant. */
const INDEXES: readonly {
  name: string;
  table: BetterAuthTable;
  fields: string[];
  unique: boolean;
}[] = [
  {
    name: "ix_session__active_organization_id",
    table: "session",
    fields: ["activeOrganizationId"],
    unique: false,
  },
  {
    name: "ux_verification__ta_value_hash",
    table: "verification",
    fields: ["taValueHash"],
    unique: true,
  },
  {
    name: "ix_verification__ta_purpose__identifier",
    table: "verification",
    fields: ["taPurpose", "identifier"],
    unique: false,
  },
  { name: "ux_passkey__credential_id", table: "passkey", fields: ["credentialID"], unique: true },
  {
    name: "ux_member__organization_id__user_id",
    table: "member",
    fields: ["organizationId", "userId"],
    unique: true,
  },
  {
    name: "ux_invitation__ta_token_hash",
    table: "invitation",
    fields: ["taTokenHash"],
    unique: true,
  },
  {
    name: "ix_invitation__organization_id__email",
    table: "invitation",
    fields: ["organizationId", "email"],
    unique: false,
  },
];

/**
 * `account.issuer` is on both dialects (spec 16.2): Better Auth 1.7 tables
 * have it, and a table from before 1.7 (consumer-i) gets it, filled from
 * `providerId`, and core's unique index on (issuer, accountId). Postgres
 * tests for the column and the index at run time. A SQLite file is static
 * and cannot test, so the D1 file comes in two variants: "1.7" fills only,
 * because a 1.7 table has the column and Better Auth's own unique index;
 * "before-1.7" adds the column and the index too.
 */
export type SqliteVariant = "1.7" | "before-1.7";

/**
 * Migration 0001: tempo-auth on the Better Auth tables. Append-only:
 * never change the text a shipped name produces. The two added tables are
 * ta_limit (core schema version 3's shape) and ta_meta, last, so a failed
 * run leaves no version row. schema_version is the literal '4', the core
 * version this mapping serves; it is not read from SCHEMA_VERSION, because
 * a shipped migration never changes. `variant` applies to SQLite only.
 */
export function compatMigrationSql(
  dialect: "postgres" | "sqlite",
  n: Names,
  variant: SqliteVariant = "1.7",
): string {
  const T = (t: BetterAuthTable) => n.table(t);
  const C = (t: BetterAuthTable, f: string) => n.column(t, f);
  const pg = dialect === "postgres";
  const date = pg ? "timestamptz" : "TEXT";
  const issuer = C("account", "issuer");
  const providerId = C("account", "providerId");
  // The named issuers come from ISSUERS, the table issuerFor reads (one
  // source). Any other provider id is 'local:oauth:' || providerId, which
  // equals issuerFor's encodeURIComponent form for every id of letters,
  // digits, and - _ . ! ~ * ' ( ). Rows that already have an issuer keep it.
  const cases = Object.entries(ISSUERS)
    .map(([id, value]) => `WHEN '${id}' THEN '${value}'`)
    .join(" ");
  const fillIssuer = `UPDATE ${T("account")} SET ${issuer} = CASE ${providerId} ${cases} ELSE 'local:oauth:' || ${providerId} END WHERE ${issuer} IS NULL;`;
  const issuerIndex = `CREATE UNIQUE INDEX ux_account__issuer__account_id ON ${T("account")} (${issuer}, ${C("account", "accountId")});`;
  const lines: string[] = [];
  if (pg) {
    const schemaExpr = n.pgSchema ? `'${n.pgSchema}'` : "current_schema()";
    const list = BETTER_AUTH_TABLES.map((t) => `'${n.rawTable(t)}'`).join(", ");
    lines.push(
      "DO $$ BEGIN",
      `  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = ${schemaExpr} AND table_name IN (${list}) AND data_type = 'timestamp without time zone') THEN`,
      "    RAISE EXCEPTION 'tempo-auth compat: every Better Auth date column must be timestamptz';",
      "  END IF;",
      "END $$;",
      "CREATE TABLE ta_limit (key text PRIMARY KEY, window_start bigint NOT NULL, count bigint NOT NULL, expires_at bigint NOT NULL);",
      `ALTER TABLE ${T("account")} ADD COLUMN IF NOT EXISTS ${issuer} text;`,
      fillIssuer,
      // Better Auth 1.7 has its own unique index on (issuer, accountId), under
      // its own name (account_issuer_accountId_uidx). A second equal index
      // costs one more index write per account insert. So look for any
      // valid, unique, non-partial index on exactly these two columns, by
      // any name. The names sort in byte order on both sides: COLLATE "C"
      // in SQL, and JavaScript's sort() in code-unit order.
      "DO $$ BEGIN",
      `  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace s ON s.oid = t.relnamespace WHERE s.nspname = ${schemaExpr} AND t.relname = '${n.rawTable("account")}' AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indnatts = 2 AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text COLLATE "C") FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum = ANY (i.indkey)) = ARRAY[${[
        n.rawColumn("account", "issuer"),
        n.rawColumn("account", "accountId"),
      ]
        .sort()
        .map((c) => `'${c}'`)
        .join(", ")}]) THEN`,
      `    ${issuerIndex}`,
      "  END IF;",
      "END $$;",
      `UPDATE ${T("passkey")} SET ${C("passkey", "createdAt")} = ${MS_NOW} WHERE ${C("passkey", "createdAt")} IS NULL;`,
    );
  } else {
    lines.push(
      "CREATE TABLE ta_limit (key TEXT PRIMARY KEY NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);",
      ...(variant === "before-1.7"
        ? [`ALTER TABLE ${T("account")} ADD COLUMN ${issuer} TEXT;`]
        : []),
      fillIssuer,
      ...(variant === "before-1.7" ? [issuerIndex] : []),
      `UPDATE ${T("passkey")} SET ${C("passkey", "createdAt")} = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE ${C("passkey", "createdAt")} IS NULL;`,
    );
  }
  lines.push("CREATE INDEX ix_ta_limit__expires_at ON ta_limit (expires_at);");
  for (const a of ADDED) {
    // Postgres: a column filled from a Better Auth column also gets a
    // default, so a row that another writer adds after the migration (an old
    // replica during the deploy, the app's own SQL) has a value. Without it
    // core reads null in a field that is not nullable and throws
    // schema_mismatch on that row. The value is cut to milliseconds, the
    // precision core reads back (to_char ... MS): a guard that compares a
    // read value with `eq` (ownerWrite on organization.updatedAt) then
    // matches. SQLite stores ISO text with milliseconds, and its ALTER TABLE
    // takes no expression default.
    const def = pg && a.from ? ` DEFAULT ${MS_NOW}` : "";
    lines.push(
      `ALTER TABLE ${T(a.table)} ADD COLUMN ${C(a.table, a.field)} ${a.type === "date" ? date : pg ? "text" : "TEXT"}${def};`,
    );
    if (a.from) {
      const from = C(a.table, a.from);
      lines.push(
        `UPDATE ${T(a.table)} SET ${C(a.table, a.field)} = ${pg ? `date_trunc('milliseconds', ${from})` : from};`,
      );
    }
  }
  for (const i of INDEXES) {
    lines.push(
      `CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${i.name} ON ${T(i.table)} (${i.fields.map((f) => C(i.table, f)).join(", ")});`,
    );
  }
  lines.push(
    pg
      ? "CREATE TABLE ta_meta (key text PRIMARY KEY, value text NOT NULL);"
      : "CREATE TABLE ta_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);",
    "INSERT INTO ta_meta (key, value) VALUES ('schema_version', '4'), ('compat_better_auth', '1');",
  );
  return `${lines.join("\n")}\n`;
}

/** One fixed advisory lock key for every compat migration run. */
const LOCK = "SELECT pg_advisory_xact_lock(hashtext('tempo_auth_compat_migrations'))";

/**
 * Applies the compat migrations the database does not hold yet, each in its
 * own transaction under one advisory lock, so two replicas that deploy at
 * once run each migration once. The applied version is the
 * `compat_better_auth` row of ta_meta: no third table.
 */
export async function applyBetterAuthCompatMigrations(sql: Sql, names: Names): Promise<string[]> {
  const migrations = [
    { version: 1, name: MIGRATION_NAME, text: compatMigrationSql("postgres", names) },
  ];
  const applied: string[] = [];
  for (const m of migrations) {
    const ran = await sql.begin(async (tx) => {
      await tx.unsafe(LOCK);
      const reg = await tx.unsafe<{ t: string | null }[]>(
        "SELECT to_regclass('ta_meta')::text AS t",
      );
      let current = 0;
      if (reg[0]?.t) {
        const rows = await tx.unsafe<{ value: string }[]>(
          `SELECT value FROM ${META_TABLE} WHERE key = $1`,
          [COMPAT_META_KEY],
        );
        current = Number(rows[0]?.value ?? "0");
      }
      if (current >= m.version) return false;
      await tx.unsafe(m.text);
      return true;
    });
    if (ran) applied.push(m.name);
  }
  return applied;
}

/** Core's schema version gate, then the mapping version. A failed check is not kept. */
export function compatVersionGate(
  readSchema: () => Promise<string | null>,
  readCompat: () => Promise<string | null>,
): () => Promise<void> {
  const core = schemaVersionGate(readSchema);
  let checked: Promise<void> | null = null;
  return () => {
    checked ??= (async () => {
      try {
        await core();
        const value = await Promise.resolve().then(readCompat);
        const found = value === null ? Number.NaN : Number(value);
        if (!Number.isInteger(found) || found < COMPAT_SCHEMA_VERSION) {
          throw new StorageError("schema_mismatch", "meta", [
            `${COMPAT_META_KEY}:${value ?? "none"}`,
          ]);
        }
      } catch (e) {
        checked = null;
        throw e;
      }
    })();
    return checked;
  };
}

/** Only an undefined table (42P01) reads as "no version"; any other error passes through. */
export function postgresCompatReady(sql: Sql): () => Promise<void> {
  const read = async (key: string) => {
    try {
      const rows = await sql.unsafe<{ value: string }[]>(
        `SELECT value FROM ${META_TABLE} WHERE key = $1`,
        [key],
      );
      return rows[0]?.value ?? null;
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === "42P01") return null;
      throw e;
    }
  };
  return compatVersionGate(
    () => read(SCHEMA_VERSION_KEY),
    () => read(COMPAT_META_KEY),
  );
}

interface D1Readable {
  prepare(query: string): {
    bind(...values: unknown[]): { first(column: string): Promise<unknown> };
  };
}

/** Only "no such table" reads as "no version"; any other D1 error passes through. */
export function d1CompatReady(db: unknown): () => Promise<void> {
  const d1 = db as D1Readable;
  const read = async (key: string) => {
    try {
      const v = await d1
        .prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`)
        .bind(key)
        .first("value");
      return typeof v === "string" ? v : null;
    } catch (e) {
      if (e instanceof Error && e.message.includes("no such table")) return null;
      throw e;
    }
  };
  return compatVersionGate(
    () => read(SCHEMA_VERSION_KEY),
    () => read(COMPAT_META_KEY),
  );
}
