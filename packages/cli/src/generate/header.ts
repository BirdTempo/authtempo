import { type ModelName, SCHEMA_VERSION, schema } from "@authtempo/core";
import { type Dialect, MYSQL, POSTGRES, SQLITE, TABLES } from "@authtempo/core/sql";
import { CLI_VERSION } from "../version.js";

/** The three formats of `authtempo generate` (plan 12g Task 7). */
export const FORMATS = ["sql", "drizzle", "prisma"] as const;
export type GenerateFormat = (typeof FORMATS)[number];

/** The three dialects. D1 is no dialect here: a D1 app applies the files of @authtempo/adapter-d1 with wrangler. */
export const DIALECTS = ["sqlite", "postgres", "mysql"] as const;
export type GenerateDialect = (typeof DIALECTS)[number];

export const DIALECT: Readonly<Record<GenerateDialect, Dialect>> = {
  sqlite: SQLITE,
  postgres: POSTGRES,
  mysql: MYSQL,
};

/** One field of the schema object, as the printers read it. */
export interface Field {
  type: "string" | "boolean" | "integer" | "date" | "json";
  nullable?: boolean;
  int64?: true;
}

/** The fields of one model in field order: the order of the columns. */
export const fieldsOf = (model: ModelName): Record<string, Field> =>
  schema[model].fields as Record<string, Field>;

/** Each model in schema order: the order of `schemaDdl`. */
export const MODELS = Object.keys(schema) as ModelName[];

/** `oauthClient` gives `OauthClient`. */
export const pascal = (model: string): string =>
  `${model.charAt(0).toUpperCase()}${model.slice(1)}`;

/** The fields that hold a sealed value: the clear value is never stored. */
const SEALED: readonly string[] = ["totp.secret", "jwk.privateKey"];

/**
 * The fields that hold a hash with no name that ends in `Hash`: the password
 * hash and the two lists of backup code hashes. Each field whose name ends
 * in `Hash` is a hash too, so a new one of that form needs no row here.
 */
const OTHER_HASHES: readonly string[] = [
  "password.hash",
  "totp.backupCodes",
  "secondFactor.backupCodes",
];

/**
 * Each `<model>.<field>` that holds a sealed value or a hash. The Drizzle and
 * Prisma files mark each one, so an app does not read it as a clear value.
 */
export const SEALED_OR_HASH: ReadonlySet<string> = new Set([
  ...SEALED,
  ...OTHER_HASHES,
  ...MODELS.flatMap((m) =>
    Object.keys(schema[m].fields)
      .filter((f) => f.endsWith("Hash"))
      .map((f) => `${m}.${f}`),
  ),
]);

/** The mark of one field: sealed, hash, or null. */
export function sealedOrHash(model: ModelName, field: string): "sealed" | "hash" | null {
  const key = `${model}.${field}`;
  if (!SEALED_OR_HASH.has(key)) return null;
  return SEALED.includes(key) ? "sealed" : "hash";
}

/** The date of the reads of the Drizzle Kit and Prisma pages (Step 1 of Task 7). */
const READ_DATE = "2026-10-22";

/** The one header line of every format, with no comment mark. */
export function headerLine(d: GenerateDialect): string {
  return `authtempo schema version ${SCHEMA_VERSION}, dialect ${d}, authtempo CLI ${CLI_VERSION}. authtempo owns these tables. Create and change them with \`authtempo migrate\`. Write rows through the engine only.`;
}

const READS_ONLY =
  "This file is for reads. A write through the ORM skips the engine's guards: the claim rule, the conditional consume, and the undo of a user create.";

/** The name of a table in the external list of prisma.config.ts: Postgres needs the schema name too. */
const externalName = (d: GenerateDialect, table: string) =>
  d === "postgres" ? `public.${table}` : table;

function headerLines(format: GenerateFormat, d: GenerateDialect): string[] {
  const lines = [headerLine(d), READS_ONLY];
  if (format === "sql")
    lines.push(
      "Apply this file to an empty database only. To change a database, run authtempo migrate.",
    );
  if (format === "drizzle")
    lines.push(
      "Keep this file out of the schema glob of drizzle.config.ts, so drizzle-kit generate writes no migration for it.",
      "Set tablesFilter in drizzle.config.ts to the table patterns of the app, so drizzle-kit push and pull leave the ta_ tables alone.",
      `The Drizzle Kit page documents no negation form for tablesFilter (orm.drizzle.team/docs/drizzle-config-file, read ${READ_DATE}).`,
    );
  if (format === "prisma") {
    const tables = MODELS.map((m) => JSON.stringify(externalName(d, TABLES[m]))).join(", ");
    lines.push(
      "Add these two keys to prisma.config.ts, so Prisma Migrate leaves the ta_ tables alone:",
      "  experimental: { externalTables: true },",
      `  tables: { external: [${tables}] },`,
      `Externally managed tables are a Preview feature in Prisma 7.10 (read ${READ_DATE}).`,
    );
    if (d === "postgres")
      lines.push("The list names the schema public. Write the schema of the app in its place.");
    lines.push("Keep ta_meta, ta_limit, and ta_migrations out of each Prisma migration too.");
  }
  return lines;
}

/** The header of one format: each line as a comment of its language. */
export function generateHeader(format: GenerateFormat, d: GenerateDialect): string {
  const mark = format === "sql" ? "--" : "//";
  return headerLines(format, d)
    .map((l) => `${mark} ${l}`)
    .join("\n");
}
