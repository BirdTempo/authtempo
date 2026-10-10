import { BETTER_AUTH_TABLES, type NamingOptions, snake } from "../../src/storage/names.js";

/** The statements of a SQL text: comment lines dropped, split on ";". The texts here hold no ";" in a literal. */
export function statementsOf(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Better Auth's 1.7 SQLite schema as a table from before 1.7: no issuer column and no index on it. */
export const before17 = (schema: string) =>
  schema
    .replace('"issuer" text not null, ', "")
    .replace(/create unique index "account_issuer_accountId_uidx"[^;]*;/, "");

/**
 * Better Auth's SQLite schema with other names: each quoted table name from
 * `tables`, each other quoted name in snake_case when `casing` is "snake".
 * The SQLite counterpart of the Postgres consumer-i fixture.
 */
export function renamed(schema: string, naming: NamingOptions): string {
  return schema.replace(/"(\w+)"/g, (_, name: string) => {
    const table = BETTER_AUTH_TABLES.find((t) => t === name);
    if (table) return `"${naming.tables?.[table] ?? table}"`;
    return `"${naming.casing === "snake" ? snake(name) : name}"`;
  });
}
