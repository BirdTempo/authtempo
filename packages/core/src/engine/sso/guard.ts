import type { ResolvedConfig } from "../../config.js";
import type { ErrorCode } from "../../errors.js";
import { fail, ok, type Result } from "../../result.js";
import type { SessionRow, SSO_AUDIT_ACTIONS, UserRow } from "../../schema.js";
import { requireFresh } from "../fresh.js";
import { sessionLive } from "../jwt.js";
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
 * Checks the actor of `requireSsoManager` again after a body read, before
 * the act (rulings 17 and 23 of plan 12l). A route above the floor runs the
 * guard before its body read, and that read can take up to 32 s. An owner
 * whom another owner removes in that time must not write. An owner whom an
 * operator bans, or who signs out, must not write either. So this check
 * reads the session and the right of the actor again, in this order:
 *
 * 1. The session of the actor must still be live (`sessionLive`: the
 *    session row, the ban, the revocation, and the door of an
 *    impersonation). A dead session answers `unauthorized` with no event,
 *    as a dead session at the start of a request does (ruling 23).
 * 2. An `owner` must still hold a member row of the owner rank in the
 *    organization (`ownsOrganization`, one read).
 * 3. A `platform` actor must still hold the platform role
 *    (`isPlatformOperator`, the platform organization and one member row).
 *
 * The `app` acts in process and never through a route, so it holds no
 * session and no row to lose. A revoke of the platform role ends the
 * sessions of the user, so step 1 answers it. A removal of the platform
 * member through `removeMember` keeps the sessions, so step 3 answers it.
 *
 * It counts no limit and runs no `requireOperatorUser`, so a platform
 * operator counts once on `operator:user`. A pass emits no event. A
 * refusal of steps 2 and 3 answers `forbidden_rank`. It emits
 * `sso.guard_refused` with the step `rank`, as the guard does for a caller
 * who owns nothing.
 */
export async function recheckSsoManager(
  config: ResolvedConfig,
  actor: SsoActor,
  organizationId: string,
): Promise<Result<true>> {
  if (actor.kind === "app") return ok(true);
  // A session that ended during the read answers 401, as at the start of a request (ruling 23).
  if (!(await sessionLive(config, { sid: actor.session.id }))) return fail("unauthorized");
  const holds =
    actor.kind === "owner"
      ? await ownsOrganization(config, actor.user.id, organizationId)
      : await isPlatformOperator(config, actor.user.id);
  return holds ? ok(true) : refused(config, "rank");
}

/**
 * The most member rows of the user that `requireSsoManagerOfAny` reads
 * (plan 12l). It is a bound of the pre-check, not a rule of the product.
 * A user can have more member rows, with no row of the owner rank among
 * the first 100 that the storage gives. That user gets `forbidden_rank` at
 * the pre-check, though `requireSsoManager` reads the one row of the
 * organization of the write. The reason: the pre-check runs before any
 * byte of a body, so it reads one page of rows, not every row of the user.
 * `organizations.limits.perUser` is off by default, so nothing else bounds
 * the rows of one user. Such a user writes through core's two connection
 * routes, whose query names the organization or the connection.
 */
export const SSO_PRECHECK_MEMBER_ROWS = 100;

/**
 * True when the user has a member row of the owner rank in one
 * organization or more. It applies the rule of `ownsOrganization` to at
 * most `SSO_PRECHECK_MEMBER_ROWS` rows.
 */
async function ownsSomeOrganization(config: ResolvedConfig, userId: string): Promise<boolean> {
  const o = config.organizations;
  if (!o) return false;
  const rows = await config.storage.findMany(
    "member",
    [{ field: "userId", op: "eq", value: userId }],
    { limit: SSO_PRECHECK_MEMBER_ROWS },
  );
  return rows.some((member) => isOwner(o, rankOf(o.ranks, member.role)));
}

/**
 * The pre-check of `requireSsoManager` for a write that names its row in
 * its body only (plan 12l, ruling 4 of its lane). Such writes are the
 * Better Auth paths of the compat shim. The body of `/sso/register` names
 * the organization. The body of `/sso/update-provider` names a provider,
 * and the organization comes from the connection of that provider. The
 * pre-check runs before the body read, so it does not know the
 * organization. It runs the steps of the guard that need no organization,
 * in the order of the guard, with its step names and codes:
 *
 * 1. An impersonation session answers `forbidden_rank`.
 * 2. In place of the step of the organization: the user is a platform
 *    operator, or owns one organization or more, else `forbidden_rank`.
 *    It reads the platform role only. It runs no `requireOperatorUser`,
 *    so it counts no limit and writes no event of the operator guard.
 * 3. The address is verified, else `email_unverified`.
 * 4. A second factor has a method, else `second_factor_required`.
 * 5. The session is fresh, else `session_not_fresh`.
 *
 * Each refusal emits one `sso.guard_refused` with the step name. A pass
 * grants nothing: `requireSsoManager` runs after the read, for the
 * organization of the body or of the provider. So an operator whose
 * session is older than the grant passes here. After the read, the guard
 * refuses that operator unless the user owns that organization.
 */
export async function requireSsoManagerOfAny(
  config: ResolvedConfig,
  resolved: ResolvedSession,
): Promise<Result<true>> {
  const { user, session } = resolved;
  if (session.actorId !== null) return refused(config, "impersonation");
  if (
    !(await isPlatformOperator(config, user.id)) &&
    !(await ownsSomeOrganization(config, user.id))
  )
    return refused(config, "rank");
  if (!user.emailVerified) return refused(config, "email", "email_unverified");
  if (!(await hasSecondFactor(config, user.id)))
    return refused(config, "second_factor", "second_factor_required");
  if (!requireFresh(config, session).ok) return refused(config, "fresh", "session_not_fresh");
  return ok(true);
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
