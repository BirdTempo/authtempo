import type { AuthConfig, MailMessage, PasswordConfig } from "../src/config.js";
import { resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import {
  type PasswordSession,
  type PasswordSignInResult,
  type PasswordSignUpResult,
  passwordSignUp,
  verifyPasswordEmail,
} from "../src/engine/password.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import type { Result } from "../src/result.js";
import type { PasswordRow } from "../src/schema.js";
import { createPbkdf2PasswordHash } from "../src/seams/password-hash.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { APP_ORIGIN, BASE_URL, makeAuth, tokenFromMail } from "./helpers.js";

/** A low cost, so that a test runs fast. Production uses `PBKDF2_ITERATIONS`. */
export const FAST = createPbkdf2PasswordHash({ iterations: 1000 });

/** The engine view: a resolved config with password sign-in on and the fast hash. */
export function pwAuth(password: PasswordConfig = {}) {
  // The detailed answer of plan 8 (a session at sign-up, 409 for a known
  // address), which these tests pin. The default answer has its own tests
  // in uniform-sign-up.test.ts (plan 12b).
  return makeAuth({ password: { hash: FAST, uniformSignUp: false, ...password } });
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
export function pwHandle(password: PasswordConfig | undefined, extra: Partial<AuthConfig> = {}) {
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
    // The detailed answer of plan 8 (a session at sign-up, 409 for a known
    // address), which these tests pin. The default answer has its own tests
    // in uniform-sign-up.test.ts (plan 12b).
    ...(password ? { password: { uniformSignUp: false, ...password } } : {}),
    ...extra,
  };
  return {
    auth: createAuth(input),
    storage: base.storage,
    mails,
    config: resolveConfig(input),
    // The injected clock, so a test can move to the next 30-second step (plan 9f).
    clock: base.clock,
  };
}

/**
 * A reachable verified user with a password: the sign-up, then the real
 * verify link from the mail. Returns the password row the link kept.
 */
export async function signUpAndVerify(
  auth: ReturnType<typeof makeAuth>,
  email = "ada@example.com",
  password = "correct horse battery",
): Promise<PasswordRow> {
  const up = await passwordSignUp(auth.config, { email, password, ip: null, userAgent: null });
  if (!up.ok) throw new Error(up.code);
  const mail = auth.mail.findLast((m) => m.to === email && m.subject.startsWith("Confirm"));
  const v = await verifyPasswordEmail(auth.config, {
    token: tokenFromMail(mail?.text ?? ""),
    ip: null,
    userAgent: null,
  });
  if (!v.ok || !v.value.signedIn) throw new Error("the verify link did not sign in");
  // By the address: the uniform answer (plan 12b) carries no user.
  const user = await auth.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  const row = await auth.storage.findOne("password", [
    { field: "userId", op: "eq", value: user?.id ?? "" },
  ]);
  if (!row) throw new Error("no password row");
  return row;
}

/**
 * The answer of a password sign-in that a test expects to open a session.
 * Since plan 9f a sign-in can answer a second-factor challenge in place of
 * the session. A test that runs with no factor on wraps its sign-in in this
 * call: a challenge throws, so the test cannot pass on the wrong answer.
 */
export async function sessionOnly(
  r: Promise<Result<PasswordSignInResult>>,
): Promise<Result<PasswordSession>> {
  const v = await r;
  if (v.ok && !("token" in v.value))
    throw new Error("the sign-in answered a second-factor challenge");
  return v as Result<PasswordSession>;
}

/**
 * The session of a sign-up answer. Since plan 12b a sign-up with
 * `password.requireVerified` on answers no session. A test that expects a
 * session reads it through this call: a pending answer throws.
 */
export function upSession(v: PasswordSignUpResult): PasswordSession {
  if (!("session" in v)) throw new Error("the sign-up answered no session");
  return v;
}

/**
 * Records each write of the next transaction as `op:model`, in order, so a
 * test can read the statement order of one flow.
 */
export function recordNextTransaction(storage: StorageAdapter): string[] {
  const writes: string[] = [];
  const original = storage.transaction.bind(storage);
  let armed = true;
  storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> => {
    if (!armed) return original(fn);
    armed = false;
    return original((tx) =>
      fn({
        ...tx,
        create: (m, d) => {
          writes.push(`create:${m}`);
          return tx.create(m, d);
        },
        update: (m, w, d) => {
          writes.push(`update:${m}`);
          return tx.update(m, w, d);
        },
        delete: (m, w) => {
          writes.push(`delete:${m}`);
          return tx.delete(m, w);
        },
      }),
    );
  };
  return writes;
}
