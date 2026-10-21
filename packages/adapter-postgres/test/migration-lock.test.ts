import postgres, { type Sql } from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPostgresMigrations, MIGRATIONS } from "../src/migrations.js";
import { createSchema, PG_URL } from "./db.js";

// Ruling 52 of plan 12k. The advisory lock key of a migration names its
// schema. A run that holds the lock of one schema stops a second run on the
// same schema, and never a run on another schema. The tests pause a real run
// inside a step: a holder locks ta_migrations, so the run waits there and
// keeps its advisory lock. pg_locks then shows which runs hold or wait.

// The releases run first, so no client ends while a run waits on the holder.
const releases: (() => Promise<void>)[] = [];
const ends: (() => Promise<void>)[] = [];
const drops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const list of [releases, ends, drops]) for (const c of list.splice(0)) await c();
});

/** A client on one schema. `app` names its backend in pg_stat_activity. */
function client(schemaName: string, app: string, timeout?: string): Sql {
  const connection: Record<string, string> = { search_path: schemaName, application_name: app };
  if (timeout) connection.statement_timeout = timeout;
  const sql = postgres(PG_URL, { max: 1, onnotice: () => {}, connection });
  ends.push(() => sql.end({ timeout: 5 }));
  return sql;
}

async function schemaOf(): Promise<string> {
  const name = await createSchema();
  drops.push(async () => {
    const admin = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`DROP SCHEMA ${name} CASCADE`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });
  return name;
}

/**
 * Creates the empty ta_migrations of a run that stopped after its first step,
 * and holds an exclusive lock of it in an open transaction. Answers the
 * release. A run on this schema then waits at its first read of the table,
 * inside a step that holds the advisory lock.
 */
async function holdTable(schemaName: string): Promise<() => Promise<void>> {
  const sql = client(schemaName, `hold_${schemaName}`);
  await sql.unsafe(
    "CREATE TABLE ta_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let locked = () => {};
  const held = new Promise<void>((r) => {
    locked = r;
  });
  const done = sql.begin(async (tx) => {
    await tx.unsafe("LOCK TABLE ta_migrations IN ACCESS EXCLUSIVE MODE");
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

const NAMES = MIGRATIONS.map((m) => m.name);

describe("postgres migration lock", () => {
  it("makes a second run on one schema wait on the lock of the schema, and runs each step once", async () => {
    const s = await schemaOf();
    const free = await holdTable(s);
    const first = applyPostgresMigrations(client(s, `one_${s}`));
    first.catch(() => {});
    await advisory(`one_${s}`, true);
    const second = applyPostgresMigrations(client(s, `two_${s}`));
    second.catch(() => {});
    await advisory(`two_${s}`, false);
    await free();
    // The lock is per step, so the second run can take a later step after a
    // commit of the first. The first run holds step 1. Each step runs once.
    const [a, b] = [await first, await second];
    expect(a[0]).toBe(NAMES[0]);
    expect([...a, ...b].sort()).toEqual(NAMES);
  });

  it("lets a run on a second schema finish while a run on the first schema holds its lock", async () => {
    const held = await schemaOf();
    const other = await schemaOf();
    const free = await holdTable(held);
    const first = applyPostgresMigrations(client(held, `one_${held}`));
    first.catch(() => {});
    await advisory(`one_${held}`, true);
    // A wait on the lock of the first schema ends in a statement timeout.
    expect(await applyPostgresMigrations(client(other, `two_${other}`, "3s"))).toEqual(NAMES);
    await free();
    expect(await first).toEqual(NAMES);
  });
});
