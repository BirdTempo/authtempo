import type { ResolvedConfig } from "../config.js";
import { safeNext } from "../http/safe-next.js";
import { randomToken, sha256Hex } from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { UserRow } from "../schema.js";
import { createSession } from "./sessions.js";
import { findOrCreateUserByEmail, normalizeEmail } from "./users.js";

export const MAGIC_LINK_PREFIX = "ml_";
const TOKEN_RE = /^ml_[A-Za-z0-9_-]{43}$/;
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
    subject: "Your sign-in link",
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
  if (!TOKEN_RE.test(input.token)) return fail("invalid_token");
  const now = config.clock.now();
  const valueHash = await sha256Hex(input.token);
  const row = await config.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: valueHash },
    { field: "purpose", op: "eq", value: "magic-link" },
  ]);
  if (!row) return fail("invalid_token");
  const consumed = await config.storage.update(
    "verification",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "consumedAt", op: "eq", value: null },
      { field: "expiresAt", op: "gt", value: now },
    ],
    { consumedAt: now, updatedAt: now },
  );
  if (consumed !== 1) return fail("invalid_token");
  const { user } = await findOrCreateUserByEmail(config.storage, row.identifier, now);
  const { token } = await createSession(config, {
    userId: user.id,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  const next = safeNext((row.data as { next?: unknown } | null)?.next);
  return ok({ token, next, user });
}
