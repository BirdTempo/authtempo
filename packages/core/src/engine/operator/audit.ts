import type { ResolvedConfig } from "../../config.js";
import { isIpLiteral } from "../../limiter/ip-key.js";
import { isOperatorReason } from "../../operator-secret.js";
import { newMonotonicId } from "../../primitives/ids.js";
import { hasControlChar, removeRefusedChars } from "../../primitives/text.js";
import { fail, ok, type Result } from "../../result.js";
import {
  type OperatorAction,
  type OperatorAuditRow,
  type ORGANIZATION_AUDIT_ACTIONS,
  ORGANIZATION_VISIBLE_ACTIONS,
  type SessionRow,
  type SSO_AUDIT_ACTIONS,
  type UserRow,
} from "../../schema.js";
import { findManyIn } from "../../storage/batch.js";
import type { StorageAdapter } from "../../storage/port.js";
import { HookStop, hookGuard, runAfter, runBefore } from "../hooks.js";
import { endFamilies, type FamilyEnds, familyEnds } from "../oauth-family.js";
// organizations.ts imports this file too. The cycle is safe: each side reads the other only
// inside a function, never at module load.
import { standing } from "../organizations.js";
import { endedList, type ResolvedSession } from "../sessions.js";
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
  /** The organization of the act (plan 13b). Null for an operator act on a user. */
  organizationId: string | null;
}

/**
 * One row of the organization audit, as `GET /organizations/audit` answers it (plan 13b).
 * `ip` and `userAgent` are null for each actor but a member.
 */
export interface OrganizationAuditView {
  id: string;
  /** `createdAt`, ISO. */
  at: string;
  actor: { kind: "member" | "platform" | "scim" | "app"; id: string | null; email: string | null };
  action: string;
  targetUserId: string | null;
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
  return ok({
    actorKind: actor.kind,
    actorId,
    action: input.action,
    targetUserId: input.targetUserId,
    reason: input.reason,
    data: input.data,
    ip: auditIp(input.ip),
    userAgent: auditUserAgent(input.userAgent),
    // An operator act on a user names no organization (plan 13b, owner decision 4).
    // `organizationAuditDraft` sets it for an act of an organization.
    organizationId: null,
  });
}

/** The user agent of a row: the rule of `auditDraft`. */
function auditUserAgent(userAgent: string | null): string | null {
  return userAgent === null
    ? null
    : Array.from(removeRefusedChars(wellFormed(userAgent)))
        .slice(0, USER_AGENT_MAX)
        .join("");
}

/**
 * The actions of an act of an organization that have a fixed reason (plan 13b). The operator
 * gives the reason of `sso_enforce_off`, so it is not one of them.
 */
export type OrganizationAuditAction = Exclude<
  (typeof ORGANIZATION_VISIBLE_ACTIONS)[number],
  "sso_enforce_off"
>;

/**
 * The draft of one act of an organization (plan 13b Task 3). The row names the organization in
 * its column, and the reason is the fixed text of the action. A SCIM token is named by its
 * name. `platform` marks the act of a platform operator through the manager guard: such a row
 * has the actor kind `user`, so `data.platform: true` tells the organization audit that the
 * actor is no member. The flag goes only on a user actor. An app name outside the rule of
 * `checkActor` answers `invalid_body`. The IP and the user agent follow `auditDraft`.
 */
export function organizationAuditDraft(
  actor: AuditActor | { kind: "scim"; tokenName: string },
  organizationId: string,
  input: {
    action: OrganizationAuditAction;
    targetUserId: string | null;
    data: Record<string, unknown> | null;
    ip: string | null;
    userAgent: string | null;
    platform?: boolean;
  },
): Result<OperatorAuditDraft> {
  const { platform, ...fields } = input;
  const reason = ORGANIZATION_ROW_REASON[input.action];
  const data =
    platform === true && actor.kind === "user" ? { ...fields.data, platform: true } : fields.data;
  if (actor.kind === "scim")
    return ok({
      actorKind: "scim",
      actorId: actor.tokenName,
      action: fields.action,
      targetUserId: fields.targetUserId,
      reason,
      data,
      ip: auditIp(fields.ip),
      userAgent: auditUserAgent(fields.userAgent),
      organizationId,
    });
  const draft = auditDraft(actor, { ...fields, reason, data });
  return draft.ok ? ok({ ...draft.value, organizationId }) : draft;
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
 * The statements of `writeAuditRowsIn` for `rows` rows: 0 for none, else one
 * for each `rowsPerInsert` rows of the audit model. On D1 that is 1 for 1 to
 * 1000 rows (`INSERT_ROWS_MAX`). The account delete counts it in its size
 * check before the first write (plan 13c Task 2). It lives here, so the model
 * name stays in this file (`NAMED_IN` of operator-audit-source.test.ts).
 */
export function auditInsertCalls(tx: StorageAdapter, rows: number): number {
  return rows === 0 ? 0 : Math.ceil(rows / tx.rowsPerInsert("operatorAudit"));
}

/**
 * The writer of many audit rows of one act, by the rule of `writeAuditIn`
 * (plan 13c Task 2). One `createMany` sends the statements that
 * `auditInsertCalls` counts, and an empty list sends none. The ids are
 * monotonic ULIDs of `now` in the order of `drafts`.
 */
export async function writeAuditRowsIn(
  tx: StorageAdapter,
  drafts: readonly OperatorAuditDraft[],
  now: Date,
): Promise<void> {
  if (drafts.length === 0) return;
  // The draft first, so no field of it can replace the id or the times.
  await tx.createMany(
    "operatorAudit",
    drafts.map((draft) => ({ ...draft, id: newMonotonicId(now), createdAt: now, updatedAt: now })),
  );
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
  // Plan 13a: the setup link and the test run.
  sso_setup_link_create: "an organization created an SSO setup link",
  sso_setup_link_open: "an IT admin opened an SSO setup link",
  sso_setup_link_revoke: "an organization revoked an SSO setup link",
  sso_setup_link_activate: "an organization activated an SSO setup",
  sso_test_run: "a test sign-in ran against a draft SSO connection",
  // Plan 13b (owner decision 1): the hand back.
  sso_setup_link_ready: "an IT admin handed an SSO setup back to the owners",
};

/**
 * The fixed reason of each audit action of an organization act (plan 13b). A member gives no
 * reason, so the row holds this text.
 */
export const ORGANIZATION_AUDIT_REASON: Readonly<
  Record<(typeof ORGANIZATION_AUDIT_ACTIONS)[number], string>
> = {
  organization_member_add: "an organization added a member",
  organization_member_remove: "an organization removed a member",
  organization_member_role_change: "an organization changed the role of a member",
  organization_invitation_create: "an organization invited a person",
  organization_invitation_accept: "a person accepted an invitation",
  organization_invitation_revoke: "an organization revoked an invitation",
  organization_token_create: "an organization created a token",
  organization_token_revoke: "an organization revoked a token",
  organization_role_create: "an organization created a role",
  organization_role_update: "an organization changed a role",
  organization_role_delete: "an organization deleted a role",
};

/** The fixed reason of each action of `organizationAuditDraft`. */
const ORGANIZATION_ROW_REASON: Readonly<Record<OrganizationAuditAction, string>> = {
  ...SSO_AUDIT_REASON,
  ...ORGANIZATION_AUDIT_REASON,
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
      // An operator act on a user names no organization (plan 13b).
      organizationId: null,
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
 * empty page comes after a full last page. `organizationId` reads the rows
 * of one organization through its index (plan 13b); an operator act on a
 * user names no organization, so the filter leaves it out. Needs
 * `operator.users` (else `not_found`, as the user reads), an actor that
 * passes `checkActor`, and the scope `audit`.
 */
export async function listAudit(
  config: ResolvedConfig,
  input: {
    actor: OperatorActor;
    targetUserId?: string;
    organizationId?: string;
    after?: string;
    limit?: number;
  },
): Promise<Result<{ rows: OperatorAuditRow[]; next: string | null }>> {
  if (!config.operator?.users) return fail("not_found");
  const named = checkActor(input.actor);
  if (!named.ok) return named;
  const scoped = requireScope(input.actor, "audit");
  if (!scoped.ok) return scoped;
  const limit = input.limit ?? PAGE.default;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE.max) return fail("invalid_body");
  if (!idInput(input.targetUserId) || !idInput(input.organizationId) || !idInput(input.after))
    return fail("invalid_body");
  const rows = await config.storage.findMany(
    "operatorAudit",
    [
      ...(input.targetUserId === undefined
        ? []
        : [{ field: "targetUserId" as const, op: "eq" as const, value: input.targetUserId }]),
      ...(input.organizationId === undefined
        ? []
        : [{ field: "organizationId" as const, op: "eq" as const, value: input.organizationId }]),
      ...(input.after === undefined
        ? []
        : [{ field: "id" as const, op: "gt" as const, value: input.after }]),
    ],
    { sort: { field: "id", dir: "asc" }, limit },
  );
  return ok({ rows, next: rows.length === limit ? (rows.at(-1)?.id ?? null) : null });
}

/** A date input: absent, or a valid `Date`. */
function dateInput(value: unknown): boolean {
  return value === undefined || (value instanceof Date && !Number.isNaN(value.getTime()));
}

/** True for the act of a member: a user actor with no `data.platform` flag (plan 13b). */
function memberAct(row: OperatorAuditRow): boolean {
  return row.actorKind === "user" && row.data?.platform !== true;
}

/**
 * The view of one row for the members of its organization (plan 13b, the view rule of Task 6).
 * A member act shows the user id, the current address, the IP, and the user agent. `email` is
 * null when the user row is gone; the row stays. The organization sees no detail of the
 * platform: the act of a platform operator (`data.platform`) and of an operator secret shows
 * `platform` with no id, no IP, and no user agent. A directory act shows the token name, and an
 * app act the app name, with no IP and no user agent.
 */
function organizationView(
  row: OperatorAuditRow,
  emails: ReadonlyMap<string, string | null>,
): OrganizationAuditView {
  const member = memberAct(row);
  const actor: OrganizationAuditView["actor"] = member
    ? { kind: "member", id: row.actorId, email: emails.get(row.actorId) ?? null }
    : row.actorKind === "scim" || row.actorKind === "app"
      ? { kind: row.actorKind, id: row.actorId, email: null }
      : { kind: "platform", id: null, email: null };
  return {
    id: row.id,
    at: row.createdAt.toISOString(),
    actor,
    action: row.action,
    targetUserId: row.targetUserId,
    data: row.data,
    ip: member ? row.ip : null,
    userAgent: member ? row.userAgent : null,
  };
}

/**
 * The audit rows of one organization, oldest first, for its members (plan 13b Task 6). The
 * caller needs `audit:read` in the organization: the owner of the `ranks` form, or a role of the
 * `roles` form that lists it. A missing organization answers `not_found`, and a non-member or a
 * missing permission `forbidden_rank`, as `GET /organizations/invitations` does.
 *
 * One read takes `limit + 1` rows through the index `[organizationId, id]`. `next` is the last id
 * of the page only when one more row exists, so no empty page comes after the last one. `action`,
 * `from` (inclusive), and `to` (exclusive) narrow the read. A row with a null `organizationId`
 * (a row of version 17 or older) is never in the answer. Then one read of the users of the
 * member actors (`findManyIn`, 50 ids for each statement) gives each current address.
 * `limit` is 1 to 100, default 50; a bad input answers `invalid_body`.
 */
export async function listOrganizationAudit(
  config: ResolvedConfig,
  input: {
    session: Pick<ResolvedSession, "user" | "session">;
    organizationId: string;
    after?: string;
    limit?: number;
    action?: string;
    from?: Date;
    to?: Date;
  },
): Promise<Result<{ rows: OrganizationAuditView[]; next: string | null }>> {
  if (!config.organizations) return fail("not_found");
  const limit = input.limit ?? PAGE.default;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE.max) return fail("invalid_body");
  if (input.organizationId === undefined || !idInput(input.organizationId))
    return fail("invalid_body");
  if (!idInput(input.after) || !dateInput(input.from) || !dateInput(input.to))
    return fail("invalid_body");
  const visible: readonly string[] = ORGANIZATION_VISIBLE_ACTIONS;
  if (input.action !== undefined && !visible.includes(input.action)) return fail("invalid_body");
  const { from, to } = input;
  if (from !== undefined && to !== undefined && from.getTime() >= to.getTime())
    return fail("invalid_body");
  const s = await standing(config, input.session.user, input.organizationId, { audit: ["read"] });
  if (!s.ok) return s;
  const read = await config.storage.findMany(
    "operatorAudit",
    [
      { field: "organizationId", op: "eq", value: input.organizationId },
      ...(input.after === undefined
        ? []
        : [{ field: "id" as const, op: "gt" as const, value: input.after }]),
      ...(input.action === undefined
        ? []
        : [{ field: "action" as const, op: "eq" as const, value: input.action }]),
      ...(from === undefined
        ? []
        : [{ field: "createdAt" as const, op: "gte" as const, value: from }]),
      ...(to === undefined ? [] : [{ field: "createdAt" as const, op: "lt" as const, value: to }]),
    ],
    { sort: { field: "id", dir: "asc" }, limit: limit + 1 },
  );
  const rows = read.slice(0, limit);
  const memberIds = rows.filter(memberAct).map((r) => r.actorId);
  const users = await findManyIn(config.storage, "user", "id", memberIds);
  const emails = new Map(users.map((u) => [u.id, u.email]));
  return ok({
    rows: rows.map((r) => organizationView(r, emails)),
    next: read.length > limit ? (rows.at(-1)?.id ?? null) : null,
  });
}
