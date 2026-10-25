import { betterSqlite3 } from "@authtempo/adapter-sqlite/better-sqlite3";
import { createPbkdf2PasswordHash } from "@authtempo/core";
import Database from "better-sqlite3";
import { betterAuthPasswordHash } from "../src/hash.js";
import { betterAuth } from "../src/server/better-auth.js";
import { betterAuthSchemaStorage, type SqliteSchemaStorage } from "../src/storage/index.js";
import type { BetterAuthOptions, CompatDatabase, EmailCallbackData } from "../src/types.js";
import { BETTER_AUTH_SQLITE } from "./fixtures.js";

export const BASE = "https://api.example.com";
export const PASSWORD = "correct horse battery staple";
export const SECRET = "0123456789abcdef0123456789abcdef";
export const fastHash = betterAuthPasswordHash({
  pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
});

/**
 * Better Auth 1.7.2's own SQLite tables with their foreign keys, in memory,
 * after the compat migrations (plan 12i Task 16). Each test reads the rows
 * as Better Auth stores them through `row`.
 */
export async function betterAuthTables(): Promise<{
  db: Database.Database;
  database: SqliteSchemaStorage;
  row: (sql: string, ...params: unknown[]) => Record<string, unknown> | undefined;
  rows: (sql: string, ...params: unknown[]) => Record<string, unknown>[];
}> {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(BETTER_AUTH_SQLITE);
  const database = betterAuthSchemaStorage({ dialect: "sqlite", driver: betterSqlite3(db) });
  await database.migrate();
  const row = (sql: string, ...params: unknown[]) =>
    db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  const rows = (sql: string, ...params: unknown[]) =>
    db.prepare(sql).all(...params) as Record<string, unknown>[];
  return { db, database, row, rows };
}

/** The cookies of one browser: each set-cookie of an answer replaces or removes one. */
export class Jar {
  readonly cookies = new Map<string, string>();
  take(res: Response): Response {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(";")[0] ?? "";
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (value === "" || /max-age=0(;|$)/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** Options on the Better Auth tables with passwords on; `extra` adds or replaces keys. */
export function signInOptions(
  database: CompatDatabase,
  extra: Partial<BetterAuthOptions> = {},
  verifies: EmailCallbackData[] = [],
): BetterAuthOptions {
  return {
    baseURL: BASE,
    secret: SECRET,
    database,
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    emailVerification: {
      sendVerificationEmail: async (d) => {
        verifies.push(d);
      },
    },
    authtempo: { passwordHash: fastHash },
    ...extra,
  };
}

/** A handler request in one browser. A body makes it a POST. */
export function browser(handler: (r: Request) => Promise<Response>, jar = new Jar()) {
  const send = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    jar.take(
      await handler(
        new Request(`${BASE}/api/auth${path}`, {
          method,
          headers: {
            origin: BASE,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            ...(jar.cookies.size > 0 ? { cookie: jar.header() } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
      ),
    );
  return { jar, send };
}

export const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

export { betterAuth };
