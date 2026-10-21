import { StorageError } from "@authtempo/core";
import {
  assertSchemaValue,
  META_TABLE,
  MYSQL,
  SCHEMA_VERSION_KEY,
  schemaVersionGate,
} from "@authtempo/core/sql";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

/** MySQL error 1146, "Table doesn't exist": the migrations never ran. */
const NO_SUCH_TABLE = 1146;

/** The collation of every authtempo table (Task 1 of plan 12g): `=` compares bytes. */
export const MYSQL_TABLE_COLLATION = "utf8mb4_0900_bin";

/** The count of statements sent, shared with the adapter. `ready` counts the statements of the checks. */
export interface Sent {
  statements: number;
  ready: number;
}

function mismatch(setting: string, why: string): StorageError {
  const e = new StorageError("config_mismatch", "meta", [setting]);
  e.message = `${e.message}: ${why}`;
  return e;
}

const meta = MYSQL.quote(META_TABLE);
const key = MYSQL.quote("key");
const value = MYSQL.quote("value");

/**
 * One read of the stored schema version. Only error 1146 reads as no
 * version, so an outage never reads as "run the migrations".
 */
async function readVersion(pool: Pool): Promise<string | null> {
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT ${value} FROM ${meta} WHERE ${key} = ?`,
      [SCHEMA_VERSION_KEY],
    );
    return (rows[0]?.value as string | undefined) ?? null;
  } catch (e) {
    if ((e as { errno?: unknown } | null)?.errno === NO_SUCH_TABLE) return null;
    throw e;
  }
}

/**
 * The four checks at start of the MySQL adapter (plan 12g, Task 5). It runs
 * them once, keeps a pass, and does not keep a failure, as the version gate
 * does. Each message names the setting, never a value.
 *
 * 1. The schema version. Only error 1146 reads as no version, so an outage
 *    never reads as "run the migrations".
 * 2. FOUND_ROWS. Without the flag, MySQL answers the changed rows. An
 *    update that writes the same value then counts 0, and the engine reads
 *    a lost race.
 * 3. Strict mode. Without it, MySQL cuts a long value and stores it.
 * 4. The binary collation of each `ta_` table. A case-blind collation makes
 *    two credential ids that differ only in case one key.
 */
export function mysqlStartChecks(
  pool: Pool,
  sent: Sent = { statements: 0, ready: 0 },
): () => Promise<void> {
  const count = () => {
    sent.statements++;
    sent.ready++;
  };
  const version = schemaVersionGate(async () => {
    count();
    return readVersion(pool);
  });
  let checked: Promise<void> | null = null;
  return () => {
    checked ??= (async () => {
      try {
        await version();
        count();
        const [res] = await pool.execute<ResultSetHeader>(
          `UPDATE ${meta} SET ${value} = ${value} WHERE ${key} = ?`,
          [SCHEMA_VERSION_KEY],
        );
        if (res.affectedRows !== 1)
          throw mismatch(
            "FOUND_ROWS",
            "the pool reports changed rows, not matched rows; keep the mysql2 flag FOUND_ROWS",
          );
        count();
        const [mode] = await pool.query<RowDataPacket[]>("SELECT @@SESSION.sql_mode AS mode");
        const modes = String(mode[0]?.mode ?? "").split(",");
        if (!modes.includes("STRICT_TRANS_TABLES") && !modes.includes("STRICT_ALL_TABLES"))
          throw mismatch(
            "sql_mode",
            "the session has no strict mode; set sql_mode to include STRICT_TRANS_TABLES",
          );
        count();
        const [tables] = await pool.query<RowDataPacket[]>(
          "SELECT TABLE_NAME AS name, TABLE_COLLATION AS collation FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'ta\\_%' ORDER BY TABLE_NAME",
        );
        const wrong = tables.filter((t) => t.collation !== MYSQL_TABLE_COLLATION);
        if (wrong.length > 0)
          throw mismatch(
            "collation",
            `${wrong.map((t) => `table ${t.name} has the collation ${t.collation}`).join(", ")}; each authtempo table needs ${MYSQL_TABLE_COLLATION}`,
          );
      } catch (e) {
        checked = null;
        throw e;
      }
    })();
    return checked;
  };
}

/**
 * The version read of the adapter's `ping` (plan 12h Task 8, ruling 26 of
 * the 12g lane): the version read of the checks with no cache, each call.
 * It never sets the gate of the checks. Its query counts in
 * `statementsSent` only. The adapter runs the start checks before it
 * (ruling 27).
 */
export function mysqlSchemaVersionPing(
  pool: Pool,
  sent: { statements: number } = { statements: 0 },
): () => Promise<void> {
  return async () => {
    sent.statements++;
    assertSchemaValue(await readVersion(pool));
  };
}
