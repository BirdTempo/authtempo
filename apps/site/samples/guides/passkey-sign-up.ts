import { createAuth, type LimiterPort, type MailPort, type StorageAdapter } from "@authtempo/core";

/**
 * Sign-up with a passkey and a name. The new user has no address. Pass the
 * limiter of your D1, Postgres, or MySQL adapter: the daily cap counts per
 * deployment. Only a test passes "isolate-for-tests", and its cap then
 * counts per isolate.
 */
export function createPasskeySignUpAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
  limiter: LimiterPort | "isolate-for-tests";
}) {
  const forTests = deps.limiter === "isolate-for-tests";
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    ...(deps.limiter === "isolate-for-tests" ? {} : { limiter: deps.limiter }),
    passkey: {
      rpID: "example.com",
      rpName: "Example",
      origins: ["https://app.example.com"],
      signUp: {
        // The sign-ups of the whole deployment per 24 hours.
        dailyCap: 1000,
        // Tests only. With a limiter that counts per isolate, createAuth refuses this.
        ...(forTests ? { isolateLimiter: "allow" as const } : {}),
      },
    },
  });
}
