import pgCamel from "./fixtures/better-auth-1.7.2.postgres.sql?raw";
import sqlite from "./fixtures/better-auth-1.7.2.sqlite.sql?raw";
import pgSnake from "./fixtures/consumer-i-snake.postgres.sql?raw";

export const BETTER_AUTH_PG = pgCamel;
export const BETTER_AUTH_SQLITE = sqlite;
export const CONSUMER_I_PG = pgSnake;

const FOREIGN_KEY = / references "\w+" \("id"\) on delete cascade/g;

/**
 * Core's conformance suite writes rows whose parents do not exist (an
 * identity of user "u1" with no user row), because the storage port has no
 * foreign keys. The suite runs on the fixture with the seven REFERENCES
 * clauses removed. The mapping tests and the end-to-end test run on the
 * fixture as recorded, with the foreign keys.
 */
export function withoutForeignKeys(text: string): string {
  return text.replace(FOREIGN_KEY, "");
}

export function countForeignKeys(text: string): number {
  return text.match(FOREIGN_KEY)?.length ?? 0;
}
