import type { ResolvedConfig } from "../config.js";
import { safeNext } from "../http/safe-next.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { UserRow } from "../schema.js";
import { hookGuard } from "./hooks.js";
import { endedList, sessionOpened, sessionSteps, sessionsEnded } from "./sessions.js";
import { findOrCreateUserByEmail, normalizeEmail } from "./users.js";
import { consumeVerification } from "./verification.js";

export const MAGIC_LINK_PREFIX = "ml_";
export const MAGIC_LINK_TOKEN_RE = /^ml_[A-Za-z0-9_-]{43}$/;
const PER_EMAIL = { seconds: 15 * 60, max: 5 };
const PER_IP = { seconds: 15 * 60, max: 20 };

export interface MagicLinkRequest {
  email: string;
  next?: string | undefined;
  ip: string | null;
}

export interface MagicLinkVerify {
  token: string;
  ip: string | null;
  userAgent: string | null;
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
  if (!(await config.limiter.allow(`magic-link:ip:${input.ip ?? "unknown"}`, PER_IP)))
    return fail("rate_limited");
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
 * and opens a session.
 */
export async function verifyMagicLink(
  config: ResolvedConfig,
  input: MagicLinkVerify,
): Promise<Result<{ token: string; next: string; user: UserRow }>> {
  if (!MAGIC_LINK_TOKEN_RE.test(input.token)) return fail("invalid_token");
  const now = config.clock.now();
  const consumed = await consumeVerification(config.storage, {
    purpose: "magic-link",
    valueHash: await sha256Hex(input.token),
    now,
  });
  if (!consumed.ok) return consumed;
  const row = consumed.value;
  // A failure after this point burns the link by design. The person
  // requests a new one.
  // The session commits with the claim in one transaction, so a claimant's
  // in-flight callback cannot keep a session the claim deleted.
  const ended = endedList(config);
  // The hook runs before the resolution's first write, for the D1 undo (see `insertSignUp` in password.ts).
  const steps = sessionSteps(config, {
    ip: input.ip,
    userAgent: input.userAgent,
    via: "magic_link",
  });
  const resolved = await hookGuard(async () =>
    ok(
      await findOrCreateUserByEmail(
        config.storage,
        row.identifier,
        now,
        (tx) => steps.write(tx),
        ended,
        steps.before,
      ),
    ),
  );
  if (!resolved.ok) return resolved;
  const { user, after } = resolved.value;
  await sessionsEnded(config, ended, "claim");
  await sessionOpened(config, after.session, user, "magic_link");
  const next = safeNext((row.data as { next?: unknown } | null)?.next);
  return ok({ token: after.token, next, user });
}
