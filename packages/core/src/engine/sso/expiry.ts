import type { ResolvedConfig } from "../../config.js";
import { readCertificate } from "../../saml/der.js";
import {
  EXPIRY_KINDS,
  EXPIRY_STAGES,
  type ExpiryKind,
  type ExpiryStage,
  type SsoConnectionRow,
} from "../../schema.js";
import type { Meter } from "../../storage/meter.js";
import type { StorageAdapter, Where } from "../../storage/port.js";
import { runAfter } from "../hooks.js";
import { sendNotice } from "../notices.js";
import { ownerAddresses } from "./setup-links.js";

/**
 * The expiry dates and the sign-in status of a connection (plan 13b Task 9, spec 6.6 and 6.7).
 * A row with an end gets a notice 30, 7, and 1 days before it. The sweep sends each notice
 * (`sweepExpiry`, Task 10); this file gives the date of the next one and the status write of
 * each sign-in.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The due rows of one kind that one read of the sweep takes (plan 13b Task 10). */
export const EXPIRY_PAGE = 5;
/** The members that the owner read of one row scans: one page. */
export const EXPIRY_OWNER_PAGE = 100;
/** The mails of one row at most. The event counts the owners past it in `ownersCut`. */
export const EXPIRY_MAIL_MAX = 10;
/** The worst calls of the owner read of one row: one page of members, one read of the users. */
const OWNER_READ_CALLS = 2;

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

/** The kinds that the sweep reads: each kind runs while its feature is on. */
export function expiryKindsOn(config: ResolvedConfig): ExpiryKind[] {
  const on: Record<ExpiryKind, boolean> = {
    saml_certificate: config.sso !== null,
    scim_token: config.scim !== null,
    setup_link: config.sso !== null && config.sso.setup !== false,
  };
  return EXPIRY_KINDS.filter((kind) => on[kind]);
}

/** One due row of a kind, in the fields that the step reads. */
interface DueRow {
  id: string;
  organizationId: string;
  createdAt: Date;
  /** The connection label, the token name, or the link note. */
  label: string;
  end: Date | null;
  /** A link that a manager revoked or that an activation ended. */
  closed: boolean;
  stage: ExpiryStage | null;
  /** The value that the read got, which the claim must still find. */
  noticeAt: Date | null;
}

/** The due rows of a kind: `expiryNoticeAt` on or before `now`, the oldest first. One call. */
async function readDue(storage: StorageAdapter, kind: ExpiryKind, now: Date): Promise<DueRow[]> {
  const due = { field: "expiryNoticeAt", op: "lte", value: now } as const;
  // `expiryNoticeAt` is nullable, so its sort has no `notNull`. The id breaks a tie.
  const sort: { field: "expiryNoticeAt" | "id"; dir: "asc" }[] = [
    { field: "expiryNoticeAt", dir: "asc" },
    { field: "id", dir: "asc" },
  ];
  const opts = { sort, limit: EXPIRY_PAGE };
  const base = (r: {
    id: string;
    organizationId: string;
    createdAt: Date;
    expiryStage: number | null;
    expiryNoticeAt: Date | null;
  }) => ({
    id: r.id,
    organizationId: r.organizationId,
    createdAt: r.createdAt,
    stage: storedStage(r.expiryStage),
    noticeAt: r.expiryNoticeAt,
  });
  switch (kind) {
    // A disabled connection signs no user in, so the read skips it: no mail, no event, no hook,
    // and no write (ruling R15). It keeps its `expiryNoticeAt`, so an enable gets the nearest
    // stage at the next sweep. A skip in the loop would keep the row first in each read, and 5
    // such rows would stop the notices of every other connection. A draft is never enabled.
    case "saml_certificate":
      return (
        await storage.findMany(
          "ssoConnection",
          [due, { field: "enabled", op: "eq", value: true }],
          opts,
        )
      ).map((r) => ({
        ...base(r),
        label: r.label,
        end: r.certificateEndsAt,
        closed: false,
      }));
    case "scim_token":
      return (await storage.findMany("scimToken", [due], opts)).map((r) => ({
        ...base(r),
        label: r.name,
        end: r.expiresAt,
        closed: false,
      }));
    case "setup_link":
      return (await storage.findMany("ssoSetupLink", [due], opts)).map((r) => ({
        ...base(r),
        label: r.note,
        end: r.expiresAt,
        closed: r.revokedAt !== null || r.endedAt !== null,
      }));
  }
}

const EXPIRY_MODEL = {
  saml_certificate: "ssoConnection",
  scim_token: "scimToken",
  setup_link: "ssoSetupLink",
} as const satisfies Record<ExpiryKind, string>;

/**
 * The claim of a row: one conditional update on the id and on the `expiryNoticeAt` that the read
 * got. Of two sweeps at once, only one changes the row. It keeps `updatedAt`, the lock of an
 * update of the manager. True when this call changed the row. One call.
 */
async function claim(
  storage: StorageAdapter,
  kind: ExpiryKind,
  row: DueRow,
  changes: { expiryStage?: ExpiryStage; expiryNoticeAt: Date | null },
): Promise<boolean> {
  const where: Where<(typeof EXPIRY_MODEL)[ExpiryKind]>[] = [
    { field: "id", op: "eq", value: row.id },
    { field: "expiryNoticeAt", op: "eq", value: row.noticeAt },
  ];
  return (await storage.update(EXPIRY_MODEL[kind], where, changes)) > 0;
}

/**
 * The expiry step of the sweep for one kind (plan 13b Task 10, spec 6.7 item 2). It reads at
 * most `EXPIRY_PAGE` due rows, and for each row it claims the due stage before it sends. A row
 * with no end, an end in the past, or a closed link loses its notice date and sends nothing. The
 * read skips a disabled connection, which keeps its notice date (ruling R15). After an enable,
 * the next sweep sends the nearest due stage. The step reads one page of `EXPIRY_OWNER_PAGE`
 * members. An owner past that page gets no mail, and the step writes `notice.mail_failed` with a `RangeError`. For
 * an open row, the owners get at most `EXPIRY_MAIL_MAX` mails, then the step emits `sso.expiring`
 * and runs `hooks.sso.expiring`. Both run also while `account.notices` is off. The claim is the
 * record: a failed mail writes `notice.mail_failed`, and no sweep sends it again. The step stops
 * before a row whose calls do not fit `limit`, and that row waits for the next sweep. Each mail
 * counts as one call. The answer is the count of the stages that this step claimed.
 */
export async function sweepExpiry(
  config: ResolvedConfig,
  kind: ExpiryKind,
  now: Date,
  meter: Meter,
  limit: number,
): Promise<number> {
  const { storage } = config;
  if (meter.used + 1 > limit) return 0;
  const rows = await readDue(storage, kind, now);
  meter.step(1);
  let claimed = 0;
  for (const row of rows) {
    const end = row.end;
    if (row.closed || end === null || end.getTime() <= now.getTime()) {
      if (meter.used + 1 > limit) break;
      await claim(storage, kind, row, { expiryNoticeAt: null });
      meter.step(1);
      continue;
    }
    // The stage dates count from the start of the row. Each start on or before the due date
    // gives the same stage.
    const stage = stageAt(end, row.stage, now, row.createdAt);
    if (stage === null) {
      if (meter.used + 1 > limit) break;
      await claim(storage, kind, row, {
        expiryNoticeAt: nextNotice(end, row.stage, now, row.createdAt),
      });
      meter.step(1);
      continue;
    }
    if (meter.used + OWNER_READ_CALLS + 1 > limit) break;
    const owners = await ownerAddresses(config, row.organizationId, {
      pageSize: EXPIRY_OWNER_PAGE,
      maxPages: 1,
      most: EXPIRY_MAIL_MAX,
    });
    meter.step(OWNER_READ_CALLS);
    if (meter.used + 1 + owners.addresses.length > limit) break;
    const won = await claim(storage, kind, row, {
      expiryStage: stage,
      expiryNoticeAt: nextNotice(end, stage, now, row.createdAt),
    });
    meter.step(1);
    if (!won) continue;
    // An owner past the one member page gets no mail, and `ownersCut` does not count that owner.
    // This line, the same as the one of the hand back, records the loss.
    if (!owners.complete)
      config.observe.emit({
        name: "notice.mail_failed",
        event: "sso_expiring",
        errorName: new RangeError("owner scan bound"),
      });
    let mails = 0;
    let attempts = 0;
    for (const email of owners.addresses) {
      if (config.account.notices && email !== null) attempts++;
      const sent = await sendNotice(config, {
        event: "sso_expiring",
        email,
        ip: null,
        userAgent: null,
        expiring: { kind, id: row.id, label: row.label, at: end, days: stage },
      });
      if (sent) mails++;
    }
    meter.add(attempts);
    config.observe.emit({
      name: "sso.expiring",
      kind,
      rowId: row.id,
      organizationId: row.organizationId,
      stage,
      mails,
      ownersCut: owners.owners - owners.addresses.length,
    });
    await runAfter(
      config.observe,
      "sso.expiring",
      config.hooks.sso.expiring,
      { organizationId: row.organizationId, kind, id: row.id, at: end },
      row.id,
    );
    claimed++;
  }
  return claimed;
}
