import { type ModelName, schema } from "@authtempo/core";
import { MYSQL_STRINGS } from "@authtempo/core/ddl";
import { columnName, indexName, TABLES, uniqueIndexName } from "@authtempo/core/sql";
import {
  type Field,
  fieldsOf,
  type GenerateDialect,
  generateHeader,
  MODELS,
  pascal,
  sealedOrHash,
} from "./header.js";

/** The drizzle-orm module of each dialect, and its table function. */
const CORE: Readonly<Record<GenerateDialect, { module: string; table: string }>> = {
  sqlite: { module: "drizzle-orm/sqlite-core", table: "sqliteTable" },
  postgres: { module: "drizzle-orm/pg-core", table: "pgTable" },
  mysql: { module: "drizzle-orm/mysql-core", table: "mysqlTable" },
};

/**
 * The column builder of one field: the types of design section 8.3. A date
 * is epoch milliseconds on SQLite and MySQL, so the builder gives a `Date`.
 */
function builder(d: GenerateDialect, model: ModelName, field: string, f: Field): string {
  const col = JSON.stringify(columnName(field));
  if (d === "sqlite")
    return {
      string: `text(${col})`,
      json: `text(${col}, { mode: "json" })`,
      boolean: `integer(${col}, { mode: "boolean" })`,
      date: `integer(${col}, { mode: "timestamp_ms" })`,
      integer: `integer(${col})`,
    }[f.type];
  const bigint = `bigint(${col}, { mode: "number" })`;
  if (d === "postgres")
    return {
      string: `text(${col})`,
      json: `jsonb(${col})`,
      boolean: `boolean(${col})`,
      date: `timestamp(${col}, { withTimezone: true, mode: "date" })`,
      integer: f.int64 === true ? bigint : `integer(${col})`,
    }[f.type];
  const row = MYSQL_STRINGS[`${model}.${field}`];
  return {
    string: row === undefined ? `text(${col})` : `varchar(${col}, { length: ${row.length} })`,
    json: `json(${col})`,
    boolean: `boolean(${col})`,
    date: `epochMs(${col})`,
    integer: f.int64 === true ? bigint : `int(${col})`,
  }[f.type];
}

/** The import names of each dialect: every builder that `builder` can write. */
const IMPORTS: Readonly<Record<GenerateDialect, readonly string[]>> = {
  sqlite: ["index", "integer", "sqliteTable", "text", "uniqueIndex"],
  postgres: [
    "bigint",
    "boolean",
    "index",
    "integer",
    "jsonb",
    "pgTable",
    "text",
    "timestamp",
    "uniqueIndex",
  ],
  mysql: [
    "bigint",
    "boolean",
    "customType",
    "index",
    "int",
    "json",
    "mysqlTable",
    "text",
    "uniqueIndex",
    "varchar",
  ],
};

/** The MySQL date: a BIGINT of epoch milliseconds that reads as a `Date`. */
const EPOCH_MS = [
  "/** A BIGINT of epoch milliseconds, read as a Date. */",
  "const epochMs = customType<{ data: Date; driverData: number | string }>({",
  '  dataType: () => "bigint",',
  "  fromDriver: (value) => new Date(Number(value)),",
  "  toDriver: (value) => value.getTime(),",
  "});",
];

function table(d: GenerateDialect, model: ModelName): string[] {
  const def = schema[model];
  const fields = fieldsOf(model);
  const lines = [
    `export const ta${pascal(model)} = ${CORE[d].table}(`,
    `  ${JSON.stringify(TABLES[model])},`,
    "  {",
  ];
  for (const [field, f] of Object.entries(fields)) {
    let text = builder(d, model, field, f);
    if (field === "id") text += ".primaryKey()";
    else if (f.nullable !== true) text += ".notNull()";
    const mark = sealedOrHash(model, field);
    lines.push(`    ${field}: ${text},${mark === null ? "" : ` // ${mark}`}`);
  }
  lines.push("  },");
  const on = (fs: readonly string[]) => fs.map((f) => `t.${f}`).join(", ");
  const keys = [
    ...def.unique.map(
      (fs) => `    uniqueIndex(${JSON.stringify(uniqueIndexName(model, fs))}).on(${on(fs)}),`,
    ),
    ...def.indexes.map((fs) => `    index(${JSON.stringify(indexName(model, fs))}).on(${on(fs)}),`),
  ];
  if (keys.length > 0) lines.push("  (t) => [", ...keys, "  ],");
  lines.push(");");
  return lines;
}

/**
 * The Drizzle schema of `d`: one table per model, named `ta` plus the model
 * name in Pascal case, with core's table, column, key, and index names. On
 * MySQL, a plain index with a prefix in the database has no prefix here.
 * Drizzle reads through it all the same.
 */
export function printDrizzle(d: GenerateDialect): string {
  const out = [
    generateHeader("drizzle", d),
    "",
    `import { ${IMPORTS[d].join(", ")} } from ${JSON.stringify(CORE[d].module)};`,
    "",
  ];
  if (d === "mysql") out.push(...EPOCH_MS, "");
  for (const model of MODELS) out.push(...table(d, model), "");
  return out.join("\n");
}
