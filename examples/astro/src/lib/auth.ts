import { type Auth, createAuth, createMemoryAdapter, type MailPort } from "@authtempo/core";

let lastLink: string | null = null;

/** TEST_MODE only: the proof reads the last mailed link. A deploy never sets TEST_MODE. */
export function testMode(): boolean {
  return process.env.TEST_MODE === "1";
}

export function lastMailedLink(): string | null {
  return testMode() ? lastLink : null;
}

/**
 * Your mail transport. Replace the body with a call to your mail provider.
 * Until then a sign-in request answers 500, except in TEST_MODE.
 */
const mail: MailPort = {
  async send(message) {
    if (!testMode())
      throw new Error("my-app: no mail transport; replace mail.send in src/lib/auth.ts");
    lastLink = /https?:\/\/\S+/.exec(message.text)?.[0] ?? null;
  },
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`my-app: set ${name}`);
  return value;
}

let current: Auth | null = null;

/**
 * The app's one auth instance, made at the first request. Warning: the memory
 * adapter keeps rows in this process only. Use the D1 or the Postgres adapter
 * in production.
 */
export function getAuth(): Auth {
  current ??= createAuth({
    baseURL: required("BASE_URL"),
    secret: required("AUTH_SECRET"),
    trustedOrigins: [required("BASE_URL")],
    storage: createMemoryAdapter(),
    mail,
  });
  return current;
}
