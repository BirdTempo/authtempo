import type { ResolvedConfig } from "../../config.js";
import { isIpLiteral } from "../../limiter/ip-key.js";
import { isOperatorReason } from "../../operator-secret.js";
import { newMonotonicId } from "../../primitives/ids.js";
import { hasControlChar, removeRefusedChars } from "../../primitives/text.js";
import { fail, ok, type Result } from "../../result.js";
import type {
  OperatorAction,
  OperatorAuditRow,
  SessionRow,
  SSO_AUDIT_ACTIONS,
  UserRow,
} from "../../schema.js";
import type { StorageAdapter } from "../../storage/port.js";
import { HookStop, hookGuard, runAfter, runBefore } from "../hooks.js";
import { endFamilies, type FamilyEnds, familyEnds } from "../oauth-family.js";
import { endedList } from "../sessions.js";
import { checkActor, type OperatorActor, requireScope } from "./guards.js";

// The reason rule lives in the entry @authtempo/core/operator-secret, so the CLI reads the same rule (ruling 40).
export { REASON_MAX } from "../../operator-secret.js";
// The event table reads the list too, so it lives in a file with no runtime import (plan 12h).
export { OPERATOR_ACTIONS } from "./actions.js";

/** The longest user agent of a row, in code points (spec 26 item 8). */
export const USER_AGENT_MAX = 512;

/**
 * The longest IP of a row: 45 characters, an IPv6 address with an IPv4 tail
 * (RFC 4291 section 2.2). The route gives the IP of `clientIp`, and an
 * in-process caller gives any string (plan 12f, final review L2).
 */
export const AUDIT_IP_MAX = 45;

/**
 * The IP of a row: the input when it is an IP literal (`isIpLiteral`) of at
 * most `AUDIT_IP_MAX` characters, else null. A literal holds only hex
 * digits, dots, and colons, so no text of the caller reaches a reader of
 * the audit. A cut IP would name another host, so the rule keeps the whole
 * value or none of it. No IP literal is longer than 45 characters, so the
 * length check changes no answer: it spares the URL parse of a long string.
 */
function auditIp(ip: string | null): string | null {
  return ip !== null && ip.length <= AUDIT_IP_MAX && isIpLiteral(ip) ? ip : null;
}

/**
 * `String.prototype.toWellFormed` of ES2024: each lone surrogate becomes
 * U+FFFD. Node 20 and Workers have it; the lib of this build is ES2023.
 */
function wellFormed(s: string): string {
  return (s as string & { toWellFormed(): string }).toWellFormed();
}

/** The page size of `listAudit`: 1 to 100 rows, 50 by default. */
const PAGE = { default: 50, max: 100 };

/** The longest cursor and target id. A core id is 26 characters. */
const ID_MAX = 64;

/**
 * An audit row before its insert: the row with no id and no times. The
 * caller builds it with `auditDraft`. `data` holds flags, ids, and dates,
 * never an address, a secret, or a token. `ip` and `userAgent` are the
 * operator's, never the target user's.
 */
export interface OperatorAuditDraft {
  actorKind: OperatorAuditRow["actorKind"];
  actorId: string;
  action: OperatorAction;
  targetUserId: string | null;
  reason: string;
  data: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * The reason of an operator act (ASVS 16.4.1). It answers `invalid_body`
 * for a value that is not a string, and for an empty string. It answers
 * the same for a string longer than `REASON_MAX`, with a control
 * character, or with a lone surrogate. No trim: the row keeps the text as
 * the operator wrote it.
 */
export function operatorReason(raw: unknown): Result<string> {
  return typeof raw === "string" && isOperatorReason(raw) ? ok(raw) : fail("invalid_body");
}

/**
 * The actor of an audit row. A user actor needs the user id only. The stop
 * of an impersonation (plan 12f Task 11) names the operator of the session
 * row, and it does not read the operator's user row.
 */
export type AuditActor = OperatorActor | { kind: "user"; user: Pick<UserRow, "id"> };

/**
 * The draft of one act. The actor is named by the secret's name, the user
 * id, or the app's name, never by a secret. An app name outside the rule of
 * `checkActor` answers `invalid_body`. The user agent first turns each lone
 * surrogate into U+FFFD (`toWellFormed`), so the row shows that one was
 * there. Then it loses each character of `hasRefusedChar` and is cut to
 * `USER_AGENT_MAX` code points, so the cut splits no character. The IP
 * follows `auditIp`.
 */
export function auditDraft(
  actor: AuditActor,
  input: {
    action: OperatorAction;
    targetUserId: string | null;
    reason: string;
    data: Record<string, unknown> | null;
    ip: string | null;
    userAgent: string | null;
  },
): Result<OperatorAuditDraft> {
  const named = actor.kind === "app" ? checkActor(actor) : ok(true);
  if (!named.ok) return named;
  const actorId = actor.kind === "user" ? actor.user.id : actor.name;
  const userAgent =
    input.userAgent === null
      ? null
      : Array.from(removeRefusedChars(wellFormed(input.userAgent)))
          .slice(0, USER_AGENT_MAX)
          .join("");
  return ok({
    actorKind: actor.kind,
    actorId,
    action: input.action,
    targetUserId: input.targetUserId,
    reason: input.reason,
    data: input.data,
    ip: auditIp(input.ip),
    userAgent,
  });
}

/**
 * What the work of an act collects for the steps after the commit (ruling
 * 2). `ended` holds the ended sessions for `session.afterEnd`; it is
 * undefined when no hook listens. `families` holds the OAuth families that
 * the deletes of the work noted.
 */
export interface OperatorActEnds {
  ended: SessionRow[] | undefined;
  families: FamilyEnds;
}

/** The act's own steps after the commit. */
export interface OperatorActSteps<T> {
  /**
   * Runs after the commit and before `afterAction`: `sessionsEnded`, the
   * notice, and the user hooks, in that order. No act sends a back-channel
   * logout here: the sweep sends the outbox rows (ruling 37 of plan 12f).
   * The act is committed, so a throw writes one log line and the act stays.
   */
  committed?(value: T, ends: OperatorActEnds): Promise<void>;
  /**
   * True: a throw of `endFamilies` writes one log line, and the answer holds
   * `familyEndFailed: true` in place of the throw (ruling 37 of plan 12f).
   * The act committed, so a throw would answer an error for a done act.
   * A storage limit after the commit, such as query 51 on D1 Free, is such
   * a throw. Default false: the throw passes on.
   */
  answerFamilyEnd?: boolean;
}

/**
 * The one writer of an audit row (deviation 3 of plan 12d). `operatorAct`,
 * `writeStopRow`, and each act of plan 12d call it on the handle of their
 * own transaction, as its last statement. So the act commits with its row,
 * or neither commits, and the writers cannot drift. The row id is a
 * monotonic ULID of `now`, so the rows list in the order of their writes.
 */
export async function writeAuditIn(
  tx: StorageAdapter,
  draft: OperatorAuditDraft,
  now: Date,
): Promise<OperatorAuditRow> {
  // The draft first, so no field of it can replace the id or the times.
  return tx.create("operatorAudit", {
    ...draft,
    id: newMonotonicId(now),
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * The fixed reason of each audit action of plan 12d (deviation 3). An owner
 * or a directory gives no reason, so the row holds this text. The text of
 * `sso_enforce_off` is never written: the operator gives the reason of that
 * act through `operatorAct`.
 */
export const SSO_AUDIT_REASON: Readonly<Record<(typeof SSO_AUDIT_ACTIONS)[number], string>> = {
  sso_connection_create: "an organization added an SSO connection",
  sso_connection_update: "an organization changed an SSO connection",
  sso_connection_delete: "an organization deleted an SSO connection",
  sso_domain_add: "an organization asked to prove a domain",
  sso_domain_verify: "an organization proved a domain by DNS",
  sso_domain_update: "an organization changed a domain",
  sso_domain_delete: "an organization deleted a domain",
  sso_domain_lost: "the recheck no longer found the DNS proof of a domain",
  sso_enforce_off: "an operator turned enforce off",
  scim_token_create: "an organization created a SCIM token",
  scim_token_revoke: "an organization revoked a SCIM token",
  scim_user_create: "a directory created a user",
  scim_user_update: "a directory changed a user",
  scim_user_deactivate: "a directory deactivated a user",
  scim_user_delete: "a directory deleted a user",
  scim_group_create: "a directory created a group",
  scim_group_update: "a directory changed a group",
  scim_group_delete: "a directory deleted a group",
};

/**
 * The one way an operator write runs (spec 26 items 8 and 10). First
 * `operatorReason` on the draft's reason: a refusal answers `invalid_body`
 * and writes nothing (spec 26 item 5). Then
 * `hooks.operator.beforeAction`: a refusal answers `hook_refused` and
 * writes nothing. Then one transaction runs `work`, and the audit row is
 * its last statement. An error answer of `work` throws out of the
 * transaction (the `hookGuard` pattern). So no write of the act stays, and
 * no row is written. Any other throw passes to the caller, also after the
 * undo. So the act commits with its row, or neither commits.
 *
 * After the commit, three steps run in the order of ruling 2 of plan 12f.
 * The act's `committed` step runs first, then `afterAction` with the
 * stored row. `endFamilies` runs last (ruling 45 of plan 12e). A throw of `afterAction`
 * writes one log line and the act stays; so does a throw of the step. The
 * answer is the work's value with `auditId`.
 */
export async function operatorAct<T extends object>(
  config: ResolvedConfig,
  draft: OperatorAuditDraft,
  work: (
    tx: StorageAdapter,
    draft: OperatorAuditDraft,
    ends: OperatorActEnds,
  ) => Promise<Result<T>>,
  steps: OperatorActSteps<T> = {},
): Promise<Result<T & { auditId: string; familyEndFailed?: true }>> {
  const reason = operatorReason(draft.reason);
  if (!reason.ok) return reason;
  const ends: OperatorActEnds = { ended: endedList(config), families: familyEnds() };
  const before = await hookGuard(async () => {
    await runBefore(config.observe, "operator.beforeAction", config.hooks.operator.beforeAction, {
      audit: draft,
    });
    return ok(true);
  });
  if (!before.ok) {
    if (before.code === "hook_refused")
      config.observe.emit({
        name: "operator.refused",
        action: draft.action,
        actorKind: draft.actorKind,
        code: before.code,
      });
    return before;
  }
  const done = await hookGuard(async () => {
    return config.storage.transaction(async (tx) => {
      const answer = await work(tx, draft, ends);
      if (!answer.ok) throw new HookStop(answer);
      const row = await writeAuditIn(tx, draft, config.clock.now());
      return ok({ value: answer.value, row });
    });
  });
  if (!done.ok) return done;
  const { value, row } = done.value;
  let familyEndFailed = false;
  try {
    await steps.committed?.(value, ends);
  } catch (e) {
    config.observe.emit({ name: "operator.step_failed", rowId: row.id, errorName: e });
  } finally {
    // endFamilies is a security step: it ends a refresh family that a race
    // wrote during the act. So it runs after any end of the step.
    await operatorActed(config, row);
    if (steps.answerFamilyEnd)
      try {
        await endFamilies(config, ends.families);
      } catch (e) {
        config.observe.emit({ name: "operator.family_end_failed", rowId: row.id, errorName: e });
        familyEndFailed = true;
      }
    else await endFamilies(config, ends.families);
  }
  return ok({ ...value, auditId: row.id, ...(familyEndFailed ? { familyEndFailed: true } : {}) });
}

/**
 * The steps of one committed audit row: `operator.afterAction`, and the
 * event `operator.action` beside it (plan 12h Task 6). The event is not the
 * record: the row is (spec 31 item 14).
 */
export async function operatorActed(config: ResolvedConfig, row: OperatorAuditRow): Promise<void> {
  await runAfter(
    config.observe,
    "operator.afterAction",
    config.hooks.operator.afterAction,
    { audit: row },
    row.id,
  );
  config.observe.emit({
    name: "operator.action",
    action: row.action,
    actorKind: row.actorKind,
    auditId: row.id,
  });
}

/**
 * Why an impersonation session ended, for its `impersonation_stop` row
 * (ruling 43 of plan 12f). `stop` is the stop act. An expiry writes no row
 * (spec 26 item 9): the start row holds `expiresAt`.
 */
export type StopCause =
  | "stop"
  | "user_end"
  | "sign_out"
  | "claim"
  | "ban"
  | "revoke"
  | "role_loss"
  | "account_delete"
  | "operator_end"
  | "deprovision";

/**
 * The fixed reason of each stop row that a flow writes. The stop act keeps
 * its own reason, so it has none here.
 */
const STOP_REASONS: Readonly<Record<Exclude<StopCause, "stop">, string>> = {
  user_end: "The user ended the impersonation session.",
  sign_out: "A sign-out ended the impersonation session.",
  claim: "A claim of the address ended the impersonation session.",
  ban: "A ban ended the impersonation session.",
  revoke: "A revoke of the platform role ended the impersonation session.",
  role_loss: "A change of the operator's platform role ended the impersonation session.",
  account_delete: "An account delete ended the impersonation session.",
  operator_end: "An operator ended the sessions, and the impersonation session with them.",
  deprovision: "A deactivate by the organization's directory ended the impersonation session.",
};

/**
 * The stop rows of one flow (ruling 43 of plan 12f). The flow makes it with
 * `impersonationStops`, and each end of an impersonation session in the
 * flow's transaction adds its row here. After the commit, `sessionsEnded`
 * runs `afterAction` once per row.
 */
export interface ImpersonationStops {
  readonly cause: Exclude<StopCause, "stop">;
  readonly rows: OperatorAuditRow[];
}

/**
 * The stop rows of a flow, or null while `operator.impersonation` is off.
 * With null, no end reads the impersonation sessions, so the tool costs
 * nothing while it is off.
 */
export function impersonationStops(
  config: Partial<Pick<ResolvedConfig, "operator">>,
  cause: Exclude<StopCause, "stop">,
): ImpersonationStops | null {
  return config.operator?.impersonation ? { cause, rows: [] } : null;
}

/**
 * The `impersonation_stop` row of one impersonation session that the flow
 * ended, on the flow's handle (ruling 43 of plan 12f). The actor is the
 * operator of the session, the target is its user, and `data` holds
 * `{ sessionId, cause }`. A session with no `actorId` writes nothing.
 *
 * The row's time is `now`, the time of the writer. The sweep writes the
 * rows of the sessions that the cascade of a user delete took (decision 5
 * of plan 12o). It passes `endedAt`, the time of the delete, and `data`
 * holds it too.
 */
export async function writeStopRow(
  tx: StorageAdapter,
  stops: ImpersonationStops,
  session: Pick<SessionRow, "id" | "userId" | "actorId">,
  now: Date,
  endedAt?: string,
): Promise<void> {
  if (session.actorId === null) return;
  const row = await writeAuditIn(
    tx,
    {
      actorKind: "user",
      actorId: session.actorId,
      action: "impersonation_stop",
      targetUserId: session.userId,
      reason: STOP_REASONS[stops.cause],
      data: {
        sessionId: session.id,
        cause: stops.cause,
        ...(endedAt === undefined ? {} : { endedAt }),
      },
      ip: null,
      userAgent: null,
    },
    now,
  );
  stops.rows.push(row);
}

/**
 * The ids of the sessions of `userId` that an `impersonation_stop` row
 * names, of the rows written at or after `since` (ruling 19 of plan 12o).
 * One read by the index on `targetUserId` takes the newest `limit` rows. The
 * sweep reads them for a pending-end row that owes stop rows. So it writes no
 * second row for a session that another flow ended after the delete's read.
 */
export async function stoppedSessions(
  storage: StorageAdapter,
  userId: string,
  since: Date,
  limit: number,
): Promise<Set<string>> {
  const rows = await storage.findMany(
    "operatorAudit",
    [
      { field: "targetUserId", op: "eq", value: userId },
      { field: "action", op: "eq", value: "impersonation_stop" },
      { field: "createdAt", op: "gte", value: since },
    ],
    { sort: { field: "id", dir: "desc" }, limit },
  );
  const ids = new Set<string>();
  for (const row of rows) {
    const id = row.data?.sessionId;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/**
 * The users whose impersonation `operatorId` started at or after `since`.
 * They are the `targetUserId` of each `impersonation_start` row of that
 * user actor, read by the index on `actorId` (plan 12f Task 11, ruling 31).
 * This file stays the one reader of the audit table.
 */
export async function impersonationTargets(
  storage: StorageAdapter,
  operatorId: string,
  since: Date,
): Promise<string[]> {
  const starts = await storage.findMany(
    "operatorAudit",
    [
      { field: "actorId", op: "eq", value: operatorId },
      { field: "actorKind", op: "eq", value: "user" },
      { field: "action", op: "eq", value: "impersonation_start" },
      { field: "createdAt", op: "gte", value: since },
    ],
    { sort: { field: "id", dir: "asc" } },
  );
  const targets = new Set<string>();
  for (const row of starts) if (row.targetUserId !== null) targets.add(row.targetUserId);
  return [...targets].sort();
}

/** An optional id input: absent, or a string of 1 to `ID_MAX` characters with no control character. */
function idInput(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= ID_MAX &&
      !hasControlChar(value))
  );
}

/**
 * The audit rows, oldest first, by `id` ascending. The id is a monotonic
 * ULID (`newMonotonicId`), so the rows of one isolate list in the order of
 * their writes, also inside one millisecond. The rows of two isolates in
 * one millisecond have no defined order between them. `targetUserId`
 * reads one user's rows through its index.
 * `after` is the `next` of the page before. `limit` is 1 to 100, default
 * 50. `next` is the last id when the page is full, else null; so one
 * empty page comes after a full last page. Needs `operator.users` (else
 * `not_found`, as the user reads), an actor that passes `checkActor`, and
 * the scope `audit`.
 */
export async function listAudit(
  config: ResolvedConfig,
  input: { actor: OperatorActor; targetUserId?: string; after?: string; limit?: number },
): Promise<Result<{ rows: OperatorAuditRow[]; next: string | null }>> {
  if (!config.operator?.users) return fail("not_found");
  const named = checkActor(input.actor);
  if (!named.ok) return named;
  const scoped = requireScope(input.actor, "audit");
  if (!scoped.ok) return scoped;
  const limit = input.limit ?? PAGE.default;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE.max) return fail("invalid_body");
  if (!idInput(input.targetUserId) || !idInput(input.after)) return fail("invalid_body");
  const rows = await config.storage.findMany(
    "operatorAudit",
    [
      ...(input.targetUserId === undefined
        ? []
        : [{ field: "targetUserId" as const, op: "eq" as const, value: input.targetUserId }]),
      ...(input.after === undefined
        ? []
        : [{ field: "id" as const, op: "gt" as const, value: input.after }]),
    ],
    { sort: { field: "id", dir: "asc" }, limit },
  );
  return ok({ rows, next: rows.length === limit ? (rows.at(-1)?.id ?? null) : null });
}
