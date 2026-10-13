import { createPostgresAdapter, createPostgresLimiter } from "@authtempo/adapter-postgres";
import { createAuth, type MailPort } from "@authtempo/core";
import type { Sql } from "postgres";

/**
 * The storage and the owned limiter on one Postgres client. Every process and
 * every isolate shares the counts in `ta_limit`. The default limiter counts in
 * memory, per isolate, and is for tests only.
 */
export function authOnPostgres(sql: Sql, mail: MailPort, secret: string) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret,
    mail,
    storage: createPostgresAdapter(sql),
    limiter: createPostgresLimiter(sql),
  });
}
