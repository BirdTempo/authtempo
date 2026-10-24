import type { ResolvedConfig } from "../../config.js";
import type { ErrorCode } from "../../errors.js";
import { fail, ok, type Result } from "../../result.js";
import type { SessionRow, SSO_AUDIT_ACTIONS, UserRow } from "../../schema.js";
import { requireFresh } from "../fresh.js";
import {
  type AuditActor,
  auditDraft,
  type OperatorAuditDraft,
  SSO_AUDIT_REASON,
} from "../operator/audit.js";
import { hasSecondFactor, isPlatformOperator, requireOperatorUser } from "../operator/guards.js";
import { isOwner } from "../organizations.js";
import { rankOf } from "../ranks.js";
import type { ResolvedSession } from "../sessions.js";
import type { SsoGuardStep } from "./steps.js";

/**
 * Who manages the SSO setup of an organization (plan 12d deviation 4): an
 * owner of the organization, a platform operator, or the app in process.
 */
export type SsoActor =
  | { kind: "owner"; user: UserRow; session: SessionRow }
  | { kind: "platform"; user: UserRow; session: SessionRow }
  | { kind: "app"; name: string };

/** One fault event per refusal, with the step name and no user id (plan 12d Task 3 form, plan 12h). */
function refused(
  config: ResolvedConfig,
  step: SsoGuardStep,
  code: ErrorCode = "forbidden_rank",
): Result<never> {
  config.observe.emit({ name: "sso.guard_refused", step });
  return fail(code);
}

/**
 * True when the user has a member row of the organization with a static
 * role of the owner rank. One role part of the row holds it: the rule of
 * plan 12k. `rankOf`
 * reads only the static ranks of the config, and a dynamic role never
 * reaches the owner rank.
 */
async function ownsOrganization(
  config: ResolvedConfig,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const o = config.organizations;
  if (!o) return false;
  const member = await config.storage.findOne("member", [
    { field: "organizationId", op: "eq", value: organizationId },
    { field: "userId", op: "eq", value: userId },
  ]);
  return member !== null && isOwner(o, rankOf(o.ranks, member.role));
}

/**
 * The manager guard of the SSO routes (plan 12d Task 3). The steps, in
 * this order:
 *
 * 1. An impersonation session answers `forbidden_rank`: an operator who
 *    acts as a user must not add an IdP.
 * 2. A platform operator who passes `requireOperatorUser` is the actor
 *    `platform`, for every organization. The platform read comes first.
 *    So a caller who is no operator writes no line of the operator guard
 *    and spends no count of its limiter. An operator who fails the operator
 *    guard and owns no organization of the act gets that guard's answer,
 *    `operator_required` or `rate_limited`.
 * 3. Else the user owns the organization, else `forbidden_rank`.
 * 4. The address is verified, else `email_unverified`. No flow of core
 *    makes a member with an unverified address, so this is a second guard.
 * 5. A second factor has a method, else `second_factor_required`.
 * 6. The session is fresh, else `session_not_fresh`.
 *
 * Each refusal of this guard emits `sso.guard_refused` with the step name
 * and no user id. The actor of steps 3 to 6 is `owner`.
 */
export async function requireSsoManager(
  config: ResolvedConfig,
  resolved: ResolvedSession,
  organizationId: string,
  route = "api",
): Promise<Result<SsoActor>> {
  const { user, session } = resolved;
  if (session.actorId !== null) return refused(config, "impersonation");
  if (await isPlatformOperator(config, user.id)) {
    // The route key of the request names the caller in the event of the operator guard (plan 12h).
    const operator = await requireOperatorUser(config, resolved, route);
    if (operator.ok)
      return ok({ kind: "platform", user: operator.value.user, session: operator.value.session });
    if (!(await ownsOrganization(config, user.id, organizationId))) return operator;
  } else if (!(await ownsOrganization(config, user.id, organizationId)))
    return refused(config, "rank");
  if (!user.emailVerified) return refused(config, "email", "email_unverified");
  if (!(await hasSecondFactor(config, user.id)))
    return refused(config, "second_factor", "second_factor_required");
  if (!requireFresh(config, session).ok) return refused(config, "fresh", "session_not_fresh");
  return ok({ kind: "owner", user, session });
}

/**
 * The audit draft of one SSO act (plan 12d deviation 3). The reason is the
 * fixed text of the action. The app is named by its name, and an owner or
 * a platform operator by the user id. An app name outside the rule of
 * `checkActor` answers `invalid_body`.
 */
export function ssoDraft(
  actor: SsoActor,
  action: (typeof SSO_AUDIT_ACTIONS)[number],
  input: {
    targetUserId: string | null;
    data: Record<string, unknown>;
    ip: string | null;
    userAgent: string | null;
  },
): Result<OperatorAuditDraft> {
  const by: AuditActor = actor.kind === "app" ? actor : { kind: "user", user: actor.user };
  return auditDraft(by, { action, reason: SSO_AUDIT_REASON[action], ...input });
}
