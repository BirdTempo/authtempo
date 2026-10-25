import {
  createAuth,
  type LimiterPort,
  type MailPort,
  type SmsPort,
  type StorageAdapter,
} from "@authtempo/core";

/** A placeholder port that sends nothing. Write the port of your SMS supplier. */
const NO_SMS: SmsPort = { send: async () => "unavailable" };

/**
 * Sign-in by a code over SMS. Core makes, keys, and counts each code. The
 * port of your SMS supplier only sends text. Pass the limiter of your D1,
 * Postgres, or MySQL adapter: the daily cap counts per deployment. Only a
 * test passes "isolate-for-tests", and its cap then counts per isolate.
 */
export function createPhoneAuth(
  deps: {
    storage: StorageAdapter;
    mail: MailPort;
    secret: string;
    limiter: LimiterPort | "isolate-for-tests";
  },
  sms: SmsPort = NO_SMS,
) {
  const forTests = deps.limiter === "isolate-for-tests";
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    ...(deps.limiter === "isolate-for-tests" ? {} : { limiter: deps.limiter }),
    phone: {
      sms,
      // Required, with no default: each country prefix that may get an SMS.
      regions: ["+44", "+353"],
      // A code to an unknown number makes a user with no address.
      signUp: true,
      // The SMS of the whole deployment per 24 hours. 1000 is the default.
      dailyCap: 1000,
      // Tests only. With a limiter that counts per isolate, createAuth refuses phone.
      ...(forTests ? { isolateLimiter: "allow" as const } : {}),
    },
  });
}
