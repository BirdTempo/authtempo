import { checkCaptcha } from "../captcha.js";
import type { ResolvedConfig } from "../config.js";
import { safeNext } from "../http/safe-next.js";
import { ipKey } from "../limiter/ip-key.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { UserRow } from "../schema.js";
import { hookGuard } from "./hooks.js";
import { gatedSteps, type SignInChallenge, touchTrust } from "./second-factor.js";
import { endedList, sessionOpened, sessionsEnded } from "./sessions.js";
import { findOrCreateUserByEmail, normalizeEmail, signUpGuard } from "./users.js";
import { consumeVerification } from "./verification.js";

export const MAGIC_LINK_PREFIX = "ml_";
export const MAGIC_LINK_TOKEN_RE = /^ml_[A-Za-z0-9_-]{43}$/;
const PER_EMAIL = { seconds: 15 * 60, max: 5 };
const PER_IP = { seconds: 15 * 60, max: 20 };

export interface MagicLinkRequest {
  email: string;
  next?: string | undefined;
  ip: string | null;
  /** The captcha token (plan 12b). Undefined in process: no check. Null or "": the request had none. */
  captchaToken?: string | null | undefined;
}

export interface MagicLinkVerify {
  token: string;
  ip: string | null;
  userAgent: string | null;
  /** The clear `td_` token of a trusted device (plan 12c): it skips the gate. */
  trustDevice?: string | undefined;
}

/**
 * Always `ok` for a well-formed call, so a caller cannot learn whether an
 * address has an account. `rate_limited` is the one visible failure.
 * On a host that sets no client ip, every caller shares one ip budget,
 * which fails closed.
 */
export async function requestMagicLink(
  config: ResolvedConfig,
  input: MagicLinkRequest,
): Promise<Result<{ sent: true }>> {
  const email = normalizeEmail(input.email);
  if (email === null) return ok({ sent: true });
  if (!(await config.limiter.allow(`magic-link:ip:${ipKey(input.ip)}`, PER_IP)))
    return fail("rate_limited");
  // After the per-IP limit and before every per-email limit: see checkCaptcha (plan 12b).
  const captcha = await checkCaptcha(config, "magic-link-request", input.captchaToken, input.ip);
  if (captcha) return captcha;
  if (!(await config.limiter.allow(`magic-link:email:${email}`, PER_EMAIL)))
    return fail("rate_limited");
  const now = config.clock.now();
  const token = randomToken(MAGIC_LINK_PREFIX);
  const next = safeNext(input.next);
  await config.storage.create("verification", {
    id: newId(now),
    purpose: "magic-link",
    identifier: email,
    valueHash: await sha256Hex(token),
    expiresAt: new Date(now.getTime() + config.magicLink.ttlMinutes * 60_000),
    consumedAt: null,
    data: { next },
    createdAt: now,
    updatedAt: now,
    secretVersion: config.keyring.current,
  });
  const link = config.magicLink.linkBuilder(token, next);
  await config.mail.send({
    to: email,
    subject: `Sign in to ${config.appName}`,
    text: `Open this link to sign in. It is valid for ${config.magicLink.ttlMinutes} minutes.\n\n${link}\n\nIf you did not ask for it, ignore this message.`,
  });
  return ok({ sent: true });
}

/**
 * Consumes the token in one conditional update, so two clicks on the same
 * link race for one row and only one wins. Then finds or creates the user
 * and opens a session. A user with the second factor on gets a challenge in
 * place of the session, unless `totp.gate.magicLink` is false or a trust
 * token of the user comes with the request (plan 12c).
 */
export async function verifyMagicLink(
  config: ResolvedConfig,
  input: MagicLinkVerify,
): Promise<Result<{ token: string; next: string; user: UserRow } | SignInChallenge>> {
  if (!MAGIC_LINK_TOKEN_RE.test(input.token)) return fail("invalid_token");
  const now = config.clock.now();
  const consumed = await consumeVerification(config.storage, {
    purpose: "magic-link",
    valueHash: await sha256Hex(input.token),
    now,
  });
  if (!consumed.ok) return consumed;
  const row = consumed.value;
  const next = safeNext((row.data as { next?: unknown } | null)?.next);
  // A failure after this point burns the link by design. The person
  // requests a new one.
  // The session or the challenge commits with the claim in one transaction,
  // so a claimant's in-flight callback cannot keep a session the claim deleted.
  const ended = endedList(config);
  // The hook runs before the resolution's first write, for the D1 undo (see `insertSignUp` in password.ts).
  const steps = gatedSteps(
    config,
    {
      ip: input.ip,
      userAgent: input.userAgent,
      via: "magic_link",
      next,
      trustDevice: input.trustDevice,
      gate: config.totp?.gate.magicLink ?? false,
    },
    now,
  );
  const resolved = await hookGuard(async () =>
    ok(
      await findOrCreateUserByEmail(
        config.storage,
        row.identifier,
        now,
        (tx) => steps.write(tx),
        ended,
        signUpGuard(config, steps.before),
      ),
    ),
  );
  if (!resolved.ok) return resolved;
  const { user, after } = resolved.value;
  await sessionsEnded(config, ended, "claim");
  if (after.kind === "challenge") return ok({ ...after.pending, next, user });
  await touchTrust(config, steps.trustId(), now);
  await sessionOpened(config, after.session, user, "magic_link");
  return ok({ token: after.token, next, user });
}
