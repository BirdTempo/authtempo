import {
  assertSchemaValue,
  META_TABLE,
  SCHEMA_VERSION_KEY,
  schemaVersionGate,
} from "@authtempo/core/sql";

/**
 * One read of the stored schema version. Only a missing table ("no such
 * table") counts as "no version", because that means the migrations never
 * ran. Every other error passes through, so a D1 outage never reads as "run
 * the migrations".
 */
async function readVersion(db: D1Database): Promise<string | null> {
  try {
    return await db
      .prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`)
      .bind(SCHEMA_VERSION_KEY)
      .first<string>("value");
  } catch (e) {
    if (e instanceof Error && e.message.includes("no such table")) return null;
    throw e;
  }
}

/** The schema version check for D1, on the core gate. */
export function schemaVersionCheck(
  db: D1Database,
  sent?: { statements: number; ready?: number },
): () => Promise<void> {
  return schemaVersionGate(async () => {
    // The query counts in `statementsSent` of the adapter (ruling 35 of plan
    // 12f), and in its `readyStatements` (ruling 37).
    if (sent) {
      sent.statements++;
      if (sent.ready !== undefined) sent.ready++;
    }
    return readVersion(db);
  });
}

/**
 * The `ping` of the adapter (plan 12h Task 8): the same read with no cache,
 * each call. It never sets the gate above, so `readyStatements` stays the
 * same. Its query counts in `statementsSent` only.
 */
export function schemaVersionPing(
  db: D1Database,
  sent?: { statements: number },
): () => Promise<void> {
  return async () => {
    if (sent) sent.statements++;
    assertSchemaValue(await readVersion(db));
  };
}
