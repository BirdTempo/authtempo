import type { FindManyOptions, ModelName, StorageAdapter, StorageError } from "@authtempo/core";
import { assertModel, type SqlStatements, type Statement } from "@authtempo/core/sql";
import type { Sql, TransactionSql } from "postgres";

type Row = Record<string, unknown>;
type Conn = Sql | TransactionSql;

/** What the adapter runs. `createPostgresAdapter` passes core's statements; plan 9's compatibility storage passes its own. */
export interface PostgresAdapterOptions {
  statements: SqlStatements;
  toStorageError(model: ModelName, err: unknown): StorageError | null;
  /** The schema version check, run once per adapter. */
  ready(): Promise<void>;
}

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
  return {
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
