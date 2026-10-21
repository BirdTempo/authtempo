import type { Connection, Pool, RowDataPacket } from "mysql2/promise";
import * as m0001 from "./migrations/0001_schema_v13.js";

export interface MysqlMigration {
  name: string;
  statements: readonly string[];
}

/** Every migration in order. Append only. */
export const MYSQL_MIGRATIONS: readonly MysqlMigration[] = [
  { name: m0001.name, statements: m0001.statements },
];

/** The runner's own table: one row per statement that ran, by migration name and step. */
export const MIGRATIONS_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS `ta_migrations` (`name` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, `step` INT NOT NULL, `applied_at` BIGINT NOT NULL, PRIMARY KEY (`name`, `step`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin";

/** A new name: the two Postgres advisory lock names do not change. */
const LOCK_NAME = "authtempo_migrations";
/** Seconds that GET_LOCK waits for another runner. */
const LOCK_WAIT_SECONDS = 60;

/** Runs one statement of a migration. A test passes its own to stop the runner at a step. */
export type RunStep = (conn: Connection, sql: string) => Promise<void>;

const runStep: RunStep = async (conn, sql) => {
  await conn.query(sql);
};

/**
 * The steps of the runner without the lock, on one connection. MySQL
 * commits each DDL statement at once, and each one is atomic since 8.0. So
 * the runner records each step and resumes at the next step after a
 * failure. A step is recorded only after it ran. The last step of each
 * migration is the ta_meta update, so a half-run migration never reports
 * its version. It answers the names of the migrations that it changed.
 */
export async function migrateSteps(conn: Connection, run: RunStep = runStep): Promise<string[]> {
  await conn.query(MIGRATIONS_TABLE_SQL);
  const [rows] = await conn.query<RowDataPacket[]>("SELECT `name`, `step` FROM `ta_migrations`");
  const done = new Set(rows.map((r) => `${r.name}:${r.step}`));
  const applied: string[] = [];
  for (const m of MYSQL_MIGRATIONS) {
    for (const [i, sql] of m.statements.entries()) {
      const step = i + 1;
      if (done.has(`${m.name}:${step}`)) continue;
      await run(conn, sql);
      await conn.execute(
        "INSERT INTO `ta_migrations` (`name`, `step`, `applied_at`) VALUES (?, ?, ?)",
        [m.name, step, Date.now()],
      );
      if (applied.at(-1) !== m.name) applied.push(m.name);
    }
  }
  return applied;
}

/** `applyMysqlMigrations` with the step runner of a test. */
export async function applyMysqlMigrationsWith(pool: Pool, run: RunStep): Promise<string[]> {
  const conn = await pool.getConnection();
  try {
    // A named lock belongs to the session, so every statement below runs on this connection.
    const [rows] = await conn.query<RowDataPacket[]>("SELECT GET_LOCK(?, ?) AS got", [
      LOCK_NAME,
      LOCK_WAIT_SECONDS,
    ]);
    if (rows[0]?.got !== 1)
      throw new Error(
        `authtempo migrations: the MySQL lock ${LOCK_NAME} is held by another runner; no step ran`,
      );
    try {
      return await migrateSteps(conn, run);
    } finally {
      await conn.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
    }
  } finally {
    conn.release();
  }
}

/**
 * Applies the steps that `ta_migrations` does not list yet, in order, and
 * answers the names of the migrations that it changed. It is safe on every
 * deploy, also from two replicas at once. The runner first takes the named
 * lock `authtempo_migrations`. So a second runner waits and then finds each
 * step recorded.
 */
export function applyMysqlMigrations(pool: Pool): Promise<string[]> {
  return applyMysqlMigrationsWith(pool, runStep);
}
