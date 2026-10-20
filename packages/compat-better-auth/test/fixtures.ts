import pgTeams1421 from "./fixtures/better-auth-1.4.21-teams.postgres.sql?raw";
import sqliteTeams1421 from "./fixtures/better-auth-1.4.21-teams.sqlite.sql?raw";
import pgCamel from "./fixtures/better-auth-1.7.2.postgres.sql?raw";
import sqlite from "./fixtures/better-auth-1.7.2.sqlite.sql?raw";
import pgRole from "./fixtures/better-auth-1.7.2-organization-role.postgres.sql?raw";
import sqliteRole from "./fixtures/better-auth-1.7.2-organization-role.sqlite.sql?raw";
import pgTeams from "./fixtures/better-auth-1.7.2-teams.postgres.sql?raw";
import sqliteTeams from "./fixtures/better-auth-1.7.2-teams.sqlite.sql?raw";
import pgSnake from "./fixtures/consumer-i-snake.postgres.sql?raw";

export const BETTER_AUTH_PG = pgCamel;
export const BETTER_AUTH_SQLITE = sqlite;
export const CONSUMER_I_PG = pgSnake;
/** Better Auth's own organizationRole table (dynamicAccessControl), to apply after the fixture of its dialect (plan 12k). */
export const BETTER_AUTH_ROLE_PG = pgRole;
export const BETTER_AUTH_ROLE_SQLITE = sqliteRole;
/** Better Auth's own team and teamMember tables (its teams option), to apply after the fixture of its dialect (plan 12k Task 11). */
export const BETTER_AUTH_TEAMS_PG = pgTeams;
export const BETTER_AUTH_TEAMS_SQLITE = sqliteTeams;
/** The team tables of Better Auth 1.4.21, with no memberCount and no membershipKey (ruling 41 of plan 12k). */
export const BETTER_AUTH_1421_TEAMS_PG = pgTeams1421;
export const BETTER_AUTH_1421_TEAMS_SQLITE = sqliteTeams1421;

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
