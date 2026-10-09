import type { AuthConfig, MailMessage, PasswordConfig } from "../src/config.js";
import { resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { createPbkdf2PasswordHash } from "../src/seams/password-hash.js";
import { APP_ORIGIN, BASE_URL, makeAuth } from "./helpers.js";

/** A low cost, so that a test runs fast. Production uses `PBKDF2_ITERATIONS`. */
export const FAST = createPbkdf2PasswordHash({ iterations: 1000 });

/** The engine view: a resolved config with password sign-in on and the fast hash. */
export function pwAuth(password: PasswordConfig = {}) {
  return makeAuth({ password: { hash: FAST, ...password } });
}

/** A mail the fake mail port recorded, with the token its link carries, or null. */
export type CapturedMail = MailMessage & { token: string | null };

function linkToken(text: string): string | null {
  const m = /token=([A-Za-z0-9_%-]+)/.exec(text);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

/**
 * The HTTP view: an `Auth` and a resolved config on one storage, one
 * clock, one limiter, and one mail list. A test can call a route and then
 * read the rows and the mailed tokens. `undefined` turns password sign-in off.
 */
export function pwHandle(password: PasswordConfig | undefined) {
  const base = makeAuth();
  const mails: CapturedMail[] = [];
  const input: AuthConfig = {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: base.storage,
    mail: {
      send: async (m) => {
        mails.push({ ...m, token: linkToken(m.text) });
      },
    },
    clock: base.clock,
    // One limiter for the route and the engine view, so a limit counts both.
    limiter: createMemoryLimiter(base.clock),
    ...(password ? { password } : {}),
  };
  return { auth: createAuth(input), storage: base.storage, mails, config: resolveConfig(input) };
}
