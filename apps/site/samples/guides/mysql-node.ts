import {
  applyMysqlMigrations,
  createMysqlAdapter,
  createMysqlLimiter,
} from "@authtempo/adapter-mysql";
import { createAuth, type MailPort } from "@authtempo/core";
import { createPool, type Pool } from "mysql2/promise";

/**
 * A pool for a MySQL server on another host. mysql2 checks the certificate
 * chain with `rejectUnauthorized`, and the host name only with
 * `verifyIdentity` (mysql2 3.24.5, read 2026-10-21).
 */
export function remotePool(uri: string): Pool {
  return createPool({ uri, ssl: { rejectUnauthorized: true, verifyIdentity: true } });
}

/**
 * authtempo on MySQL 8.4 or later through a mysql2 pool that the app opens.
 * The storage and the owned limiter use one pool. The first call of the
 * adapter runs its four checks at start.
 */
export async function authOnMysql(pool: Pool, mail: MailPort, secret: string) {
  await applyMysqlMigrations(pool);
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret,
    mail,
    storage: createMysqlAdapter(pool),
    limiter: createMysqlLimiter(pool),
  });
}
