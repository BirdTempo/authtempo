import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectedMysqlShape } from "@authtempo/adapter-mysql";
import { expectedPostgresShape } from "@authtempo/adapter-postgres";
import { expectedSqliteShape } from "@authtempo/adapter-sqlite";
import { type ModelName, schema } from "@authtempo/core";
import { columnName, TABLES } from "@authtempo/core/sql";
import { getTableConfig as mysqlTable } from "drizzle-orm/mysql-core";
import { getTableConfig as postgresTable } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteTable } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertFreshBuild, PKG, runBin } from "./support/bin.js";

// The printed Drizzle and Prisma tables against the expected shape of each
// adapter (the lead note of the 12g ledger, line 97). The read tests cover
// four tables only, and a snapshot holds any text. This test holds the type,
// the null rule, the primary key, and each key and index of every column.

const DIALECTS = ["sqlite", "postgres", "mysql"] as const;
type Dialect = (typeof DIALECTS)[number];

const EXPECTED = {
  sqlite: expectedSqliteShape,
  postgres: expectedPostgresShape,
  mysql: expectedMysqlShape,
} as const;

/** The tables of the adapter that are not a model, typed here: the output has no table for them. */
const NOT_MODELS = ["ta_limit", "ta_meta", "ta_migrations"];

/** The ORM types of one column: the SQL type and the column class of Drizzle, and the Prisma type. */
interface OrmType {
  sql: string;
  drizzle: string;
  prisma: string;
}

/**
 * The ORM types of a column, by the core field type (`integer64` for a
 * 64-bit integer) and the adapter's SQL type before any collation. The
 * values are typed here from the docs of drizzle-orm 0.45.3 and Prisma 7.10.
 */
const TYPES: Record<Dialect, Record<string, OrmType>> = {
  sqlite: {
    "boolean INTEGER": { sql: "integer", drizzle: "SQLiteBoolean", prisma: "Boolean" },
    "date INTEGER": { sql: "integer", drizzle: "SQLiteTimestamp", prisma: "BigInt" },
    "integer INTEGER": { sql: "integer", drizzle: "SQLiteInteger", prisma: "Int" },
    "integer64 INTEGER": { sql: "integer", drizzle: "SQLiteInteger", prisma: "BigInt" },
    "json TEXT": { sql: "text", drizzle: "SQLiteTextJson", prisma: "String" },
    "string TEXT": { sql: "text", drizzle: "SQLiteText", prisma: "String" },
  },
  postgres: {
    "boolean boolean": { sql: "boolean", drizzle: "PgBoolean", prisma: "Boolean" },
    "date timestamp with time zone": {
      sql: "timestamp with time zone",
      drizzle: "PgTimestamp",
      prisma: "DateTime @db.Timestamptz(6)",
    },
    "integer integer": { sql: "integer", drizzle: "PgInteger", prisma: "Int" },
    "integer64 bigint": { sql: "bigint", drizzle: "PgBigInt53", prisma: "BigInt" },
    "json jsonb": { sql: "jsonb", drizzle: "PgJsonb", prisma: "Json" },
    "string text": { sql: "text", drizzle: "PgText", prisma: "String" },
  },
  mysql: {
    "boolean tinyint(1)": { sql: "boolean", drizzle: "MySqlBoolean", prisma: "Boolean" },
    "date bigint": { sql: "bigint", drizzle: "MySqlCustomColumn", prisma: "BigInt" },
    "integer int": { sql: "int", drizzle: "MySqlInt", prisma: "Int" },
    "integer64 bigint": { sql: "bigint", drizzle: "MySqlBigInt53", prisma: "BigInt" },
    "json json": { sql: "json", drizzle: "MySqlJson", prisma: "Json" },
    "string text": { sql: "text", drizzle: "MySqlText", prisma: "String @db.Text" },
  },
};

/** The ORM types of a MySQL varchar of `n` characters. */
const varchar = (n: string): OrmType => ({
  sql: `varchar(${n})`,
  drizzle: "MySqlVarChar",
  prisma: `String @db.VarChar(${n})`,
});

/** The core field type of each column, by `table.column`. */
const KINDS = new Map(
  (Object.keys(schema) as ModelName[]).flatMap((m) =>
    Object.entries(schema[m].fields).map(([f, def]) => [
      `${TABLES[m]}.${columnName(f)}`,
      def.type === "integer" && def.int64 === true ? "integer64" : def.type,
    ]),
  ),
);

/** The ORM types that a column of the adapter's shape must have. */
function ormType(d: Dialect, table: string, column: string, sqlType: string): OrmType {
  const head = sqlType.split(" ")[0] ?? "";
  const n = d === "mysql" ? /^varchar\((\d+)\)$/.exec(head)?.[1] : undefined;
  const kind = KINDS.get(`${table}.${column}`);
  if (n !== undefined && kind === "string") return varchar(n);
  const key = `${kind} ${d === "postgres" ? sqlType : head}`;
  const t = TYPES[d][key];
  if (t === undefined) throw new Error(`${d} ${table}.${column}: no ORM type for ${key}`);
  return t;
}

/** One column as both sides give it. */
interface Column {
  name: string;
  type: OrmType | string;
  notNull: boolean;
}

/** One table as both sides give it: its columns, its primary key, and its keys and indexes. */
interface Shape {
  columns: Column[];
  primaryKey: readonly string[];
  keys: string[];
}

/** The keys and indexes as sorted lines: `U name (a,b)` for a unique key, `I` for an index. */
const keyLines = (
  unique: readonly { name: string; columns: readonly string[] }[],
  indexes: readonly { name: string; columns: readonly string[] }[],
  prefix: boolean,
): string[] =>
  [...unique.map((k) => ({ ...k, kind: "U" })), ...indexes.map((k) => ({ ...k, kind: "I" }))]
    .map(
      (k) =>
        `${k.kind} ${k.name} (${k.columns.map((c) => (prefix ? c : c.replace(/\(\d+\)$/, ""))).join(",")})`,
    )
    .sort();

/** The shape of each model table of the adapter, with the ORM types of each column. */
function expectedOrm(d: Dialect, prefix: boolean): Map<string, Shape> {
  const out = new Map<string, Shape>();
  for (const t of EXPECTED[d]()) {
    if (NOT_MODELS.includes(t.name)) continue;
    out.set(t.name, {
      columns: t.columns.map((c) => ({
        name: c.name,
        type: ormType(d, t.name, c.name, c.type),
        notNull: c.notNull,
      })),
      primaryKey: t.primaryKey,
      keys: keyLines(t.unique, t.indexes, prefix),
    });
  }
  return out;
}

/** The text of `authtempo generate`. */
function printed(format: string, d: Dialect): string {
  const r = runBin(["generate", "--format", format, "--dialect", d]);
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

/** The printed Drizzle files go into a folder of the package, so the import finds drizzle-orm. */
const OUT = mkdtempSync(join(PKG, "test", "generated-shape-"));
afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
});

beforeAll(() => {
  assertFreshBuild();
});

const TABLE_CONFIG = { sqlite: sqliteTable, postgres: postgresTable, mysql: mysqlTable } as const;

type DrizzleConfig = {
  name: string;
  columns: {
    name: string;
    notNull: boolean;
    primary: boolean;
    columnType: string;
    getSQLType(): string;
  }[];
  indexes: { config: { name: string; unique?: boolean; columns: { name: string }[] } }[];
};

/** The shape of each printed Drizzle table, by `getTableConfig` of drizzle-orm. */
async function drizzleShape(d: Dialect): Promise<Map<string, Shape>> {
  const folder = join(OUT, d);
  mkdirSync(folder);
  const file = join(folder, "schema.ts");
  writeFileSync(file, printed("drizzle", d));
  const mod = (await import(file)) as Record<string, unknown>;
  const out = new Map<string, Shape>();
  for (const table of Object.values(mod)) {
    const c = (TABLE_CONFIG[d] as (t: unknown) => DrizzleConfig)(table);
    const idx = c.indexes.map((i) => ({
      name: i.config.name,
      unique: i.config.unique === true,
      columns: i.config.columns.map((x) => x.name),
    }));
    out.set(c.name, {
      columns: c.columns.map((x) => ({
        name: x.name,
        type: { sql: x.getSQLType(), drizzle: x.columnType },
        notNull: x.notNull,
      })) as Column[],
      primaryKey: c.columns.filter((x) => x.primary).map((x) => x.name),
      keys: keyLines(
        idx.filter((i) => i.unique),
        idx.filter((i) => !i.unique),
        false,
      ),
    });
  }
  return out;
}

/** The shape of each printed Prisma model, by its `@@map`, `@map`, `@id`, `@@unique`, and `@@index` lines. */
function prismaShape(d: Dialect): Map<string, Shape> {
  const out = new Map<string, Shape>();
  for (const m of printed("prisma", d).matchAll(/^model (\w+) \{\n([\s\S]*?)\n\}$/gm)) {
    const body = m[2] ?? "";
    const table = /^ {2}@@map\("([^"]+)"\)$/m.exec(body)?.[1] ?? `(no @@map in ${m[1]})`;
    const fields = [...body.matchAll(/^ {2}(\w+) (\w+)(\?)?(.*)$/gm)].map((f) => {
      const rest = f[4] ?? "";
      const db = /@db\.(\S+)/.exec(rest)?.[1];
      return {
        field: f[1] ?? "",
        column: /@map\("([^"]+)"\)/.exec(rest)?.[1] ?? `(no @map of ${f[1]})`,
        type: `${f[2]}${db === undefined ? "" : ` @db.${db}`}`,
        notNull: f[3] !== "?",
        id: rest.includes("@id"),
      };
    });
    const columnOf = new Map(fields.map((f) => [f.field, f.column]));
    const keys = (kind: string) =>
      [
        ...body.matchAll(new RegExp(`^ {2}@@${kind}\\(\\[([^\\]]*)\\], map: "([^"]+)"\\)$`, "gm")),
      ].map((k) => ({
        name: k[2] ?? "",
        columns: (k[1] ?? "").split(", ").map((part) => {
          const p = /^(\w+)(?:\(length: (\d+)\))?$/.exec(part);
          const column = columnOf.get(p?.[1] ?? "") ?? `(no field ${part})`;
          return p?.[2] === undefined ? column : `${column}(${p[2]})`;
        }),
      }));
    out.set(table, {
      columns: fields.map((f) => ({ name: f.column, type: f.type, notNull: f.notNull })),
      primaryKey: fields.filter((f) => f.id).map((f) => f.column),
      keys: keyLines(keys("unique"), keys("index"), true),
    });
  }
  return out;
}

describe("the printed ORM tables against the shape of each adapter", () => {
  for (const d of DIALECTS)
    it(`gives each Drizzle column its type, null rule, and keys: ${d}`, async () => {
      const want = expectedOrm(d, false);
      const got = await drizzleShape(d);
      expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
      for (const [table, w] of want)
        expect(got.get(table), `${d} ${table}`).toEqual({
          ...w,
          columns: w.columns.map((c) => {
            const t = c.type as OrmType;
            return { ...c, type: { sql: t.sql, drizzle: t.drizzle } };
          }),
        });
    });

  for (const d of DIALECTS)
    it(`gives each Prisma field its type, null rule, and keys: ${d}`, () => {
      const want = expectedOrm(d, true);
      const got = prismaShape(d);
      expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
      for (const [table, w] of want)
        expect(got.get(table), `${d} ${table}`).toEqual({
          ...w,
          columns: w.columns.map((c) => ({ ...c, type: (c.type as OrmType).prisma })),
        });
    });
});
