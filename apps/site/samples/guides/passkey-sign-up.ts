import { createAuth, type LimiterPort, type MailPort, type StorageAdapter } from "@authtempo/core";

/**
 * Sign-up with a passkey and a name. The new user has no address. Pass the
 * limiter of your D1, Postgres, or MySQL adapter: the daily cap counts per
 * deployment. With no limiter, core counts in memory per isolate, which is
 * for tests and local development only.
 */
export function createPasskeySignUpAuth(
  deps: { storage: StorageAdapter; mail: MailPort; secret: string },
  limiter?: LimiterPort,
) {
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    ...(limiter ? { limiter } : {}),
    passkey: {
      rpID: "example.com",
      rpName: "Example",
      origins: ["https://app.example.com"],
      signUp: {
        // The sign-ups of the whole deployment per 24 hours.
        dailyCap: 1000,
        ...(limiter ? {} : { isolateLimiter: "allow" as const }),
      },
    },
  });
}
