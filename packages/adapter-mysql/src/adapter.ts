import type { FindManyOptions, ModelName, StorageAdapter, StorageError } from "@authtempo/core";
import {
  assertModel,
  fixedChunks,
  rowsPerInsertOf,
  type SqlStatements,
  type Statement,
} from "@authtempo/core/sql";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { guardData, guardWhere } from "./ascii-guard.js";
import type { Sent } from "./start-checks.js";

type Row = Record<string, unknown>;

/** What the adapter runs. `createMysqlAdapter` passes core's statements and the start checks. */
export interface MysqlAdapterOptions {
  statements: SqlStatements;
  toStorageError(model: ModelName, err: unknown): StorageError | null;
  /** The start checks, run once per adapter: the version, FOUND_ROWS, strict mode, the collations. */
  ready(): Promise<void>;
  /**
   * The version read of `ready` with no cache, each call (plan 12h Task 8).
   * It counts its own query in `sent`. The adapter's `ping` runs `ready`
   * first, then this read (ruling 27 of the 12g lane). Leave it out, and the
   * adapter has no `ping`.
   */
  ping?(): Promise<void>;
  /**
   * The count of statements, shared with the start checks, so that
   * `statementsSent` and `readyStatements` hold their queries too. A new
   * count starts at zero when this is left out.
   */
  sent?: Sent;
}

/** The state of one open transaction, shared by its savepoints. */
interface Txn {
  /** The deadlock error that ended the transaction, or null while it is alive. */
  dead: unknown;
}

interface Ctx extends Omit<MysqlAdapterOptions, "sent"> {
  pool: Pool;
  /** The connection of the open transaction, or null outside one. */
  conn: PoolConnection | null;
  /** The open transaction, or null outside one. */
  txn: Txn | null;
  /** The savepoint depth inside the open transaction. */
  depth: number;
  sent: Sent;
}

/**
 * The bound parameters of one statement: 65535. The COM_STMT_PREPARE_OK
 * answer carries `num_params` as int<2> (MySQL source docs, read
 * 2026-10-24), and more placeholders fail with error 1390
 * ER_PS_MANY_PARAM. The conformance row at the chunk edge passed with
 * 13107 rows, 65535 parameters, on MySQL 8.4 and 9.7 on 2026-10-24. A
 * statement now holds at most `INSERT_ROWS_MAX` (1000) rows, so this bound
 * acts only on a model of more than 65 columns.
 */
export const MYSQL_BOUND_PARAMS = 65_535;

/** MySQL error 1213: InnoDB ended the statement to break a deadlock. */
const LOCK_DEADLOCK = 1213;
/**
 * The tries of one statement outside a transaction that InnoDB ends in a
 * deadlock (ruling 13 of plan 12g). The account delete met one such deadlock
 * beside a reset (2026-10-21). Three tries cover a second meeting. A third
 * deadlock passes through, so a lock cycle never loops.
 */
const STATEMENT_TRIES = 3;

const isDeadlock = (e: unknown): boolean =>
  (e as { errno?: unknown } | null)?.errno === LOCK_DEADLOCK;

/**
 * InnoDB undoes the whole transaction on a deadlock, also inside a
 * savepoint. The session then runs each later statement in autocommit. So
 * the adapter refuses each later statement and the COMMIT of a dead
 * transaction.
 */
function assertAlive(txn: Txn | null): void {
  if (txn?.dead == null) return;
  throw new Error(
    "authtempo mysql: InnoDB rolled back this transaction after a deadlock (1213), so it takes no other statement",
    { cause: txn.dead },
  );
}

async function query(ctx: Ctx, s: Statement): Promise<RowDataPacket[] | ResultSetHeader> {
  assertAlive(ctx.txn);
  for (let attempt = 1; ; attempt++) {
    ctx.sent.statements++;
    try {
      // execute: a server prepared statement, so no value is ever part of the SQL text.
      const [res] = await (ctx.conn ?? ctx.pool).execute<RowDataPacket[] | ResultSetHeader>(
        s.sql,
        s.params as never[],
      );
      return res;
    } catch (e) {
      // InnoDB locks each row that a statement scans, also a row that does
      // not match. So a DELETE outside a transaction can meet the locks of a
      // transaction in another order. InnoDB then ends it as the victim of a
      // deadlock, where Postgres waits. Outside a transaction the statement
      // is its own unit, and InnoDB undid it whole, so the adapter sends it
      // again. A deadlock in a transaction undoes the transaction, so it
      // passes through and marks the transaction dead.
      const deadlock = isDeadlock(e);
      if (ctx.txn && deadlock) ctx.txn.dead ??= e;
      if (ctx.conn || !deadlock || attempt === STATEMENT_TRIES) throw e;
    }
  }
}

const rowsOf = (res: RowDataPacket[] | ResultSetHeader): Row[] =>
  Array.isArray(res) ? (res as Row[]) : [];
const countOf = (res: RowDataPacket[] | ResultSetHeader): number =>
  Array.isArray(res) ? 0 : res.affectedRows;

function adapterOn(ctx: Ctx): StorageAdapter {
  const self: StorageAdapter = {
    // The open transaction is isolated, and `keep` answers false in it (plan 12p).
    isolated: true,
    async create(model, data) {
      await ctx.ready();
      assertModel(model);
      guardData(model, data as unknown as Row);
      try {
        await query(ctx, ctx.statements.insert(model, data));
      } catch (e) {
        throw ctx.toStorageError(model, e) ?? e;
      }
      return structuredClone(data);
    },
    async createMany(model, rows) {
      await ctx.ready();
      assertModel(model);
      if (rows.length === 0) return [];
      for (const data of rows) guardData(model, data as unknown as Row);
      // InnoDB undoes a failed statement whole. More than one chunk runs in a
      // transaction (a savepoint inside one), one call per chunk, so the call
      // is all or nothing. A chunk takes a fixed size, so the server keeps few
      // prepared statements of the inserts (ruling 85 of plan 12d).
      const sizes = fixedChunks(rows.length, self.rowsPerInsert(model));
      if (sizes.length > 1) {
        await self.transaction(async (tx) => {
          let at = 0;
          for (const size of sizes) {
            await tx.createMany(model, rows.slice(at, at + size));
            at += size;
          }
        });
        return structuredClone([...rows]);
      }
      try {
        await query(ctx, ctx.statements.insertMany(model, rows));
      } catch (e) {
        throw ctx.toStorageError(model, e) ?? e;
      }
      return structuredClone([...rows]);
    },
    rowsPerInsert(model) {
      return rowsPerInsertOf(ctx.statements, model, MYSQL_BOUND_PARAMS);
    },
    async findOne(model, where) {
      await ctx.ready();
      const w = guardWhere(model, where);
      const s = w && ctx.statements.select(model, w, { limit: 1 });
      if (!s) return null;
      const rows = rowsOf(await query(ctx, s));
      return rows[0] ? ctx.statements.decode(model, rows[0]) : null;
    },
    async findMany(model, where, opts) {
      await ctx.ready();
      const w = guardWhere(model, where);
      const s = w && ctx.statements.select(model, w, opts);
      if (!s) return [];
      return rowsOf(await query(ctx, s)).map((r) => ctx.statements.decode(model, r));
    },
    async update(model, where, data) {
      await ctx.ready();
      guardData(model, data as unknown as Row);
      const w = guardWhere(model, where);
      const s = w && ctx.statements.update(model, w, data);
      if (!s) return 0;
      try {
        // FOUND_ROWS (a start check): affectedRows counts the matched rows, as on Postgres.
        return countOf(await query(ctx, s));
      } catch (e) {
        throw ctx.toStorageError(model, e) ?? e;
      }
    },
    async delete(model, where) {
      await ctx.ready();
      const w = guardWhere(model, where);
      const s = w && ctx.statements.delete(model, w);
      if (!s) return 0;
      return countOf(await query(ctx, s));
    },
    async deleteRows(model, where) {
      await ctx.ready();
      const w = guardWhere(model, where);
      // The checks of `delete`: an empty where throws, and a where that
      // matches no row answers at once.
      if (!w || !ctx.statements.delete(model, w)) return [];
      // MySQL has no DELETE … RETURNING (plan 12o). The read, the lock, and
      // the delete must be one unit, so a call outside a transaction opens one.
      if (!ctx.conn) return self.transaction((tx) => tx.deleteRows(model, where));
      const byId = { sort: { field: "id", dir: "asc" } } as FindManyOptions<typeof model>;
      const s = ctx.statements.select(model, w, byId);
      if (!s) return [];
      // The ids first, then the rows under their locks by id, as `lockInOrder`
      // takes them (ruling 2 of plan 12g). The locking read waits for the
      // lock of a row that another transaction writes. When that transaction
      // deleted the row, the read does not find it. The where comes again, so
      // a row that changed since the first read is left out.
      const ids = rowsOf(await query(ctx, s)).map((r) => r.id);
      if (ids.length === 0) return [];
      const lock = ctx.statements.select(
        model,
        [...w, { field: "id", op: "in", value: ids }],
        byId,
      );
      if (!lock) return [];
      const rows = rowsOf(await query(ctx, { sql: `${lock.sql} FOR UPDATE`, params: lock.params }));
      if (rows.length === 0) return [];
      // This transaction holds the lock of each row, so the delete by id removes each one.
      const del = ctx.statements.delete(model, [
        { field: "id", op: "in", value: rows.map((r) => r.id) },
      ]);
      if (del) await query(ctx, del);
      return rows.map((r) => ctx.statements.decode(model, r));
    },
    async keep() {
      // Nothing to do (plan 12o). InnoDB isolates the open transaction, so no
      // other caller reads its writes before the commit. A parallel proof of
      // the same user writes the user row too, so it waits for this row lock.
      // So a throw here may reverse the whole transaction. Outside a
      // transaction each write is final: true.
      return ctx.conn === null;
    },
    async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
      // The checks run on the pool. So they run before the transaction takes
      // its connection: on a pool of one, a check after it would wait forever.
      await ctx.ready();
      if (ctx.conn) return savepoint(ctx, ctx.conn, fn);
      return begin(ctx, fn);
    },
    statementsSent() {
      return ctx.sent.statements;
    },
    async readyStatements() {
      await ctx.ready();
      return ctx.sent.ready;
    },
    async lockInOrder(model, where) {
      await ctx.ready();
      // A lock outside a transaction ends with its statement, so it holds nothing.
      if (!ctx.conn) return;
      const w = guardWhere(model, where);
      const byId = { sort: { field: "id", dir: "asc" } } as FindManyOptions<typeof model>;
      const s = w && ctx.statements.select(model, w, byId);
      if (!s) return;
      // InnoDB locks each index record as it scans, in the order of the index
      // that it reads, before ORDER BY. A where on user_id reads the user_id
      // index, so FOR UPDATE there locks in (user_id, id) order. So the
      // adapter reads the ids first and then locks them on PRIMARY, which is
      // id order (ruling 2 of plan 12g).
      const ids = rowsOf(await query(ctx, s)).map((r) => r.id);
      if (ids.length === 0) return;
      const lock = ctx.statements.select(model, [{ field: "id", op: "in", value: ids }], byId);
      if (!lock) return;
      await query(ctx, { sql: `${lock.sql} FOR UPDATE`, params: lock.params });
    },
  };
  // The start checks come first, so a pool that every call refuses is not
  // ready (ruling 27 of the 12g lane). `ready` keeps a pass and not a
  // failure, so the version read below is the only statement of a ping
  // after the first pass.
  const ping = ctx.ping;
  if (ping)
    self.ping = async () => {
      await ctx.ready();
      await ping();
    };
  return self;
}

/**
 * MySQL locks rows, so this is the Postgres model, not the D1 undo log. One
 * pool connection holds the transaction. READ COMMITTED is the Postgres
 * default and takes fewer gap locks than REPEATABLE READ. A read after a
 * lock then sees the commit of the other caller, which the 12k limits need.
 * The undo statements of `coreStatements` are never called here.
 */
async function begin<T>(ctx: Ctx, fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
  const conn = await ctx.pool.getConnection();
  // A connection whose rollback failed may still hold the transaction, so it goes, not back to the pool.
  let broken = false;
  try {
    await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await conn.query("START TRANSACTION");
    const txn: Txn = { dead: null };
    try {
      const result = await fn(adapterOn({ ...ctx, conn, txn, depth: 0 }));
      // A caller that caught the deadlock and returned must not see a commit.
      assertAlive(txn);
      await conn.query("COMMIT");
      return result;
    } catch (e) {
      try {
        await conn.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw e;
    }
  } finally {
    if (broken) conn.destroy();
    else conn.release();
  }
}

/** A nested transaction is a savepoint on the same connection. */
async function savepoint<T>(
  ctx: Ctx,
  conn: PoolConnection,
  fn: (tx: StorageAdapter) => Promise<T>,
): Promise<T> {
  const depth = ctx.depth + 1;
  const name = `sp_${depth}`;
  assertAlive(ctx.txn);
  await conn.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn(adapterOn({ ...ctx, conn, depth }));
    assertAlive(ctx.txn);
    await conn.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (e) {
    // After a deadlock the savepoint is gone, and ROLLBACK TO fails with
    // 1305. The first error is the cause, so it passes through.
    try {
      await conn.query(`ROLLBACK TO SAVEPOINT ${name}`);
    } catch {
      // The savepoint is gone with the transaction. The first error follows.
    }
    throw e;
  }
}

export function createMysqlAdapterOn(pool: Pool, options: MysqlAdapterOptions): StorageAdapter {
  const { sent = { statements: 0, ready: 0 }, ...rest } = options;
  return adapterOn({ ...rest, pool, conn: null, txn: null, depth: 0, sent });
}
