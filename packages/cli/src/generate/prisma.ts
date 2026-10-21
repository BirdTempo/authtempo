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

/**
 * The Prisma type of one field, and the doc line that says what it holds.
 * A date is `BigInt` of epoch milliseconds on SQLite and MySQL: the Prisma
 * 7.10 reference names NUMERIC or text dates on SQLite, not epoch
 * milliseconds (read 2026-10-22). JSON on SQLite is `String`, the JSON
 * text that the adapter writes. prisma validate 7.10.0 also accepts Json
 * there. But the SQLite part of the same reference says that Json is not
 * supported, and its type map gives JSONB. A String field reads the TEXT
 * column the same way on each Prisma version (review of plan 12g Task 7).
 */
function prismaType(
  d: GenerateDialect,
  model: ModelName,
  field: string,
  f: Field,
): { type: string; doc: string | null } {
  switch (f.type) {
    case "string": {
      if (d !== "mysql") return { type: "String", doc: null };
      const row = MYSQL_STRINGS[`${model}.${field}`];
      return {
        type: `String @db.${row === undefined ? "Text" : `VarChar(${row.length})`}`,
        doc: null,
      };
    }
    case "boolean":
      return { type: "Boolean", doc: null };
    case "integer":
      return { type: f.int64 === true ? "BigInt" : "Int", doc: null };
    case "date":
      return d === "postgres"
        ? { type: "DateTime @db.Timestamptz(6)", doc: null }
        : { type: "BigInt", doc: "epoch milliseconds" };
    case "json":
      return d === "sqlite" ? { type: "String", doc: "JSON text" } : { type: "Json", doc: null };
  }
}

/** One field of a key: a MySQL plain index with a prefix gives its length. */
function keyField(d: GenerateDialect, model: ModelName, field: string, plain: boolean): string {
  const prefix = d === "mysql" && plain ? MYSQL_STRINGS[`${model}.${field}`]?.prefix : undefined;
  return prefix === undefined ? field : `${field}(length: ${prefix})`;
}

function model(d: GenerateDialect, m: ModelName): string[] {
  const def = schema[m];
  const fields = fieldsOf(m);
  const lines = [`model Ta${pascal(m)} {`];
  for (const [field, f] of Object.entries(fields)) {
    const { type, doc } = prismaType(d, m, field, f);
    const docs = [doc, sealedOrHash(m, field)].filter((x): x is string => x !== null);
    for (const text of docs) lines.push(`  /// ${text}`);
    const [base, ...attrs] = type.split(" ");
    const optional = f.nullable === true ? "?" : "";
    const id = field === "id" ? " @id" : "";
    const rest = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
    lines.push(
      `  ${field} ${base}${optional}${id} @map(${JSON.stringify(columnName(field))})${rest}`,
    );
  }
  lines.push("");
  for (const fs of def.unique)
    lines.push(
      `  @@unique([${fs.map((f) => keyField(d, m, f, false)).join(", ")}], map: ${JSON.stringify(uniqueIndexName(m, fs))})`,
    );
  for (const fs of def.indexes)
    lines.push(
      `  @@index([${fs.map((f) => keyField(d, m, f, true)).join(", ")}], map: ${JSON.stringify(indexName(m, fs))})`,
    );
  lines.push(`  @@map(${JSON.stringify(TABLES[m])})`, "}");
  return lines;
}

/**
 * The Prisma models of `d`: one model per table, named `Ta` plus the model
 * name in Pascal case, with core's table, column, key, and index names. The
 * text has no datasource and no generator block: the app's schema has them.
 */
export function printPrisma(d: GenerateDialect): string {
  const out = [generateHeader("prisma", d), ""];
  for (const m of MODELS) out.push(...model(d, m), "");
  return out.join("\n");
}
