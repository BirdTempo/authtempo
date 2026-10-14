import type { ResolvedConfig, ResolvedTotp } from "../config.js";
import { constantTimeEqual, hmacSha256Hex } from "../primitives/crypto.js";
import { groupBackupCode, normalizeBackupCode, randomBackupCode } from "../primitives/totp.js";
import { fail, ok, type Result } from "../result.js";
import type { SecondFactorMethod, SecondFactorRow, SessionRow } from "../schema.js";
import type { StorageAdapter } from "../storage/port.js";
import { endSessions } from "./sessions.js";

/**
 * The second factor apart from its methods (plan 12c, spec 8.11 and 8.14).
 * One `secondFactor` row per user holds the methods that are on and the
 * backup codes. The row exists only while a method is on, so "the factor is
 * on" is "the row exists", and every gate reads this row. The TOTP method
 * keeps its sealed secret in `totp` (engine/totp.ts).
 */

/** The version of a new backup code list: codes of 112 bits or more (ASVS 5.0 6.5.2). */
export const BACKUP_CODES_VERSION = 2;
/**
 * The rounds of a compare-and-set on the row. Each lost round means that a
 * parallel write landed first. An adapter whose `eq` on a date never matches
 * loses every round; the bound stops the loop then.
 */
const ROUNDS = 5;

/** A write time strictly after `than`, so a compare-and-set on `updatedAt` sees every write. */
export function later(now: Date, than: Date): Date {
  return new Date(Math.max(now.getTime(), than.getTime() + 1));
}

/** The factor row of the user, or null when the factor is off. */
export function factorRow(
  storage: StorageAdapter,
  userId: string,
): Promise<SecondFactorRow | null> {
  return storage.findOne("secondFactor", [{ field: "userId", op: "eq", value: userId }]);
}

/** HMAC-SHA256 hex under the app secret of `<row id>:<code>` (spec 8.11 item 3). */
function backupCodeHash(secret: string, rowId: string, code: string): Promise<string> {
  return hmacSha256Hex(secret, `${rowId}:${code}`);
}

/**
 * New backup codes for the row `rowId`: the codes to show once, in groups,
 * and their keyed hashes. The hash is of the code with no dash, as
 * `normalizeBackupCode` reads a typed code.
 */
export async function newBackupCodes(
  config: ResolvedConfig,
  totp: ResolvedTotp,
  rowId: string,
): Promise<{ codes: string[]; hashes: string[] }> {
  const raw = Array.from({ length: totp.backupCodes }, () =>
    randomBackupCode(totp.backupCodeLength),
  );
  const hashes = await Promise.all(raw.map((c) => backupCodeHash(config.secret, rowId, c)));
  return { codes: raw.map(groupBackupCode), hashes };
}

/**
 * Spends a backup code: the codes left, or null for a code that is not
 * there. Every stored hash runs the compare. The removal is a compare-and-set
 * on `updatedAt`, so two parallel uses of one code spend it once: the loser
 * reads the row again and no longer finds the code. A list of version 1
 * passes too: the hash does not depend on the length.
 */
export async function spendBackupCode(
  config: ResolvedConfig,
  row: SecondFactorRow,
  code: string,
  now: Date,
): Promise<number | null> {
  const typed = normalizeBackupCode(code);
  let current: SecondFactorRow | null = row;
  // A hard bound, as `countAttempt` has. Each lost round means that a
  // parallel use spent a code, so an honest adapter ends before the list is
  // empty. Without the bound one backup code holds a request forever on an
  // adapter whose `eq` on a date never matches.
  for (let round = 0; round <= row.backupCodes.length; round++) {
    if (!current) return null;
    const candidate = await backupCodeHash(config.secret, current.id, typed);
    let found = -1;
    current.backupCodes.forEach((hash, i) => {
      if (constantTimeEqual(candidate, hash)) found = i;
    });
    if (found === -1) return null;
    const left = current.backupCodes.filter((_, i) => i !== found);
    const n = await config.storage.update(
      "secondFactor",
      [
        { field: "id", op: "eq", value: current.id },
        { field: "updatedAt", op: "eq", value: current.updatedAt },
      ],
      { backupCodes: left, updatedAt: later(now, current.updatedAt) },
    );
    if (n === 1) return left.length;
    current = await config.storage.findOne("secondFactor", [
      { field: "id", op: "eq", value: current.id },
    ]);
  }
  console.error("authtempo: backup code spend gave up", row.id);
  return null;
}

/**
 * A new list of backup codes at version 2, by a compare-and-set on
 * `updatedAt`: a backup code spent at the same time does not come back.
 */
export async function replaceBackupCodes(
  config: ResolvedConfig,
  totp: ResolvedTotp,
  row: SecondFactorRow,
  now: Date,
): Promise<Result<{ backupCodes: string[] }>> {
  let current: SecondFactorRow | null = row;
  // A lost round means that a parallel spend or replacement wrote first.
  // Past the bound the answer is `conflict`, because the factor is still on.
  for (let round = 0; round < ROUNDS; round++) {
    if (!current) return fail("totp_not_enabled");
    const { codes, hashes } = await newBackupCodes(config, totp, current.id);
    const n = await config.storage.update(
      "secondFactor",
      [
        { field: "id", op: "eq", value: current.id },
        { field: "updatedAt", op: "eq", value: current.updatedAt },
      ],
      {
        backupCodes: hashes,
        backupCodesVersion: BACKUP_CODES_VERSION,
        updatedAt: later(now, current.updatedAt),
      },
    );
    if (n === 1) return ok({ backupCodes: codes });
    current = await config.storage.findOne("secondFactor", [
      { field: "id", op: "eq", value: current.id },
    ]);
  }
  console.error("authtempo: backup code replacement gave up", row.id);
  return fail("conflict");
}

/** A challenge is a session in waiting, as a handoff code is: a flow that ends the user's sessions or changes the factor deletes the user's challenges. */
export async function deleteTwoFactorChallenges(tx: StorageAdapter, userId: string): Promise<void> {
  await tx.delete("verification", [
    { field: "purpose", op: "eq", value: "two-factor" },
    { field: "identifier", op: "eq", value: userId },
  ]);
}

/**
 * Thrown inside a transaction when the compare-and-set on the factor row lost
 * every round, or the row went under the write. The throw undoes the
 * transaction; the caller answers `conflict` outside it, and the person retries.
 */
export class FactorRaceError extends Error {
  constructor() {
    super("authtempo: the second factor row changed under the write");
    this.name = "FactorRaceError";
  }
}

export interface AddedMethod {
  /** True when this call wrote the row: the first method. */
  first: boolean;
  row: SecondFactorRow;
}

/**
 * Turns `method` on, inside the caller's transaction (spec 8.11 item 1, 8.14).
 * With no row, it writes the row with `first`: the id and the backup code
 * hashes that the caller made under that id. Then every other session of the
 * user ends, and the trusted devices and the challenges go: the enable of the
 * first method, so a session a thief holds does not survive it. The caller
 * fires `two_factor` for `ended` after its commit. With a row, it adds the
 * method by a compare-and-set on `updatedAt` and ends nothing. A method that
 * is on already changes nothing. A parallel first enable of another method
 * fails this create on the unique `userId`; the caller catches it outside.
 */
export async function addMethod(
  tx: StorageAdapter,
  input: {
    userId: string;
    keepSessionId: string;
    method: SecondFactorMethod;
    first: { id: string; backupCodes: string[] };
  },
  now: Date,
  ended: SessionRow[] | undefined,
): Promise<AddedMethod> {
  let current = await factorRow(tx, input.userId);
  if (!current) {
    const row = await tx.create("secondFactor", {
      id: input.first.id,
      userId: input.userId,
      enabledAt: now,
      methods: [input.method],
      backupCodes: input.first.backupCodes,
      backupCodesVersion: BACKUP_CODES_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    await endSessions(
      tx,
      [
        { field: "userId", op: "eq", value: input.userId },
        { field: "id", op: "ne", value: input.keepSessionId },
      ],
      ended ?? null,
    );
    await tx.delete("trustedDevice", [{ field: "userId", op: "eq", value: input.userId }]);
    await deleteTwoFactorChallenges(tx, input.userId);
    return { first: true, row };
  }
  for (let round = 0; round < ROUNDS; round++) {
    // A parallel disable of the last method deleted the row: the person retries.
    if (!current) throw new FactorRaceError();
    if (current.methods.includes(input.method)) return { first: false, row: current };
    const methods = [...current.methods, input.method];
    const updatedAt = later(now, current.updatedAt);
    const n = await tx.update(
      "secondFactor",
      [
        { field: "id", op: "eq", value: current.id },
        { field: "updatedAt", op: "eq", value: current.updatedAt },
      ],
      { methods, updatedAt },
    );
    if (n === 1) return { first: false, row: { ...current, methods, updatedAt } };
    current = await factorRow(tx, input.userId);
  }
  throw new FactorRaceError();
}

/**
 * Turns `method` off, inside the caller's transaction. The last method
 * deletes the row, the trusted devices, and the challenges: the factor is off
 * (spec 8.11 item 1). Both writes are a compare-and-set on `updatedAt`, so a
 * parallel enable or disable has one winner. False when the method was not on.
 */
export async function removeMethod(
  tx: StorageAdapter,
  userId: string,
  method: SecondFactorMethod,
  now: Date,
): Promise<boolean> {
  let current = await factorRow(tx, userId);
  for (let round = 0; round < ROUNDS; round++) {
    if (!current?.methods.includes(method)) return false;
    const methods = current.methods.filter((m) => m !== method);
    const where = [
      { field: "id" as const, op: "eq" as const, value: current.id },
      { field: "updatedAt" as const, op: "eq" as const, value: current.updatedAt },
    ];
    if (methods.length === 0) {
      if ((await tx.delete("secondFactor", where)) === 1) {
        await tx.delete("trustedDevice", [{ field: "userId", op: "eq", value: userId }]);
        await deleteTwoFactorChallenges(tx, userId);
        return true;
      }
    } else if (
      (await tx.update("secondFactor", where, {
        methods,
        updatedAt: later(now, current.updatedAt),
      })) === 1
    )
      return true;
    current = await factorRow(tx, userId);
  }
  throw new FactorRaceError();
}

/**
 * Turns the whole factor off, every method, in one transaction: the `totp`
 * row, the factor row, the trusted devices, and the challenges. For the
 * operator after identity proofing at the level of the enrollment (ASVS 5.0
 * 6.4.4), and for an app that checked the person another way. Answers the
 * count of factor rows it deleted.
 */
export function disableSecondFactor(config: ResolvedConfig, userId: string): Promise<number> {
  return config.storage.transaction(async (tx) => {
    await tx.delete("totp", [{ field: "userId", op: "eq", value: userId }]);
    const n = await tx.delete("secondFactor", [{ field: "userId", op: "eq", value: userId }]);
    await tx.delete("trustedDevice", [{ field: "userId", op: "eq", value: userId }]);
    await deleteTwoFactorChallenges(tx, userId);
    return n;
  });
}
