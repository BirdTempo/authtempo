import type { ResolvedConfig } from "../config.js";
import { fail, ok, type Result } from "../result.js";
import type { UserRow } from "../schema.js";
import type { PublicKeyCredentialRequestOptionsJSON } from "../seams/webauthn.js";
import { checkCode, consumeCode, issueCode, REQUEST_PER_EMAIL, verifyGate } from "./email-otp.js";
import { markFresh } from "./fresh.js";
import { provePasskeyOf, reauthPasskeyChallenge } from "./passkeys.js";
import { checkUserPassword } from "./password.js";
import type { ResolvedSession } from "./sessions.js";
import { proveUserFactor, secondFactorOn } from "./totp.js";
import { MAILED_CODES_PER_EMAIL_DAY } from "./verification.js";

/**
 * The re-authentication (plan 12a, spec 8.15): a proof of the person on a
 * session that exists, which makes it fresh with no new token. A password or
 * an email code is one factor, so the second-factor code follows it while
 * the factor is on. A passkey is two factors. It never reads the trust
 * cookie: a trusted device skips a sign-in's second factor, not this proof.
 */

// Per 15 minutes, for every re-authentication of one user, right or wrong
// (plan 12a). Its own key, not the sign-in's `password:ip` and
// `password:email`: a thief with a stolen session who guesses here must not
// hold the owner's sign-in at rate_limited (the rule of plan 9h for the TOTP
// setup). 10 is the sign-in's per-address budget.
export const REAUTH_PER_USER = { seconds: 900, max: 10 };
// Per 15 minutes, per user, for the mail of a re-authentication code (plan
// 12a), before the address keys of every mailed code (`otp:email`,
// `otp:email-day`). A stolen session must not fill the owner's mailbox; 3 is
// the per-address budget of a sign-in code.
export const REAUTH_MAIL_PER_USER = { seconds: 900, max: 3 };

/** The first proof, and the second-factor code after a password or an email code. */
export type ReauthProof =
  | { password: string; code?: string | undefined }
  | { emailCode: string; code?: string | undefined }
  | { passkey: unknown };

export interface ReauthInput {
  session: ResolvedSession;
  proof: ReauthProof;
  ip: string | null;
}

/** A re-authentication code to the user's address (plan 12a). Needs `emailOtp`. */
export async function requestReauthCode(
  config: ResolvedConfig,
  input: { session: ResolvedSession },
): Promise<Result<{ sent: true }>> {
  const otp = config.emailOtp;
  if (!otp) return fail("not_found");
  const { user } = input.session;
  if (!(await config.limiter.allow(`reauth-mail:user:${user.id}`, REAUTH_MAIL_PER_USER)))
    return fail("rate_limited");
  if (!(await config.limiter.allow(`otp:email:${user.email}`, REQUEST_PER_EMAIL)))
    return fail("rate_limited");
  if (!(await config.limiter.allow(`otp:email-day:${user.email}`, MAILED_CODES_PER_EMAIL_DAY)))
    return fail("rate_limited");
  const code = await issueCode(config, otp, "reauth-otp", user.email, {});
  const message = config.account.mail({
    kind: "reauth_code",
    email: user.email,
    code,
    ttlMinutes: otp.ttlMinutes,
    appName: config.appName,
  });
  // To the user's address, whatever the builder wrote.
  await config.mail.send({ ...message, to: user.email });
  return ok({ sent: true });
}

/** The options of a re-authentication by a passkey (plan 12a). Needs `passkey`. */
export function reauthPasskeyOptions(
  config: ResolvedConfig,
  input: { session: ResolvedSession; ip: string | null },
): Promise<Result<PublicKeyCredentialRequestOptionsJSON>> {
  return reauthPasskeyChallenge(config, { user: input.session.user, ip: input.ip });
}

/** A right re-authentication code, spent. The verify limits of every mailed code apply. */
async function proveReauthCode(
  config: ResolvedConfig,
  user: UserRow,
  code: string,
  ip: string | null,
): Promise<Result<true>> {
  if (!config.emailOtp) return fail("not_found");
  const gate = await verifyGate(config, { email: user.email, ip });
  if (!gate.ok) return gate;
  const now = config.clock.now();
  const checked = await checkCode(config, "reauth-otp", user.email, code, now);
  if (!checked.ok) return checked;
  const spent = await consumeCode(config.storage, checked.value, now);
  return spent.ok ? ok(true) : spent;
}

export async function reauthenticate(
  config: ResolvedConfig,
  input: ReauthInput,
): Promise<Result<{ freshUntil: Date }>> {
  const { user, session } = input.session;
  // A deployment with no password config refuses the password proof before
  // the limit counts a try. The answer is the same for every user, so it
  // tells nothing about one account.
  if ("password" in input.proof && !config.password) return fail("not_found");
  // The same rule for the other two proofs (plan 12a Task 3): the answer
  // depends on the deployment only, so the limit counts no try for it.
  if ("emailCode" in input.proof && !config.emailOtp) return fail("not_found");
  if ("passkey" in input.proof && !config.passkey) return fail("not_found");
  if (!(await config.limiter.allow(`reauth:user:${user.id}`, REAUTH_PER_USER)))
    return fail("rate_limited");
  const proof = input.proof;
  // A passkey is two factors (spec 8.15 item 2): core asks for user
  // verification, so it proves possession and the person. No factor code
  // follows it, whatever second-factor methods the user has on.
  if ("passkey" in proof) {
    const proved = await provePasskeyOf(config, { userId: user.id, response: proof.passkey });
    return proved.ok ? reauthenticated(config, user.id, session.id, "passkey") : proved;
  }
  const factorOn = await secondFactorOn(config, user.id);
  // Before any check, so a missing code costs no guess. ASVS 7.5.1 asks for
  // a full re-authentication: a password or a mailbox is one factor.
  // `code` is "an authenticator code or a backup code" (spec 8.15 item 2).
  // The email method of plan 12c is not a code here: item 12 lists it as a
  // later input. So a user whose methods are email or passkey only sends a
  // backup code after a password or an email code, or proves by a passkey.
  if (factorOn && proof.code === undefined) return fail("invalid_body");
  const proved =
    "password" in proof
      ? await checkUserPassword(config, user.id, proof.password)
      : await proveReauthCode(config, user, proof.emailCode, input.ip);
  if (!proved.ok) return proved;
  if (factorOn && proof.code !== undefined) {
    const factor = await proveUserFactor(config, user.id, proof.code);
    if (!factor.ok) return factor;
  }
  return reauthenticated(
    config,
    user.id,
    session.id,
    "password" in proof ? "password" : "email_otp",
  );
}

/** Marks the session fresh, then emits the event `reauth` of the first proof (plan 12h Task 5). */
async function reauthenticated(
  config: ResolvedConfig,
  userId: string,
  sessionId: string,
  method: "password" | "email_otp" | "passkey",
): Promise<Result<{ freshUntil: Date }>> {
  const fresh = await markFresh(config, sessionId);
  if (fresh.ok) config.observe.emit({ name: "reauth", method, outcome: "success", userId });
  return fresh;
}
