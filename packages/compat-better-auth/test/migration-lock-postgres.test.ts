import postgres, { type Sql } from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../src/storage/index.js";
import { COMPAT_MIGRATION_NAMES } from "../src/storage/migration.js";
import { BETTER_AUTH_PG } from "./fixtures.js";
import { freshBetterAuthSchema, PG_URL } from "./pg.js";

// Ruling 52 of plan 12k. The advisory lock key of a compat migration names
// its schema. A run that holds the lock of one schema stops a second run on
// the same schema, and never a run on another schema. The tests pause a real
// run inside its first step. A holder locks the account table, so the run
// waits at its ALTER TABLE and keeps its advisory lock.

// The releases run first, so no client ends while a run waits on the holder.
const releases: (() => Promise<void>)[] = [];
const ends: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const list of [releases, ends]) for (const c of list.splice(0)) await c();
});

/** A Better Auth schema with no compat migration. Answers its name. */
async function schemaOf(): Promise<string> {
  const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
  ends.push(() => pg.close());
  const rows = await pg.sql<{ s: string }[]>`SELECT current_schema() AS s`;
  return rows[0]?.s ?? "";
}

/** A client on one schema. `app` names its backend in pg_stat_activity. */
function client(schemaName: string, app: string, timeout?: string): Sql {
  const connection: Record<string, string> = { search_path: schemaName, application_name: app };
  if (timeout) connection.statement_timeout = timeout;
  const sql = postgres(PG_URL, { max: 1, onnotice: () => {}, connection });
  ends.unshift(() => sql.end({ timeout: 5 }));
  return sql;
}

const migrate = (sql: Sql) => betterAuthSchemaStorage({ dialect: "postgres", sql }).migrate();

/** Holds an exclusive lock of the account table in an open transaction. Answers the release. */
async function holdAccount(schemaName: string): Promise<() => Promise<void>> {
  const sql = client(schemaName, `hold_${schemaName}`);
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let locked = () => {};
  const held = new Promise<void>((r) => {
    locked = r;
  });
  const done = sql.begin(async (tx) => {
    await tx.unsafe('LOCK TABLE "account" IN ACCESS EXCLUSIVE MODE');
    locked();
    await gate;
  });
  await held;
  const free = async () => {
    release();
    await done;
  };
  releases.push(free);
  return free;
}

/** Waits until the backend `app` holds (true) or waits on (false) an advisory lock. */
async function advisory(app: string, granted: boolean): Promise<void> {
  const watch = postgres(PG_URL, { max: 1, onnotice: () => {} });
  try {
    for (let i = 0; i < 200; i++) {
      const rows = await watch<{ granted: boolean }[]>`
        SELECT l.granted FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE a.application_name = ${app} AND l.locktype = 'advisory'`;
      if (rows.some((r) => r.granted === granted)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${app} never ${granted ? "held" : "waited on"} an advisory lock`);
  } finally {
    await watch.end({ timeout: 5 });
  }
}

// Each test sets up two Better Auth schemas, and a wait poll runs up to 10 s.
// The default 5 s test timeout is too short for that under load.
describe("compat migration lock on Postgres", { timeout: 15_000 }, () => {
  it("makes a second run on one schema wait on the lock of the schema, and runs each step once", async () => {
    const s = await schemaOf();
    const free = await holdAccount(s);
    const first = migrate(client(s, `one_${s}`));
    first.catch(() => {});
    await advisory(`one_${s}`, true);
    const second = migrate(client(s, `two_${s}`));
    second.catch(() => {});
    await advisory(`two_${s}`, false);
    await free();
    // The lock is per step, so the second run can take a later step after a
    // commit of the first. The first run holds step 1. Each step runs once.
    const [a, b] = [await first, await second];
    expect(a[0]).toBe(COMPAT_MIGRATION_NAMES[0]);
    expect([...a, ...b].sort()).toEqual([...COMPAT_MIGRATION_NAMES]);
  });

  it("lets a run on a second schema finish while a run on the first schema holds its lock", async () => {
    const held = await schemaOf();
    const other = await schemaOf();
    const free = await holdAccount(held);
    const first = migrate(client(held, `one_${held}`));
    first.catch(() => {});
    await advisory(`one_${held}`, true);
    // A wait on the lock of the first schema ends in a statement timeout.
    expect(await migrate(client(other, `two_${other}`, "3s"))).toEqual([...COMPAT_MIGRATION_NAMES]);
    await free();
    expect(await first).toEqual([...COMPAT_MIGRATION_NAMES]);
  });
});
