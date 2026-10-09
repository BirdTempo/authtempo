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

const TEXT_OID = 25;

/**
 * The builder sends json as serialized text and marks its placeholder `$n::jsonb`.
 * postgres.js learns that the parameter is jsonb and would JSON.stringify the
 * string a second time, so a json column would hold a JSON string, not an object.
 * Send those parameters as explicit text: the server then casts the text to jsonb.
 */
function bindParams(conn: Conn, s: Statement): never[] {
  const jsonIndexes = new Set([...s.sql.matchAll(/\$(\d+)::jsonb/g)].map((m) => Number(m[1]) - 1));
  return s.params.map((p, i) =>
    jsonIndexes.has(i) && typeof p === "string" ? conn.typed(p, TEXT_OID) : p,
  ) as never[];
}

async function query(conn: Conn, s: Statement): Promise<{ rows: Row[]; count: number }> {
  const res = await conn.unsafe<Row[]>(s.sql, bindParams(conn, s));
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
