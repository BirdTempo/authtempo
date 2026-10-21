import { MYSQL_MIGRATIONS, MYSQL_MIGRATIONS_TABLE_SQL } from "@authtempo/adapter-mysql";
import { MIGRATIONS, MIGRATIONS_TABLE_SQL } from "@authtempo/adapter-postgres";
import { SQLITE_MIGRATIONS, SQLITE_MIGRATIONS_TABLE_SQL } from "@authtempo/adapter-sqlite";
import { schemaDdl } from "@authtempo/core/ddl";
import { DIALECT, type GenerateDialect, generateHeader } from "./header.js";

/** A name of a shipped migration as an SQL text literal. The names are ASCII words with no quote. */
const literal = (name: string) => `'${name.replaceAll("'", "''")}'`;

/**
 * The records of each runner: its own table, in the text of the runner, and
 * one row for each shipped migration. On MySQL the runner records each step,
 * so each step gets a row. The time of a row is the time of the apply.
 */
export function runnerRecords(d: GenerateDialect): string[] {
  switch (d) {
    case "sqlite":
      return [
        SQLITE_MIGRATIONS_TABLE_SQL,
        ...SQLITE_MIGRATIONS.map(
          (m) =>
            `INSERT INTO ta_migrations (name, applied_at) VALUES (${literal(m.name)}, CAST(strftime('%s', 'now') AS INTEGER) * 1000)`,
        ),
      ];
    case "postgres":
      return [
        MIGRATIONS_TABLE_SQL,
        ...MIGRATIONS.map((m) => `INSERT INTO ta_migrations (name) VALUES (${literal(m.name)})`),
      ];
    case "mysql":
      return [
        MYSQL_MIGRATIONS_TABLE_SQL,
        ...MYSQL_MIGRATIONS.flatMap((m) =>
          m.statements.map(
            (_, i) =>
              `INSERT INTO \`ta_migrations\` (\`name\`, \`step\`, \`applied_at\`) VALUES (${literal(m.name)}, ${i + 1}, CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS SIGNED))`,
          ),
        ),
      ];
  }
}

/**
 * The SQL of the schema on `d`: the header, the statements of `schemaDdl`,
 * then the runner records, so `authtempo migrate` finds nothing to do. Each
 * statement ends with `;` and a blank line.
 */
export function printSql(d: GenerateDialect): string {
  const block = (statements: readonly string[]) => statements.map((s) => `${s};`).join("\n\n");
  return [
    generateHeader("sql", d),
    block(schemaDdl(DIALECT[d])),
    "-- The records are safe only because the shape suite proves that the DDL and the shipped files build the same database.",
    block(runnerRecords(d)),
  ]
    .join("\n\n")
    .concat("\n");
}
