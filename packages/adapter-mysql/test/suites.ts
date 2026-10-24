import {
  runAdapterConformance,
  runRefreshRaceConformance,
  runSecretRotationConformance,
} from "@authtempo/core/conformance";
import { runLimiterConformance, runPhoneCapConformance } from "@authtempo/core/limiter-conformance";
import { runShapeConformance, type ShapeSide } from "@authtempo/core/shape-conformance";
import { MYSQL } from "@authtempo/core/sql";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { afterAll } from "vitest";
import {
  createMysqlAdapter,
  createMysqlLimiter,
  expectedMysqlShape,
  readMysqlShape,
} from "../src/index.js";
import { MYSQL_MIGRATIONS } from "../src/migrations.js";
import { databaseSupply, freshDatabase, type MysqlDatabase, type MysqlServer } from "./db.js";

// One migrated database per test, as on Postgres. Deviation 12 of plan 12g
// shared one database and deleted its rows, but a deleted row stays in a
// unique index until InnoDB purges it. A duplicate check there takes a gap
// lock. So an insert of the next test waited on another insert, in "keeps a
// write made outside a failing transaction" on 8.4.11 (2026-10-21). TRUNCATE
// took 1.2 to 1.7 s per test. So the databases come from a supply that
// makes them ahead of the tests.

function manualClock() {
  let t = new Date("2026-01-01T00:00:00.000Z").getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** The live shape and the version row of the database of `pool`. */
async function side(pool: Pool): Promise<ShapeSide> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT `value` FROM `ta_meta` WHERE `key` = 'schema_version'",
  );
  return { shape: await readMysqlShape(pool), version: (rows[0]?.value as string) ?? null };
}

/** Every conformance suite of core on one MySQL server (rulings 5 and 7 of plan 12g). */
export function runMysqlSuites(server: MysqlServer): void {
  const name = `mysql ${server.version}`;
  const supply = databaseSupply(server);
  afterAll(() => supply.drain());

  const target = async () => {
    const db = await supply.take();
    return { adapter: createMysqlAdapter(db.pool), close: () => db.close() };
  };

  /**
   * A database at the version before SCHEMA_VERSION: the ping must throw
   * schema_mismatch there (plan 12h Task 8). It holds every MySQL file but
   * the last, the file of SCHEMA_VERSION (0003_schema_v15 since plan 12i).
   * An app has such a database before it runs the new file.
   */
  const oldStore = async () => {
    const db = await freshDatabase(server, { migrate: false });
    for (const m of MYSQL_MIGRATIONS.slice(0, -1))
      for (const sql of m.statements) await db.pool.query(sql);
    return { adapter: createMysqlAdapter(db.pool), close: () => db.close() };
  };

  // MySQL has row locks, so the adapter must have lockInOrder (ruling 37 of
  // plan 12f). Its lock is two statements: the ids, then the lock by id. The
  // adapter must have its ping (ruling 26 of the 12g lane).
  runAdapterConformance(name, target, { rowLocks: true, lockStatements: 2, ping: true, oldStore });

  runLimiterConformance(name, async () => {
    const db = await supply.take();
    const clock = manualClock();
    return { limiter: createMysqlLimiter(db.pool, clock), clock, close: () => db.close() };
  });

  // The daily cap of the phone code under 40 parallel sends (plan 12i Task 4).
  runPhoneCapConformance(name, async () => {
    const db = await supply.take();
    return {
      limiter: createMysqlLimiter(db.pool),
      storage: createMysqlAdapter(db.pool),
      close: () => db.close(),
    };
  });

  // Rulings 40 and 43 of plan 12e and plan 12b on MySQL (ruling 5 of plan 12g).
  runSecretRotationConformance(name, target);
  runRefreshRaceConformance(name, target);

  runShapeConformance(name, async () => {
    const made: MysqlDatabase[] = [];
    return {
      dialect: MYSQL,
      expected: expectedMysqlShape(),
      async shipped() {
        const db = await supply.take();
        made.push(db);
        return side(db.pool);
      },
      async fromDdl(statements) {
        const db = await freshDatabase(server, { migrate: false });
        made.push(db);
        for (const s of statements) await db.pool.query(s);
        return side(db.pool);
      },
      async close() {
        for (const db of made) await db.close();
      },
    };
  });
}
