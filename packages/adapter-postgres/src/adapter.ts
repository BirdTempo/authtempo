import type { FindManyOptions, ModelName, StorageAdapter, StorageError } from "@authtempo/core";
import {
  assertModel,
  returnedParts,
  rowsPerInsertOf,
  type SqlStatements,
  type Statement,
} from "@authtempo/core/sql";
import type { Sql, TransactionSql } from "postgres";

type Row = Record<string, unknown>;
type Conn = Sql | TransactionSql;

/** What the adapter runs. `createPostgresAdapter` passes core's statements; plan 9's compatibility storage passes its own. */
export interface PostgresAdapterOptions {
  statements: SqlStatements;
  toStorageError(model: ModelName, err: unknown): StorageError | null;
  /** The schema version check, run once per adapter. */
  ready(): Promise<void>;
  /**
   * The check of `ready` with no cache, each call: the adapter's `ping`
   * (plan 12h Task 8). Leave it out, and the adapter has no `ping`.
   */
  ping?(): Promise<void>;
}

/**
 * The bound parameters of one statement: 65533. The Bind message carries
 * the count as an Int16 (PostgreSQL docs, Message Formats, read
 * 2026-10-24), so the server takes at most 65535. postgres.js 3.4.9 is
 * lower: it throws MAX_PARAMETERS_EXCEEDED at 65534 or more
 * (src/connection.js, read 2026-10-24). The conformance row at the chunk
 * edge found that limit with a chunk of 13107 rows. Since then a statement
 * holds at most `INSERT_ROWS_MAX` (1000) rows, so this bound acts only on a
 * model of more than 65 columns.
 */
export const POSTGRES_BOUND_PARAMS = 65_533;

interface Ctx extends PostgresAdapterOptions {
  conn: Conn;
  inTransaction: boolean;
  /** The statements sent, shared with each transaction (`statementsSent`, ruling 35 of plan 12f). */
  sent: { statements: number };
}

async function query(ctx: Ctx, s: Statement): Promise<{ rows: Row[]; count: number }> {
  ctx.sent.statements++;
  const conn = ctx.conn;
  // The builder casts json parameters with `$n::text::jsonb`, so postgres.js
  // sends the serialized text unchanged and the server parses it.
  const res = await conn.unsafe<Row[]>(s.sql, s.params as never[]);
  return { rows: res as unknown as Row[], count: res.count };
}

function adapterOn(ctx: Ctx): StorageAdapter {
  const self: StorageAdapter = {
    async create(model, data) {
      await ctx.ready();
      assertModel(model);
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
      // More than one chunk runs in a transaction (a savepoint inside one), one
      // call per chunk, so the call is all or nothing.
      const size = self.rowsPerInsert(model);
      if (rows.length > size) {
        await self.transaction(async (tx) => {
          for (let i = 0; i < rows.length; i += size)
            await tx.createMany(model, rows.slice(i, i + size));
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
      return rowsPerInsertOf(ctx.statements, model, POSTGRES_BOUND_PARAMS);
    },
    async findOne(model, where) {
      await ctx.ready();
      const s = ctx.statements.select(model, where, { limit: 1 });
      if (!s) return null;
      const { rows } = await query(ctx, s);
      return rows[0] ? ctx.statements.decode(model, rows[0]) : null;
    },
    async findMany(model, where, opts) {
      await ctx.ready();
      const s = ctx.statements.select(model, where, opts);
      if (!s) return [];
      return (await query(ctx, s)).rows.map((r) => ctx.statements.decode(model, r));
    },
    async update(model, where, data) {
      await ctx.ready();
      const s = ctx.statements.update(model, where, data);
      if (!s) return 0;
      try {
        return (await query(ctx, s)).count;
      } catch (e) {
        throw ctx.toStorageError(model, e) ?? e;
      }
    },
    async delete(model, where) {
      await ctx.ready();
      const s = ctx.statements.delete(model, where);
      if (!s) return 0;
      return (await query(ctx, s)).count;
    },
    async deleteRows(model, where) {
      await ctx.ready();
      // One DELETE … RETURNING (plan 12o). Under read committed it waits for
      // the lock of a row that another transaction writes. When that
      // transaction deleted the row, the statement skips it. So the answer is
      // the rows that this statement removed.
      const st = ctx.statements;
      const s = st.deleteReturningRead
        ? st.deleteReturningRead(model, where)
        : st.deleteReturning(model, where);
      if (!s) return [];
      return (await query(ctx, s)).rows.map((r) => st.decode(model, returnedParts(r).read));
    },
    async keep() {
      // Nothing to do (plan 12o). Postgres isolates the open transaction, so
      // no other caller reads its writes before the commit. A parallel proof
      // of the same user writes the user row too, so it waits for this row
      // lock. So a throw here may reverse the whole transaction. Outside a
      // transaction each write is final: true.
      return !ctx.inTransaction;
    },
    async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
      await ctx.ready();
      if (ctx.inTransaction) {
        // A nested transaction is a savepoint on the same connection.
        return savepoint(ctx.conn as TransactionSql, (sp) =>
          fn(adapterOn({ ...ctx, conn: sp, inTransaction: true })),
        );
      }
      return begin(ctx.conn as Sql, (tx) =>
        fn(adapterOn({ ...ctx, conn: tx, inTransaction: true })),
      );
    },
    statementsSent() {
      return ctx.sent.statements;
    },
    async lockInOrder(model, where) {
      await ctx.ready();
      // A lock outside a transaction ends with its statement, so it holds nothing.
      if (!ctx.inTransaction) return;
      const s = ctx.statements.select(model, where, {
        sort: { field: "id", dir: "asc" },
      } as FindManyOptions<typeof model>);
      if (!s) return;
      // FOR UPDATE takes each lock as the sort hands the row on, so by id (ruling 36 of plan 12f).
      await query(ctx, { sql: `${s.sql} FOR UPDATE`, params: s.params });
    },
  };
  const ping = ctx.ping;
  if (ping)
    self.ping = async () => {
      // A port call, so it counts in `statementsSent` as each other call does.
      ctx.sent.statements++;
      await ping();
    };
  return self;
}

/** `begin` reserves one connection, runs fn, commits on resolve, rolls back and rethrows on throw. */
async function begin<T>(sql: Sql, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(fn)) as T;
}

async function savepoint<T>(
  tx: TransactionSql,
  fn: (sp: TransactionSql) => Promise<T>,
): Promise<T> {
  return (await tx.savepoint(fn)) as T;
}

export function createPostgresAdapterOn(sql: Sql, options: PostgresAdapterOptions): StorageAdapter {
  return adapterOn({ ...options, conn: sql, inTransaction: false, sent: { statements: 0 } });
}
