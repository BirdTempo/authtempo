import { createPostgresAdapter } from "@authtempo/adapter-postgres";
import { betterAuthSchemaStorage } from "@authtempo/compat-better-auth";
import type { StorageAdapter } from "@authtempo/core";
import postgres, { type Sql } from "postgres";

/**
 * The Postgres seam of the CLI (spec 19): the one module that names
 * postgres.js. A command asks it for storage, and never sees the driver.
 */
export interface PostgresSeam {
  /** Core's tables (`@authtempo/adapter-postgres`). */
  coreStorage(): StorageAdapter;
  /** The Better Auth 1.7 tables (`@authtempo/compat-better-auth`). */
  compatStorage(): StorageAdapter;
  /**
   * One round trip. postgres.js connects on the first query, so without it a
   * refused connection fails inside the import and reads as an import error
   * with "records before it may be written", when nothing was written.
   */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function openPostgres(url: string, max: number): PostgresSeam {
  const sql: Sql = postgres(url, { max, onnotice: () => {} });
  return {
    coreStorage: () => createPostgresAdapter(sql),
    compatStorage: () => betterAuthSchemaStorage({ dialect: "postgres", sql }).storage,
    async ping() {
      await sql`SELECT 1`;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}
