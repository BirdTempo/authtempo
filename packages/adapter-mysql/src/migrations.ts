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

/** The errors of a step whose object exists: a table 1050, a column 1060, a key 1061, a row 1062. */
const EXISTS_ERRORS: ReadonlySet<number> = new Set([1050, 1060, 1061, 1062]);
/** The most objects of one ALTER step that the check drops and makes again. */
const MAX_ALTER_OBJECTS = 16;

type StepForm = { kind: "table" | "alter" | "row"; table: string };

/** The table and the form of a step, for the errors that its form can give. */
function stepForm(sql: string, errno: number): StepForm | null {
  const create = /^CREATE TABLE `([^`]+)`/.exec(sql);
  if (create && errno === 1050) return { kind: "table", table: create[1] as string };
  const alter = /^ALTER TABLE `([^`]+)`/.exec(sql);
  if (alter && (errno === 1060 || errno === 1061))
    return { kind: "alter", table: alter[1] as string };
  const index = /^CREATE (?:UNIQUE )?INDEX `[^`]+` ON `([^`]+)`/.exec(sql);
  if (index && errno === 1061) return { kind: "alter", table: index[1] as string };
  const insert = /^INSERT INTO `([^`]+)`/.exec(sql);
  if (insert && errno === 1062) return { kind: "row", table: insert[1] as string };
  return null;
}

async function createText(conn: Connection, table: string): Promise<string> {
  const [rows] = await conn.query<RowDataPacket[]>(`SHOW CREATE TABLE \`${table}\``);
  return String(rows[0]?.["Create Table"])
    .replace(/^CREATE (TEMPORARY )?TABLE `[^`]+`/, "CREATE TABLE")
    .replace(/ AUTO_INCREMENT=\d+/, "");
}

const errnoOf = (e: unknown): unknown => (e as { errno?: unknown } | null)?.errno;
/** The quoted name in a MySQL error text, such as `Duplicate column name 'c'`. */
const nameIn = (e: unknown): string | null =>
  /'([^']+)'/.exec(String((e as Error | null)?.message))?.[1] ?? null;

/**
 * The check of an unrecorded step that failed because its object exists. A
 * stop between a step and its record leaves that state. The check runs the
 * step again on a TEMPORARY copy of its table and compares the result with
 * the live table. A copy is never in information_schema, and it ends with the
 * session. It answers true when the live object is the one the step makes.
 */
export async function stepMade(conn: Connection, sql: string, err: unknown): Promise<boolean> {
  const errno = errnoOf(err);
  if (typeof errno !== "number" || !EXISTS_ERRORS.has(errno)) return false;
  const form = stepForm(sql, errno);
  if (!form) return false;
  const copy = `authtempo_check_${form.table}`;
  const quoted = `\`${form.table}\``;
  const replay = sql.replace(quoted, `\`${copy}\``);
  await conn.query(`DROP TEMPORARY TABLE IF EXISTS \`${copy}\``);
  try {
    if (form.kind === "table") {
      await conn.query(replay.replace(/^CREATE TABLE/, "CREATE TEMPORARY TABLE"));
      return (await createText(conn, copy)) === (await createText(conn, form.table));
    }
    await conn.query(`CREATE TEMPORARY TABLE \`${copy}\` LIKE ${quoted}`);
    if (form.kind === "row") {
      await conn.query(replay);
      const [columns] = await conn.query<RowDataPacket[]>(`SHOW COLUMNS FROM \`${copy}\``);
      const same = columns.map((c) => `l.\`${c.Field}\` <=> s.\`${c.Field}\``).join(" AND ");
      const [missing] = await conn.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM \`${copy}\` AS s WHERE NOT EXISTS (SELECT 1 FROM ${quoted} AS l WHERE ${same})`,
      );
      return Number(missing[0]?.n) === 0;
    }
    // The copy holds the objects of the step. Each one that the step names
    // as existing is dropped from the copy, and the step runs again on it.
    let last: unknown = err;
    for (let i = 0; i < MAX_ALTER_OBJECTS; i++) {
      const name = nameIn(last);
      if (name === null) return false;
      const drop = errnoOf(last) === 1060 ? "COLUMN" : "INDEX";
      await conn.query(`ALTER TABLE \`${copy}\` DROP ${drop} \`${name}\``);
      try {
        await conn.query(replay);
        return (await createText(conn, copy)) === (await createText(conn, form.table));
      } catch (e) {
        const n = errnoOf(e);
        if (n !== 1060 && n !== 1061) return false;
        last = e;
      }
    }
    return false;
  } finally {
    await conn.query(`DROP TEMPORARY TABLE IF EXISTS \`${copy}\``);
  }
}

/**
 * The steps of the runner without the lock, on one connection. MySQL
 * commits each DDL statement at once, and each one is atomic since 8.0. So
 * the runner records each step and resumes at the next step after a
 * failure. A step is recorded only after it ran. The last step of each
 * migration is the ta_meta update, so a half-run migration never reports
 * its version. It answers the names of the migrations that it changed.
 *
 * The step and its record are two statements. A stop between them leaves a
 * step that ran and has no record. On the next run that step fails because
 * its object exists. When `stepMade` finds the live object as the step makes
 * it, the runner records the step and goes on. Any other state stops the run.
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
      try {
        await run(conn, sql);
      } catch (e) {
        if (!(await stepMade(conn, sql, e))) {
          if (!EXISTS_ERRORS.has(errnoOf(e) as number)) throw e;
          throw new Error(
            `authtempo migrations: step ${step} of ${m.name} failed with ${String(errnoOf(e))}, and its object is not the one the step makes. No later step ran. Compare the table with the step text in MYSQL_MIGRATIONS, and correct it by hand.`,
            { cause: e },
          );
        }
      }
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
