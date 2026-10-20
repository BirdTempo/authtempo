import pgCamel from "./fixtures/better-auth-1.7.2.postgres.sql?raw";
import sqlite from "./fixtures/better-auth-1.7.2.sqlite.sql?raw";
import pgRole from "./fixtures/better-auth-1.7.2-organization-role.postgres.sql?raw";
import sqliteRole from "./fixtures/better-auth-1.7.2-organization-role.sqlite.sql?raw";
import pgSnake from "./fixtures/consumer-i-snake.postgres.sql?raw";

export const BETTER_AUTH_PG = pgCamel;
export const BETTER_AUTH_SQLITE = sqlite;
export const CONSUMER_I_PG = pgSnake;
/** Better Auth's own organizationRole table (dynamicAccessControl), to apply after the fixture of its dialect (plan 12k). */
export const BETTER_AUTH_ROLE_PG = pgRole;
export const BETTER_AUTH_ROLE_SQLITE = sqliteRole;

const FOREIGN_KEY = / references "\w+" \("id"\) on delete cascade/g;

/**
 * Each fixture has seven REFERENCES clauses: five name "user" and two name
 * "organization" (names.test.ts counts them). Every suite runs on the
 * fixtures as recorded, with the keys: since plan 9b core's conformance suite
 * and the D1 mapping tests create each parent row first, so no test needs
 * the tables without the keys, and none removes them.
 */
export function countForeignKeys(text: string): number {
  return text.match(FOREIGN_KEY)?.length ?? 0;
}
