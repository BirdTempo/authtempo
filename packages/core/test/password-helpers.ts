import type { AuthConfig, MailMessage, PasswordConfig } from "../src/config.js";
import { resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { passwordSignUp, verifyPasswordEmail } from "../src/engine/password.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import type { PasswordRow } from "../src/schema.js";
import { createPbkdf2PasswordHash } from "../src/seams/password-hash.js";
import { APP_ORIGIN, BASE_URL, makeAuth, tokenFromMail } from "./helpers.js";

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
  const row = await auth.storage.findOne("password", [
    { field: "userId", op: "eq", value: up.value.user.id },
  ]);
  if (!row) throw new Error("no password row");
  return row;
}
