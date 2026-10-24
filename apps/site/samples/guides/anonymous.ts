import { createAuth, type LimiterPort, type MailPort, type StorageAdapter } from "@authtempo/core";

/** The app's own data: here, the cart of each user id. */
export type Carts = Map<string, string[]>;

/**
 * A guest session first, and the guest's cart moves at the first real
 * sign-in. Pass the limiter of your D1, Postgres, or MySQL adapter: the
 * daily cap counts per deployment. With no limiter, core counts in memory
 * per isolate, for tests and local development only.
 */
export function createGuestAuth(
  deps: { storage: StorageAdapter; mail: MailPort; secret: string },
  carts: Carts = new Map(),
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
    magicLink: {},
    anonymous: {
      // The sweep deletes a guest with no live session after this many days.
      ttlDays: 30,
      ...(limiter ? {} : { isolateLimiter: "allow" as const }),
    },
    hooks: {
      anonymous: {
        afterLink({ anonymousUser, user, proof }) {
          // Move data only on a verified proof. An unverified proof can be a claim
          // of an address by someone else, and the real owner would get the data.
          if (proof !== "verified") return;
          const cart = carts.get(anonymousUser.id) ?? [];
          carts.set(user.id, [...(carts.get(user.id) ?? []), ...cart]);
          carts.delete(anonymousUser.id);
        },
      },
    },
  });
}
