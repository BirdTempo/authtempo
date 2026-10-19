import { sha256Hex } from "../primitives/crypto.js";
import { fail, ok, type Result } from "../result.js";
import type { VerificationPurpose, VerificationRow } from "../schema.js";
import type { StorageAdapter } from "../storage/port.js";

/**
 * The `valueHash` of a replay row: the SHA-256 hex of
 * `<purpose>:<scope>:<jti>`. The unique key is on `valueHash` alone, so the
 * purpose comes first and no two purposes can collide (ruling 23 of plan 12e).
 */
export const replayHash = (
  purpose: "client-assertion" | "dpop-proof",
  scope: string,
  jti: string,
): Promise<string> => sha256Hex(`${purpose}:${scope}:${jti}`);

export interface ConsumeInput {
  purpose: VerificationPurpose;
  /** The SHA-256 hex of the clear token. */
  valueHash: string;
  now: Date;
}

/**
 * Consumes a mailed row in one conditional update, so two clicks on the
 * same link race for one row and only one wins. One copy for every mailed
 * link: a third copy of a security check drifts.
 */
export async function consumeVerification(
  tx: StorageAdapter,
  input: ConsumeInput,
): Promise<Result<VerificationRow>> {
  const { now } = input;
  const row = await tx.findOne("verification", [
    { field: "valueHash", op: "eq", value: input.valueHash },
    { field: "purpose", op: "eq", value: input.purpose },
  ]);
  if (!row) return fail("invalid_token");
  const consumed = await tx.update(
    "verification",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "consumedAt", op: "eq", value: null },
      { field: "expiresAt", op: "gt", value: now },
    ],
    { consumedAt: now, updatedAt: now },
  );
  if (consumed !== 1) {
    // An unconsumed row past its expiry is expired. A consumed row, or one a
    // concurrent click consumed after our read, is invalid.
    const expired = row.consumedAt === null && row.expiresAt.getTime() <= now.getTime();
    return fail(expired ? "token_expired" : "invalid_token");
  }
  return ok(row);
}

/** The attempt count of a row whose `data` holds `attempts` (plan 9e). A missing or bad value is 0. */
export function attemptsOf(row: VerificationRow): number {
  const n = (row.data as { attempts?: unknown } | null)?.attempts;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * Counts one wrong code on a row (plan 9e; moved here by plan 9f for the
 * second-factor challenge). A compare-and-set on `updatedAt`: the update
 * matches the row only as this call read it, and writes a strictly later
 * `updatedAt`. When a parallel guess wrote first, the update matches zero
 * rows, and the call reads the row again and counts on the new value. So no
 * guess goes uncounted, on D1 and on Postgres. A lost round means that
 * another guess counted or the row was spent, so the loop ends. The write
 * keeps every other key of `data`. The guess that reaches `max` also spends
 * the row.
 *
 * The loop has a hard bound of `max + 1` rounds. Each lost round means that
 * another guess counted, and the row is spent after at most `max` counts, so
 * an honest adapter never reaches the bound. An adapter whose `eq` on a date
 * never matches (whole seconds, a shifted zone) loses every round; without
 * the bound, one wrong code then holds a request and a connection forever.
 * The storage conformance suite pins `eq` on a date on every adapter.
 */
export async function countAttempt(
  storage: StorageAdapter,
  row: VerificationRow,
  max: number,
  now: Date,
): Promise<"invalid_code" | "too_many_attempts"> {
  const settled = (r: VerificationRow | null) =>
    r && attemptsOf(r) >= max ? "too_many_attempts" : "invalid_code";
  let current: VerificationRow | null = row;
  for (let round = 0; round <= max; round++) {
    if (!current || current.consumedAt !== null) return settled(current);
    const attempts = attemptsOf(current) + 1;
    const capped = attempts >= max;
    const n = await storage.update(
      "verification",
      [
        { field: "id", op: "eq", value: current.id },
        { field: "consumedAt", op: "eq", value: null },
        { field: "updatedAt", op: "eq", value: current.updatedAt },
      ],
      {
        data: { ...(current.data ?? {}), attempts },
        updatedAt: new Date(Math.max(now.getTime(), current.updatedAt.getTime() + 1)),
        ...(capped ? { consumedAt: now } : {}),
      },
    );
    if (n === 1) {
      if (!capped) return "invalid_code";
      // An email code (plan 9e): two parallel requests can leave two live
      // codes. The cap spends them all, so every later try answers
      // `too_many_attempts` until a new request, and the older code gets no
      // more guesses. The `createdAt` bound keeps a code that a parallel
      // request commits after the cap: that code is a new request, and its
      // owner must be able to use it (final re-review of plan 9e,
      // 2026-10-13). A second-factor challenge (plan 9f) is one sign-in with
      // its own token, so the cap spends that row only (spec 8.11 item 4): a
      // guess on one challenge must not end the sign-in of another device.
      if (current.purpose !== "two-factor")
        await storage.update(
          "verification",
          [
            { field: "purpose", op: "eq", value: current.purpose },
            { field: "identifier", op: "eq", value: current.identifier },
            { field: "consumedAt", op: "eq", value: null },
            { field: "createdAt", op: "lte", value: current.createdAt },
          ],
          { consumedAt: now, updatedAt: now },
        );
      return "too_many_attempts";
    }
    current = await storage.findOne("verification", [{ field: "id", op: "eq", value: current.id }]);
  }
  if (!current || current.consumedAt !== null) return settled(current);
  const kind = row.purpose === "two-factor" ? "second-factor challenge" : "email code";
  console.error(`authtempo: ${kind} count gave up`, row.id);
  return "invalid_code";
}

/**
 * Per 24 hours per address, the cap of each mailed-code key. Two keys read
 * it. `otp:email-day:<email>` counts the email code sign-in and the reset
 * code (plan 9e final fix wave), and the re-authentication code (plan 12a).
 * `totp:email-day:<email>` counts the
 * second-factor email code (plan 12c, owner decision 2026-10-14). The keys
 * are apart because `POST /otp/request` needs no password: a person who
 * knows the address must not use up the second factor's mails.
 */
export const MAILED_CODES_PER_EMAIL_DAY = { seconds: 86_400, max: 20 };
