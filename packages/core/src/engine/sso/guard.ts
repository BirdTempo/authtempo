import type { ResolvedConfig } from "../../config.js";
import { fail, ok, type Result } from "../../result.js";
import type { SessionRow, SSO_AUDIT_ACTIONS, UserRow } from "../../schema.js";
import {
  type AuditActor,
  auditDraft,
  type OperatorAuditDraft,
  SSO_AUDIT_REASON,
} from "../operator/audit.js";
import { isPlatformOperator, requireOperatorUser } from "../operator/guards.js";
import type { ResolvedSession } from "../sessions.js";

/**
 * Who manages the SSO setup of an organization (plan 12d deviation 4). The
 * app in process, or a platform operator with the session of the request.
 * Task 3 of plan 12d adds the owner of the organization.
 */
export type SsoActor =
  | { kind: "app"; name: string }
  | { kind: "platform"; user: UserRow; session: SessionRow };

/** One log line per refusal, with the step name and no user id (plan 12d Task 3 form). */
function refused(step: string): Result<never> {
  console.error("authtempo: sso guard refused", step);
  return fail("forbidden_rank");
}

/**
 * The manager guard of the SSO routes. Until Task 3 of plan 12d it passes a
 * platform operator only, through `requireOperatorUser`, for every
 * organization. An impersonation session answers `forbidden_rank`: an
 * operator who acts as a user must not add an IdP. Any other caller answers
 * `forbidden_rank`. A platform operator who fails a step of the operator
 * guard gets its answer, `operator_required` or `rate_limited`. The
 * platform read comes first, so a caller who is no operator writes no line
 * of the operator guard and spends no count of its limiter.
 * `organizationId` is the organization of the act; Task 3 reads it for the
 * owner form.
 */
export async function requireSsoManager(
  config: ResolvedConfig,
  resolved: ResolvedSession,
  _organizationId: string,
): Promise<Result<SsoActor>> {
  if (resolved.session.actorId !== null) return refused("impersonation");
  if (!(await isPlatformOperator(config, resolved.user.id))) return refused("rank");
  const operator = await requireOperatorUser(config, resolved, "sso");
  if (!operator.ok) return operator;
  return ok({ kind: "platform", user: operator.value.user, session: operator.value.session });
}

/**
 * The audit draft of one SSO act (plan 12d deviation 3). The reason is the
 * fixed text of the action. The app is named by its name, and a platform
 * operator by the user id. An app name outside the rule of `checkActor`
 * answers `invalid_body`.
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
