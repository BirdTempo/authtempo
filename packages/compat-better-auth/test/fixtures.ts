import pgCamel from "./fixtures/better-auth-1.7.2.postgres.sql?raw";
import sqlite from "./fixtures/better-auth-1.7.2.sqlite.sql?raw";
import pgSnake from "./fixtures/consumer-i-snake.postgres.sql?raw";

export const BETTER_AUTH_PG = pgCamel;
export const BETTER_AUTH_SQLITE = sqlite;
export const CONSUMER_I_PG = pgSnake;

const FOREIGN_KEY = / references "\w+" \("id"\) on delete cascade/g;

/**
 * Each fixture has seven REFERENCES clauses: five name "user" and two name
 * "organization" (names.test.ts counts them). Since plan 9b core's
 * conformance suite and the D1 mapping tests create each parent row first.
 * The conformance suite runs on the fixtures as recorded, with the keys: on
 * Postgres (storage-postgres.test.ts) and on D1
 * (d1/storage-d1-conformance-keyed.test.ts). This function makes the tables
 * without the keys, so the D1 suites also run on tables with no keys.
 */
export function withoutForeignKeys(text: string): string {
  return text.replace(FOREIGN_KEY, "");
}

export function countForeignKeys(text: string): number {
  return text.match(FOREIGN_KEY)?.length ?? 0;
}
