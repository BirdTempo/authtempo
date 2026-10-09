import type { ResolvedConfig } from "../config.js";
import { safeNext } from "../http/safe-next.js";
import {
  constantTimeEqual,
  randomToken,
  sha256Base64Url,
  sha256Hex,
} from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { SessionRow, UserRow, VerificationRow } from "../schema.js";
import { createSession } from "./sessions.js";

export const HANDOFF_ID_PREFIX = "hs_";
export const HANDOFF_CODE_PREFIX = "hc_";
const ID_RE = /^hs_[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^hc_[A-Za-z0-9_-]{43}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const START_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 2 * 60_000;
const START_ID = "start";
const START_LIMIT = { seconds: 15 * 60, max: 30 };
const REDEEM_LIMIT = { seconds: 15 * 60, max: 20 };

export interface HandoffStart {
  /** PKCE S256 challenge, base64url of SHA-256 of the app's verifier. */
  challenge: string;
  /** `<scheme>auth` for a configured scheme, or a URL the dev pattern admits. */
  redirect: string;
  next?: string | undefined;
  ip: string | null;
}

interface StartData {
  challenge: string;
  redirect: string;
  next: string;
}

interface CodeData {
  challenge: string;
  redirect: string;
}

/** The path the browser visits after any sign-in completes. It stays on the API origin. */
export function continuePath(config: ResolvedConfig, handoffId: string): string {
  return `${config.basePath}/handoff/continue?h=${encodeURIComponent(handoffId)}`;
}

function redirectAllowed(config: ResolvedConfig, redirect: string): boolean {
  const h = config.handoff;
  if (!h) return false;
  if (h.schemes.some((s) => redirect === `${s}auth`)) return true;
  return h.devRedirectPattern?.test(redirect) ?? false;
}

/**
 * Writes the start row. The app's challenge and redirect live there, so
 * no cookie carries them, and the sign-in page only needs the handoff id.
 */
export async function startHandoff(
  config: ResolvedConfig,
  input: HandoffStart,
): Promise<Result<{ handoffId: string }>> {
  if (!config.handoff) return fail("not_found");
  if (!CHALLENGE_RE.test(input.challenge)) return fail("invalid_body");
  if (!redirectAllowed(config, input.redirect)) return fail("invalid_body");
  if (!(await config.limiter.allow(`handoff-start:ip:${input.ip ?? "unknown"}`, START_LIMIT))) {
    return fail("rate_limited");
  }
  const now = config.clock.now();
  const handoffId = randomToken(HANDOFF_ID_PREFIX);
  const data: StartData = {
    challenge: input.challenge,
    redirect: input.redirect,
    next: safeNext(input.next),
  };
  await config.storage.create("verification", {
    id: newId(now),
    purpose: "handoff-code",
    identifier: START_ID,
    valueHash: await sha256Hex(handoffId),
    expiresAt: new Date(now.getTime() + START_TTL_MS),
    consumedAt: null,
    data: { ...data },
    createdAt: now,
    updatedAt: now,
  });
  return ok({ handoffId });
}

/** The same conditional consume as the magic link. Returns the row when this call consumed it. */
async function consume(
  config: ResolvedConfig,
  valueHash: string,
): Promise<Result<VerificationRow>> {
  const now = config.clock.now();
  const row = await config.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: valueHash },
    { field: "purpose", op: "eq", value: "handoff-code" },
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
  if (consumed !== 1) {
    const expired = row.consumedAt === null && row.expiresAt.getTime() <= now.getTime();
    return fail(expired ? "token_expired" : "invalid_token");
  }
  return ok(row);
}

/**
 * The signed-in browser continues the handoff: the start row is spent,
 * a code row is written for the user, and the app's redirect gets the code.
 */
export async function continueHandoff(
  config: ResolvedConfig,
  input: { handoffId: string; userId: string },
): Promise<Result<{ location: string }>> {
  if (!config.handoff) return fail("not_found");
  if (!ID_RE.test(input.handoffId)) return fail("invalid_token");
  const start = await consume(config, await sha256Hex(input.handoffId));
  if (!start.ok) return start;
  if (start.value.identifier !== START_ID) return fail("invalid_token");
  const data = start.value.data as StartData | null;
  if (!data || typeof data.challenge !== "string" || typeof data.redirect !== "string")
    return fail("invalid_token");
  const now = config.clock.now();
  const code = randomToken(HANDOFF_CODE_PREFIX);
  const codeData: CodeData = { challenge: data.challenge, redirect: data.redirect };
  await config.storage.create("verification", {
    id: newId(now),
    purpose: "handoff-code",
    identifier: input.userId,
    valueHash: await sha256Hex(code),
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    consumedAt: null,
    data: { ...codeData },
    createdAt: now,
    updatedAt: now,
  });
  return ok({ location: `${data.redirect}?code=${encodeURIComponent(code)}` });
}

/**
 * The app proves it started the flow with the verifier, and gets a bearer
 * session. The code row is spent first, so a replay fails before any
 * compare, and a wrong verifier also spends it.
 */
export async function redeemHandoff(
  config: ResolvedConfig,
  input: { code: string; verifier: string; ip: string | null; userAgent: string | null },
): Promise<Result<{ token: string; user: UserRow; session: SessionRow }>> {
  if (!config.handoff) return fail("not_found");
  if (!(await config.limiter.allow(`handoff-redeem:ip:${input.ip ?? "unknown"}`, REDEEM_LIMIT))) {
    return fail("rate_limited");
  }
  if (!CODE_RE.test(input.code)) return fail("invalid_token");
  const row = await consume(config, await sha256Hex(input.code));
  if (!row.ok) return row;
  if (row.value.identifier === START_ID) return fail("invalid_token");
  const data = row.value.data as CodeData | null;
  if (!data || typeof data.challenge !== "string") return fail("invalid_token");
  if (!constantTimeEqual(await sha256Base64Url(input.verifier), data.challenge))
    return fail("invalid_token");
  const user = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: row.value.identifier },
  ]);
  if (!user) return fail("invalid_token");
  const { token, session } = await createSession(config, {
    userId: user.id,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return ok({ token, user, session });
}
