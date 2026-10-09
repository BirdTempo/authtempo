import type { StorageAdapter } from "@tempo-auth/core";
import {
  assertModel,
  decodeRow,
  deleteStatement,
  insertStatement,
  POSTGRES,
  type Statement,
  selectStatement,
  updateStatement,
} from "@tempo-auth/core/sql";
import type { Sql, TransactionSql } from "postgres";
import { toStorageError } from "./errors.js";

type Row = Record<string, unknown>;
type Conn = Sql | TransactionSql;

interface Ctx {
  conn: Conn;
  inTransaction: boolean;
  ready: () => Promise<void>;
}

async function query(conn: Conn, s: Statement): Promise<{ rows: Row[]; count: number }> {
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
        await query(ctx.conn, insertStatement(POSTGRES, model, data));
      } catch (e) {
        throw toStorageError(model, e) ?? e;
      }
      return structuredClone(data);
    },
    async findOne(model, where) {
      await ctx.ready();
      const s = selectStatement(POSTGRES, model, where, { limit: 1 });
      if (!s) return null;
      const { rows } = await query(ctx.conn, s);
      return rows[0] ? decodeRow(POSTGRES, model, rows[0]) : null;
    },
    async findMany(model, where, opts) {
      await ctx.ready();
      const s = selectStatement(POSTGRES, model, where, opts);
      if (!s) return [];
      return (await query(ctx.conn, s)).rows.map((r) => decodeRow(POSTGRES, model, r));
    },
    async update(model, where, data) {
      await ctx.ready();
      const s = updateStatement(POSTGRES, model, where, data);
      if (!s) return 0;
      try {
        return (await query(ctx.conn, s)).count;
      } catch (e) {
        throw toStorageError(model, e) ?? e;
      }
    },
    async delete(model, where) {
      await ctx.ready();
      const s = deleteStatement(POSTGRES, model, where);
      if (!s) return 0;
      return (await query(ctx.conn, s)).count;
    },
    async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
      await ctx.ready();
      if (ctx.inTransaction) {
        // A nested transaction is a savepoint on the same connection.
        return savepoint(ctx.conn as TransactionSql, (sp) =>
          fn(adapterOn({ conn: sp, inTransaction: true, ready: ctx.ready })),
        );
      }
      return begin(ctx.conn as Sql, (tx) =>
        fn(adapterOn({ conn: tx, inTransaction: true, ready: ctx.ready })),
      );
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

export function createPostgresAdapterWith(sql: Sql, ready: () => Promise<void>): StorageAdapter {
  return adapterOn({ conn: sql, inTransaction: false, ready });
}
