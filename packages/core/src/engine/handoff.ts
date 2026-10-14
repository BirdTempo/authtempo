import type { ResolvedConfig } from "../config.js";
import { ipKey } from "../limiter/ip-key.js";
import {
  constantTimeEqual,
  randomToken,
  sha256Base64Url,
  sha256Hex,
} from "../primitives/crypto.js";
import { newId } from "../primitives/ids.js";
import { fail, ok, type Result } from "../result.js";
import type { SessionRow, UserRow, VerificationRow } from "../schema.js";
import type { StorageAdapter } from "../storage/port.js";
import { hookGuard } from "./hooks.js";
import { openSession, sessionOpened } from "./sessions.js";
import { ClaimRacedError, undoSessionIfClaimed } from "./users.js";

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
  /**
   * The user's flag when the code was minted. A code minted for an
   * unverified user runs the claim guard at redeem, whatever a later read
   * of the user says. A code without the flag counts as unverified.
   */
  emailVerified?: boolean;
}

/** The path the browser visits after any sign-in completes. It stays on the API origin. */
export function continuePath(config: ResolvedConfig, handoffId: string): string {
  return `${config.basePath}/handoff/continue?h=${encodeURIComponent(handoffId)}`;
}

export function redirectAllowed(config: ResolvedConfig, redirect: string): boolean {
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
  if (!(await config.limiter.allow(`handoff-start:ip:${ipKey(input.ip)}`, START_LIMIT))) {
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
    secretVersion: config.keyring.current,
  });
  return ok({ handoffId });
}

/** The same conditional consume as the magic link. Returns the row when this call consumed it. */
async function consume(
  config: ResolvedConfig,
  valueHash: string,
  storage: StorageAdapter = config.storage,
): Promise<Result<VerificationRow>> {
  const now = config.clock.now();
  const row = await storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: valueHash },
    { field: "purpose", op: "eq", value: "handoff-code" },
  ]);
  if (!row) return fail("invalid_token");
  const consumed = await storage.update(
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
 * `sessionId` is the browser session the caller checked. The consume, the
 * user read, the code write, and a re-check of that session run in one
 * transaction.
 */
export async function continueHandoff(
  config: ResolvedConfig,
  input: { handoffId: string; userId: string; sessionId: string },
): Promise<Result<{ location: string }>> {
  if (!config.handoff) return fail("not_found");
  if (!ID_RE.test(input.handoffId)) return fail("invalid_token");
  const startHash = await sha256Hex(input.handoffId);
  const now = config.clock.now();
  const code = randomToken(HANDOFF_CODE_PREFIX);
  const codeHash = await sha256Hex(code);
  try {
    return await config.storage.transaction(async (tx): Promise<Result<{ location: string }>> => {
      const start = await consume(config, startHash, tx);
      if (!start.ok) return start;
      // Defense in depth: the hs_ and hc_ prefixes already keep a start row and a code row apart, so this branch is unreachable through the public API and has no test.
      if (start.value.identifier !== START_ID) return fail("invalid_token");
      const data = start.value.data as StartData | null;
      if (!data || typeof data.challenge !== "string" || typeof data.redirect !== "string")
        return fail("invalid_token");
      // Read before the code row is written: a claim after this read deletes
      // the code row, or the redeem guard sees the claim's flip.
      const user = await tx.findOne("user", [{ field: "id", op: "eq", value: input.userId }]);
      const codeData: CodeData = {
        challenge: data.challenge,
        redirect: data.redirect,
        emailVerified: user?.emailVerified === true,
      };
      await tx.create("verification", {
        id: newId(now),
        purpose: "handoff-code",
        identifier: input.userId,
        valueHash: codeHash,
        expiresAt: new Date(now.getTime() + CODE_TTL_MS),
        consumedAt: null,
        data: { ...codeData },
        createdAt: now,
        updatedAt: now,
        secretVersion: config.keyring.current,
      });
      // The session was checked before this transaction. A claim in between deleted it and verified the user; the conditional update sees the deletion and undoes the code, which would otherwise skip the redeem guard.
      // The user id is in the where too: an api caller passes the two
      // values apart, and a live session of another user must not pass.
      const n = await tx.update(
        "session",
        [
          { field: "id", op: "eq", value: input.sessionId },
          { field: "userId", op: "eq", value: input.userId },
        ],
        { updatedAt: now },
      );
      if (n === 0) throw new ClaimRacedError();
      // The handoff package matches this string byte for byte; URL serialization would rewrite the redirect. The code is base64url with the hc_ prefix, so it needs no escape.
      const separator = data.redirect.includes("?") ? "&" : "?";
      return ok({ location: `${data.redirect}${separator}code=${code}` });
    });
  } catch (err) {
    if (err instanceof ClaimRacedError) return fail("invalid_token");
    throw err;
  }
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
  if (!(await config.limiter.allow(`handoff-redeem:ip:${ipKey(input.ip)}`, REDEEM_LIMIT))) {
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
  const userId = row.value.identifier;
  const now = config.clock.now();
  let redeemed: Result<{ token: string; user: UserRow; session: SessionRow }>;
  try {
    redeemed = await hookGuard(() =>
      config.storage.transaction(
        async (tx): Promise<Result<{ token: string; user: UserRow; session: SessionRow }>> => {
          const user = await tx.findOne("user", [{ field: "id", op: "eq", value: userId }]);
          if (!user) return fail("invalid_token");
          const { token, session } = await openSession(
            config,
            { user, ip: input.ip, userAgent: input.userAgent, via: "handoff" },
            tx,
          );
          // The flag from the mint, not this read: a claim can commit between
          // the consume and this read, and this read then sees the user verified.
          if (data.emailVerified !== true) {
            // A claim can land between this insert and the commit; on D1 and on Postgres read committed the delete in claimEmail may miss this row. The conditional update sees the claim's first statement and undoes the insert.
            await undoSessionIfClaimed(tx, user.id, now);
          }
          return ok({ token, user, session });
        },
      ),
    );
  } catch (err) {
    if (err instanceof ClaimRacedError) return fail("invalid_token");
    throw err;
  }
  if (redeemed.ok)
    await sessionOpened(config, redeemed.value.session, redeemed.value.user, "handoff");
  return redeemed;
}
