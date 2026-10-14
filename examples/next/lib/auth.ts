import { type Auth, createAuth, createMemoryAdapter, type MailPort } from "@authtempo/core";

/**
 * Your mail transport. Core calls `send` once per mail. Replace the body with
 * a call to your mail provider. Until then a sign-in request answers 500.
 */
export const mail: MailPort = {
  async send() {
    throw new Error("my-app: no mail transport; replace mail.send in lib/auth.ts");
  },
};

/**
 * The auth instance of this app. Warning: the memory adapter keeps rows in
 * this process only, and they go at a restart. Use the D1 or the Postgres
 * adapter in production (the getting started tutorials show both).
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

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`my-app: set ${name}`);
  return value;
}

let current: Auth | null = null;

/** The app's one auth instance, made at the first request from BASE_URL and AUTH_SECRET. A build reads neither. */
export function getAuth(): Auth {
  current ??= createAppAuth({
    baseURL: required("BASE_URL"),
    secret: required("AUTH_SECRET"),
    mail,
  });
  return current;
}
