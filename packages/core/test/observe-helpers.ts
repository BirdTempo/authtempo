import type { AuthConfig, MailMessage } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import type { AuthEvent } from "../src/observe/port.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { APP_ORIGIN, BASE_URL } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { APPLE, fakeFetch, fakeJwt, GOOGLE } from "./social-helpers.js";

/**
 * A storage that stops: after `stop()`, each call throws, as a store whose
 * connection is gone. The calls before it reach a real memory adapter.
 */
function stoppable(): { storage: StorageAdapter; stop: () => void } {
  const real = createMemoryAdapter();
  let stopped = false;
  const storage = new Proxy(real, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (stopped) throw new Error("store stopped");
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { storage, stop: () => (stopped = true) };
}

/**
 * One core instance with a recording sink (plan 12h Task 4): the password,
 * email code, passkey, handoff, and social routes, a fake clock, and the
 * mail it sent. `events()` flushes and answers every event so far.
 */
export function observed(
  over: Partial<AuthConfig> = {},
  observe: Partial<AuthConfig["observe"]> = {},
) {
  let current = new Date("2026-01-01T00:00:00.000Z");
  const clock = {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
  const mail: MailMessage[] = [];
  const batches: AuthEvent[][] = [];
  const { storage, stop } = stoppable();
  // The provider's token endpoint is down: a callback with a valid state reaches it.
  const { fetchFn } = fakeFetch(() => new Response("down", { status: 502 }));
  const auth = createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage,
    mail: {
      send: async (m) => {
        // A mail send takes 25 ms of the fake clock, so a request has a duration.
        clock.advance(25);
        mail.push(m);
      },
    },
    clock,
    password: { hash: FAST },
    emailOtp: {},
    passkey: { rpID: "api.example.com", rpName: "Example", origins: [BASE_URL] },
    handoff: { schemes: ["example://"] },
    social: { google: GOOGLE, apple: APPLE, fetch: fetchFn },
    jwt: fakeJwt({}),
    observe: { sink: { write: (b) => void batches.push([...b]) }, ...observe },
    ...over,
  });
  async function events(): Promise<AuthEvent[]> {
    await auth.observe.flush();
    return batches.flat();
  }
  return { auth, clock, mail, storage, stop, events };
}

/** A form post from the app origin. */
export function formPost(path: string, fields: Record<string, string>): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL },
    body: new URLSearchParams(fields).toString(),
  });
}
