import type { ResolvedConfig } from "../../config.js";
import { readCertificate } from "../../saml/der.js";
import { EXPIRY_STAGES, type ExpiryStage, type SsoConnectionRow } from "../../schema.js";

/**
 * The expiry dates and the sign-in status of a connection (plan 13b Task 9, spec 6.6 and 6.7).
 * A row with an end gets a notice 30, 7, and 1 days before it. The sweep of Task 10 sends each
 * notice; this file gives the date of the next one and the status write of each sign-in.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * The stages that can still send a notice: each stage below the last sent stage whose date is
 * after `start`. A date on or before `start` is in the past at the row's start, so a short
 * life skips that stage (a link of 168 hours gets the stage of 1 day only, ruling C10).
 */
function openStages(end: Date, sent: ExpiryStage | null, start: Date): ExpiryStage[] {
  return EXPIRY_STAGES.filter(
    (s) => (sent === null || s < sent) && end.getTime() - s * DAY_MS > start.getTime(),
  );
}

/**
 * The time of the next notice of a row, or null. `end` is the end of the row, `sent` the last
 * stage that sent a notice, `start` the start of the row or of its end. Null: no end, the end
 * is past, or no stage is left.
 */
export function nextNotice(
  end: Date | null,
  sent: ExpiryStage | null,
  now: Date,
  start: Date,
): Date | null {
  if (end === null || end.getTime() <= now.getTime()) return null;
  const stages = openStages(end, sent, start);
  const largest = stages[0];
  return largest === undefined ? null : new Date(end.getTime() - largest * DAY_MS);
}

/**
 * The stage that is due at `now`: the smallest open stage whose date is on or before `now`, or
 * null. A sweep that runs late sends this one notice, and skips the larger stages.
 */
export function stageAt(
  end: Date,
  sent: ExpiryStage | null,
  now: Date,
  start: Date,
): ExpiryStage | null {
  const due = openStages(end, sent, start).filter(
    (s) => end.getTime() - s * DAY_MS <= now.getTime(),
  );
  return due.at(-1) ?? null;
}

/** The latest `notAfter` of the certificates (owner decision 8), or null when none reads. */
export function certificatesEnd(pems: readonly string[]): Date | null {
  let end: Date | null = null;
  for (const pem of pems) {
    const notAfter = readCertificate(pem)?.notAfter;
    if (notAfter && (end === null || notAfter.getTime() > end.getTime())) end = notAfter;
  }
  return end;
}

/** The certificates of the config of a SAML connection. */
export function certificatesOf(config: Record<string, unknown>): string[] {
  const list = config.certificates;
  return Array.isArray(list) ? list.filter((c): c is string => typeof c === "string") : [];
}

/** The stored stage as a stage. A value outside the list reads as null. */
function storedStage(value: number | null): ExpiryStage | null {
  return EXPIRY_STAGES.find((s) => s === value) ?? null;
}

/**
 * Writes the result of one real sign-in on its connection (plan 13b Task 9). `step` is null for
 * a sign-in that passed, else the step that failed. A test run never calls it. The write is
 * conditional on the value read, and it runs at most once an hour for each field. It keeps
 * `updatedAt`, the lock of an update of the manager. A SAML row from before schema 18 gets its
 * certificate end and its notice date in the same write (owner decision 6). A fault of the
 * write never fails the sign-in: it emits `sso.status_write_failed`.
 */
export async function noteSignIn(
  config: ResolvedConfig,
  row: SsoConnectionRow,
  step: string | null,
): Promise<void> {
  const now = config.clock.now();
  const field = step === null ? "lastSuccessAt" : "lastFailureAt";
  const read = row[field];
  if (read !== null && now.getTime() - read.getTime() < HOUR_MS) return;
  const changes: Partial<SsoConnectionRow> =
    step === null ? { lastSuccessAt: now } : { lastFailureAt: now, lastFailureStep: step };
  const fill =
    row.kind === "saml" &&
    row.certificateEndsAt === null &&
    storedStage(row.expiryStage) === null &&
    row.expiryNoticeAt === null
      ? certificatesEnd(certificatesOf(row.config))
      : null;
  if (fill !== null) {
    changes.certificateEndsAt = fill;
    changes.expiryNoticeAt = nextNotice(fill, null, now, now);
  }
  try {
    await config.storage.update(
      "ssoConnection",
      [
        { field: "id", op: "eq", value: row.id },
        { field, op: "eq", value: read },
        // A write of the certificates between the read and this write sets the end: keep it.
        ...(fill === null
          ? []
          : ([{ field: "certificateEndsAt", op: "eq", value: null }] as const)),
      ],
      changes,
    );
  } catch (e) {
    config.observe.emit({ name: "sso.status_write_failed", connectionId: row.id, errorName: e });
  }
}
