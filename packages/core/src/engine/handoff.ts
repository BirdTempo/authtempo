import type { ResolvedConfig } from "../config.js";
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
// RFC 7636 verifier: 43 to 128 characters of the unreserved set (letters, digits, "-", ".", "_", "~").
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
// A start row lives at least 10 minutes, and at least as long as a magic link, so a person who signs in by the link at its last minute can still continue.
const START_MIN_TTL_MINUTES = 10;
const CODE_TTL_MS = 2 * 60_000;
const START_ID = "start";
const START_LIMIT = { seconds: 15 * 60, max: 30 };
const REDEEM_LIMIT = { seconds: 15 * 60, max: 20 };

export interface HandoffStart {
  /** PKCE S256 challenge, base64url of SHA-256 of the app's verifier. */
  challenge: string;
  /** `<scheme>auth` for a configured scheme, or a URL the dev pattern admits. */
  redirect: string;
  ip: string | null;
}

interface StartData {
  challenge: string;
  redirect: string;
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
  // The client refuses every URL with a fragment, so the API must not admit a redirect that has one.
  if (redirect.includes("#")) return false;
  if (h.schemes.some((s) => redirect === `${s}auth`)) return true;
  if (!h.devRedirectPattern?.test(redirect)) return false;
  // A dev pattern may admit a loopback web URL (RFC 8252 section 7.3) or a non-web scheme; never a remote web origin, which would carry the code to a server that also holds the verifier.
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return false;
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    return ["127.0.0.1", "[::1]", "::1", "localhost"].includes(url.hostname);
  }
  return true;
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
  };
  await config.storage.create("verification", {
    id: newId(now),
    purpose: "handoff-code",
    identifier: START_ID,
    valueHash: await sha256Hex(handoffId),
    expiresAt: new Date(
      now.getTime() + Math.max(START_MIN_TTL_MINUTES, config.magicLink.ttlMinutes) * 60_000,
    ),
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

/** The live start row for a handoff id, without consuming it. */
export async function peekHandoff(
  config: ResolvedConfig,
  handoffId: string,
): Promise<Result<{ redirect: string }>> {
  if (!config.handoff) return fail("not_found");
  if (!ID_RE.test(handoffId)) return fail("invalid_token");
  const now = config.clock.now();
  const row = await config.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: await sha256Hex(handoffId) },
    { field: "purpose", op: "eq", value: "handoff-code" },
  ]);
  if (!row || row.identifier !== START_ID) return fail("invalid_token");
  if (row.consumedAt !== null) return fail("invalid_token");
  if (row.expiresAt.getTime() <= now.getTime()) return fail("token_expired");
  const data = row.data as { redirect?: unknown } | null;
  return typeof data?.redirect === "string"
    ? ok({ redirect: data.redirect })
    : fail("invalid_token");
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
  // Defense in depth: the hs_ and hc_ prefixes already keep a start row and a code row apart, so this branch is unreachable through the public API and has no test.
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
  // The handoff package matches this string byte for byte; URL serialization would rewrite the redirect. The code is base64url with the hc_ prefix, so it needs no escape.
  const separator = data.redirect.includes("?") ? "&" : "?";
  return ok({ location: `${data.redirect}${separator}code=${code}` });
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
  // A malformed verifier cannot match, so refuse it before the consume spends the code.
  if (!VERIFIER_RE.test(input.verifier)) return fail("invalid_token");
  const row = await consume(config, await sha256Hex(input.code));
  if (!row.ok) return row;
  // Defense in depth: the hs_ and hc_ prefixes already keep a start row and a code row apart, so this branch is unreachable through the public API and has no test.
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
