import { type Auth, createAuth, createMemoryAdapter, type MailPort } from "@authtempo/core";

/**
 * The auth instance of the app. Warning: the memory adapter keeps rows in this
 * process only. Use the D1 or the Postgres adapter in production.
 */
export function createAppAuth(input: { baseURL: string; secret: string; mail: MailPort }): Auth {
  return createAuth({
    baseURL: input.baseURL,
    secret: input.secret,
    trustedOrigins: [input.baseURL],
    storage: createMemoryAdapter(),
    mail: input.mail,
  });
}
