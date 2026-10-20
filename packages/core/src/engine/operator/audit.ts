import type { ResolvedConfig } from "../../config.js";
import { isOperatorReason } from "../../operator-secret.js";
import { appErrorName } from "../../primitives/app-error.js";
import { newId } from "../../primitives/ids.js";
import { hasControlChar, removeControlChars } from "../../primitives/text.js";
import { fail, ok, type Result } from "../../result.js";
import type { OperatorAction, OperatorAuditRow, SessionRow, UserRow } from "../../schema.js";
import type { StorageAdapter } from "../../storage/port.js";
import { HookStop, hookGuard, runAfter, runBefore } from "../hooks.js";
import { endFamilies, type FamilyEnds, familyEnds } from "../oauth-family.js";
import { endedList } from "../sessions.js";
import { checkActor, type OperatorActor, requireScope } from "./guards.js";

/**
 * Every action of an audit row (spec 26 item 8). A Record, so a value added
 * to `OperatorAction` and not listed here fails the compile.
 */
const ACTIONS: Readonly<Record<OperatorAction, true>> = {
  ban: true,
  unban: true,
  platform_role_grant: true,
  platform_role_revoke: true,
  second_factor_disable: true,
  sessions_end_user: true,
  sessions_end_all: true,
  impersonation_start: true,
  impersonation_stop: true,
  create_admin: true,
};

export const OPERATOR_ACTIONS: readonly OperatorAction[] = Object.freeze(
  Object.keys(ACTIONS) as OperatorAction[],
);

// The reason rule lives in the entry @authtempo/core/operator-secret, so the CLI reads the same rule (ruling 40).
export { REASON_MAX } from "../../operator-secret.js";

/** The longest user agent of a row, in code points (spec 26 item 8). */
export const USER_AGENT_MAX = 512;

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
 * The actor of an audit row. A user actor needs the user id only: the stop
 * of an impersonation (plan 12f Task 11) names the operator of the session
 * row, whose user row it does not read.
 */
export type AuditActor = OperatorActor | { kind: "user"; user: Pick<UserRow, "id"> };

/**
 * The draft of one act. The actor is named by the secret's name, the user
 * id, or the app's name, never by a secret. An app name outside the rule of
 * `checkActor` answers `invalid_body`. The user agent loses each control
 * character and is cut to `USER_AGENT_MAX` code points, so the cut splits
 * no character.
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
      : Array.from(removeControlChars(input.userAgent)).slice(0, USER_AGENT_MAX).join("");
  return ok({
    actorKind: actor.kind,
    actorId,
    action: input.action,
    targetUserId: input.targetUserId,
    reason: input.reason,
    data: input.data,
    ip: input.ip,
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
  const done = await hookGuard(async () => {
    await runBefore("operator.beforeAction", config.hooks.operator.beforeAction, {
      audit: draft,
    });
    return config.storage.transaction(async (tx) => {
      const answer = await work(tx, draft, ends);
      if (!answer.ok) throw new HookStop(answer);
      const now = config.clock.now();
      // The draft first, so no field of it can replace the id or the times.
      const row = await tx.create("operatorAudit", {
        ...draft,
        id: newId(now),
        createdAt: now,
        updatedAt: now,
      });
      return ok({ value: answer.value, row });
    });
  });
  if (!done.ok) return done;
  const { value, row } = done.value;
  let familyEndFailed = false;
  try {
    await steps.committed?.(value, ends);
  } catch (e) {
    console.error("authtempo: operator step failed", row.id, appErrorName(e));
  } finally {
    // endFamilies is a security step: it ends a refresh family that a race
    // wrote during the act. So it runs after any end of the step.
    await runAfter(
      "operator.afterAction",
      config.hooks.operator.afterAction,
      { audit: row },
      row.id,
    );
    if (steps.answerFamilyEnd)
      try {
        await endFamilies(config, ends.families);
      } catch (e) {
        console.error("authtempo: operator family end failed", row.id, appErrorName(e));
        familyEndFailed = true;
      }
    else await endFamilies(config, ends.families);
  }
  return ok({ ...value, auditId: row.id, ...(familyEndFailed ? { familyEndFailed: true } : {}) });
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
 * The audit rows, oldest first, by `id` ascending (a ULID, so the order of
 * the writes). `targetUserId` reads one user's rows through its index.
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
