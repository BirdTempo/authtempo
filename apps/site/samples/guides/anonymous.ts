import { createAuth, type LimiterPort, type MailPort, type StorageAdapter } from "@authtempo/core";

/** The app's own data: here, the cart of each user id. */
export type Carts = Map<string, string[]>;

/**
 * The link hook body: move the guest's cart into the account. Move data only
 * on a verified proof. An unverified proof can be a claim of an address by
 * someone else, and the real owner would get the data.
 */
export function moveGuestCart(carts: Carts) {
  return (e: {
    anonymousUser: { id: string };
    user: { id: string };
    proof: "verified" | "unverified";
  }): void => {
    const { anonymousUser, user, proof } = e;
    if (proof !== "verified") return;
    const cart = carts.get(anonymousUser.id) ?? [];
    carts.set(user.id, [...(carts.get(user.id) ?? []), ...cart]);
    carts.delete(anonymousUser.id);
  };
}

/**
 * A guest session first, and the guest's cart moves at the first real
 * sign-in. Pass the limiter of your D1, Postgres, or MySQL adapter: the
 * daily cap counts per deployment. Only a test passes "isolate-for-tests",
 * and its cap then counts per isolate.
 */
export function createGuestAuth(
  deps: {
    storage: StorageAdapter;
    mail: MailPort;
    secret: string;
    limiter: LimiterPort | "isolate-for-tests";
  },
  carts: Carts = new Map(),
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
    magicLink: {},
    anonymous: {
      // The sweep deletes a guest with no live session after this many days.
      ttlDays: 30,
      // Tests only. With a limiter that counts per isolate, createAuth refuses anonymous.
      ...(forTests ? { isolateLimiter: "allow" as const } : {}),
    },
    hooks: {
      anonymous: { afterLink: moveGuestCart(carts) },
    },
  });
}
