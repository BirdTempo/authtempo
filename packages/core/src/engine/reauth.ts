import type { ResolvedConfig } from "../config.js";
import { fail, type Result } from "../result.js";
import { markFresh } from "./fresh.js";
import { checkUserPassword } from "./password.js";
import type { ResolvedSession } from "./sessions.js";
import { proveUserFactor, secondFactorOn } from "./totp.js";

/**
 * The re-authentication (plan 12a, spec 8.15): a proof of the person on a
 * session that exists, which makes it fresh with no new token. It never
 * reads the trust cookie: a trusted device skips a sign-in's second factor,
 * not this proof.
 */

// Per 15 minutes, for every re-authentication of one user, right or wrong
// (plan 12a). Its own key, not the sign-in's `password:ip` and
// `password:email`: a thief with a stolen session who guesses here must not
// hold the owner's sign-in at rate_limited (the rule of plan 9h for the TOTP
// setup). 10 is the sign-in's per-address budget.
export const REAUTH_PER_USER = { seconds: 900, max: 10 };

/** The first proof, and the second-factor code when the factor is on. */
export type ReauthProof = { password: string; code?: string | undefined };

export interface ReauthInput {
  session: ResolvedSession;
  proof: ReauthProof;
  ip: string | null;
}

export async function reauthenticate(
  config: ResolvedConfig,
  input: ReauthInput,
): Promise<Result<{ freshUntil: Date }>> {
  const { user, session } = input.session;
  if (!(await config.limiter.allow(`reauth:user:${user.id}`, REAUTH_PER_USER)))
    return fail("rate_limited");
  const factorOn = await secondFactorOn(config, user.id);
  // Before any check, so a missing code costs no password guess. ASVS 7.5.1
  // asks for a full re-authentication: the password alone is one factor.
  if (factorOn && input.proof.code === undefined) return fail("invalid_body");
  const proved = await checkUserPassword(config, user.id, input.proof.password);
  if (!proved.ok) return proved;
  if (factorOn && input.proof.code !== undefined) {
    const factor = await proveUserFactor(config, user.id, input.proof.code);
    if (!factor.ok) return factor;
  }
  return markFresh(config, session.id);
}
