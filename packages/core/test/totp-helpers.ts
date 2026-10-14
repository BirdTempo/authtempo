import type { AuthConfig } from "../src/config.js";
import { passwordSignIn } from "../src/engine/password.js";
import { type ResolvedSession, resolveSession } from "../src/engine/sessions.js";
import { enableTotp, setupTotp } from "../src/engine/totp.js";
import { base32Decode, totpCode } from "../src/primitives/totp.js";
import { makeAuth } from "./helpers.js";
import { FAST, signUpAndVerify } from "./password-helpers.js";

export const EMAIL = "ada@example.com";
export const PASSWORD = "correct horse battery";
export type Auth = ReturnType<typeof makeAuth>;

/** The engine view with password sign-in and the second factor on (plan 9f). */
export function totpAuth(extra: Partial<AuthConfig> = {}): Auth {
  // The detailed answer of plan 8 (a session and the user at sign-up), which
  // these tests read. The uniform answer has its own tests (plan 12b).
  return makeAuth({ password: { hash: FAST, uniformSignUp: false }, ...extra });
}

/** A 6-digit code that is not `code`. */
export const wrongFor = (code: string) => (code === "000000" ? "111111" : "000000");

/** The code that an authenticator app shows now, by the injected clock. */
export const codeNow = (auth: Auth, secret: Uint8Array) => totpCode(secret, auth.clock.now());

/**
 * A verified user with a password, and the session and token of a password
 * sign-in. A second call for the same address signs in again: a second device.
 */
export async function verifiedSession(
  auth: Auth,
  email = EMAIL,
  ip = "9.9.9.9",
): Promise<ResolvedSession & { token: string }> {
  if (!(await auth.storage.findOne("user", [{ field: "email", op: "eq", value: email }])))
    await signUpAndVerify(auth, email, PASSWORD);
  const s = await passwordSignIn(auth.config, { email, password: PASSWORD, ip, userAgent: "ua" });
  if (!s.ok || !("token" in s.value)) throw new Error("the sign-in opened no session");
  const resolved = await resolveSession(auth.config, s.value.token);
  if (!resolved) throw new Error("no session");
  return { ...resolved, token: s.value.token };
}

/**
 * A user with the factor on: the setup, then the enable with the current
 * code. The clock then moves one step on, so the next code is of a new step.
 */
export async function enrolled(auth: Auth, email = EMAIL) {
  const session = await verifiedSession(auth, email);
  const setup = await setupTotp(auth.config, { userId: session.user.id, password: PASSWORD });
  if (!setup.ok) throw new Error(setup.code);
  const secret = base32Decode(setup.value.secret);
  const enabled = await enableTotp(auth.config, { session, code: await codeNow(auth, secret) });
  if (!enabled.ok) throw new Error(enabled.code);
  auth.clock.advance(30_000);
  return { session, secret, backupCodes: setup.value.backupCodes, user: session.user };
}
