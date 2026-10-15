import type { ResolvedConfig } from "../config.js";
import { fail, ok, type Result } from "../result.js";
import type { SessionRow } from "../schema.js";

/**
 * The fresh-session rule (plan 12a, spec 8.15; ASVS 5.0.0 7.5.1 and 7.5.2).
 * A sensitive change needs a session whose `freshAt` is younger than
 * `session.freshMinutes`. A sign-in writes `freshAt` (`createSession`); a
 * re-authentication moves it (`markFresh`). Null is never fresh: a session
 * of schema version 9 or older proves the person once. The token and the
 * expiry never change here, so a native app keeps its bearer token and the
 * absolute lifetime of plan 12b holds.
 */

function windowMs(config: Pick<ResolvedConfig, "session">): number {
  return config.session.freshMinutes * 60_000;
}

/** True while `now` is less than one window after `freshAt`. */
export function isFresh(
  config: Pick<ResolvedConfig, "session">,
  session: Pick<SessionRow, "freshAt">,
  now: Date,
): boolean {
  if (session.freshAt === null) return false;
  return now.getTime() - session.freshAt.getTime() < windowMs(config);
}

/** `session_not_fresh` (403) unless the session is fresh now. Every sensitive route and operation calls it. */
export function requireFresh(
  config: Pick<ResolvedConfig, "session" | "clock">,
  session: Pick<SessionRow, "freshAt">,
): Result<true> {
  return isFresh(config, session, config.clock.now()) ? ok(true) : fail("session_not_fresh");
}

/** The end of the window, or null for a session that is not fresh now. */
export function freshUntil(
  config: Pick<ResolvedConfig, "session">,
  session: Pick<SessionRow, "freshAt">,
  now: Date,
): Date | null {
  if (!session.freshAt || !isFresh(config, session, now)) return null;
  return new Date(session.freshAt.getTime() + windowMs(config));
}

/**
 * Makes one session fresh: one conditional update of the live row by id. Zero
 * rows means that the session ended in between (a revoke, a sign-out, the
 * expiry): `unauthorized`. No hook runs: freshness opens no session.
 */
export async function markFresh(
  config: ResolvedConfig,
  sessionId: string,
): Promise<Result<{ freshUntil: Date }>> {
  const now = config.clock.now();
  const n = await config.storage.update(
    "session",
    [
      { field: "id", op: "eq", value: sessionId },
      { field: "expiresAt", op: "gt", value: now },
    ],
    { freshAt: now, updatedAt: now },
  );
  if (n !== 1) return fail("unauthorized");
  return ok({ freshUntil: new Date(now.getTime() + windowMs(config)) });
}
