import type { OperatorScope, ResolvedConfig, ResolvedOperatorSecret } from "../../config.js";
import { isOperatorSecret, OPERATOR_USERS_PER_IP } from "../../operator-secret.js";
import { constantTimeEqual, sha256Hex } from "../../primitives/crypto.js";
import { fail, ok, type Result } from "../../result.js";
import type { MemberRow, OrganizationRow, SessionRow, UserRow } from "../../schema.js";
import type { StorageAdapter } from "../../storage/port.js";
import { requireFresh } from "../fresh.js";
import { holdsRolePart } from "../ranks.js";
import type { ResolvedSession } from "../sessions.js";
import { bannedFor } from "./ban-rule.js";

/**
 * The actor of an operator act (plan 12f, spec 26 item 1): a named operator
 * secret, a platform operator with the session of this request, or the app
 * in process. The audit row names the actor by the secret's name, the user
 * id, or the app's name, never by a secret.
 */
export type OperatorActor =
  | { kind: "secret"; name: string; scopes: readonly OperatorScope[] }
  | { kind: "user"; user: UserRow; session: SessionRow }
  | { kind: "app"; name: string };

/** Ruling 10 puts this limit in `@authtempo/core/operator-secret`, which the CLI reads. */
export { OPERATOR_USERS_PER_IP };

/**
 * The calls of one platform operator per hour (spec 26 item 12). A support
 * person makes about one call per page view; 600 serve a busy hour. A
 * stolen session then reads at most 600 pages of users per hour.
 */
export const OPERATOR_PER_USER = { seconds: 3600, max: 600 };

/**
 * The impersonation starts of one platform operator per hour (spec 26 item
 * 12). A support call needs one start. 20 serve a busy hour, and a stolen
 * operator session reaches at most 20 accounts per hour this way.
 */
export const IMPERSONATE_PER_USER = { seconds: 3600, max: 20 };

/**
 * `Operator <secret>`. The scheme is case-insensitive (RFC 9110 section
 * 11.1). The secret has the form of `isOperatorSecret`, so a header of any
 * other form gets no hash.
 */
const OPERATOR_AUTH = /^Operator (\S+)$/i;

/** 1 to 64 characters of `[a-z0-9_.-]` (spec 26 item 1). */
const APP_NAME = /^[a-z0-9_.-]{1,64}$/;

/**
 * The entry whose hash is the SHA-256 of the presented secret, or null.
 * Core keeps the hashes only, as for every token; the digests compare in
 * constant time.
 */
export async function matchOperatorSecret(
  config: ResolvedConfig,
  request: Request,
): Promise<ResolvedOperatorSecret | null> {
  const operator = config.operator;
  if (!operator) return null;
  const secret = OPERATOR_AUTH.exec(request.headers.get("authorization") ?? "")?.[1];
  if (secret === undefined || !isOperatorSecret(secret)) return null;
  const digest = await sha256Hex(secret);
  let match: ResolvedOperatorSecret | null = null;
  // The loop compares against every entry and does not stop at a match, so
  // the time of a call does not tell which entry matched.
  for (const entry of operator.secrets) {
    if (constantTimeEqual(digest, entry.secretHash) && match === null) {
      match = entry;
    }
  }
  return match;
}

/**
 * True when the user holds `organizations.platformRole` in the platform
 * organization: a member row there whose role parts hold the role.
 * `storage` is the adapter to read through; a write passes its `tx`.
 */
export async function isPlatformOperator(
  config: ResolvedConfig,
  userId: string,
  storage: StorageAdapter = config.storage,
): Promise<boolean> {
  return (await platformMember(config, userId, storage)) !== null;
}

/**
 * The member row of the platform organization that gives the user the
 * platform role, or null. `isPlatformOperator` and the guard read it.
 */
async function platformMember(
  config: ResolvedConfig,
  userId: string,
  storage: StorageAdapter = config.storage,
): Promise<MemberRow | null> {
  const organizationId = await platformOrganizationId(config, storage);
  if (organizationId === null) return null;
  const member = await storage.findOne("member", [
    { field: "organizationId", op: "eq", value: organizationId },
    { field: "userId", op: "eq", value: userId },
  ]);
  return member && holdsPlatformRole(config, organizationId, member) ? member : null;
}

/**
 * Why the operator of an impersonation session no longer holds it, or null
 * while the operator still does (the plan 12f Task 11 fix). Each door of a
 * session reads it: `resolveSession`, the session JWT mint, and
 * `sessionLive`. The answer is `account_delete` when the operator's user
 * row is gone, and `ban` for a ban from after the start. It is `role_loss`
 * when the platform role is gone or its member row is newer than the start
 * (as in ruling 50).
 * So an act that leaves an impersonation session for the sweep leaves no
 * power with it. It costs 3 reads, and only for an impersonation session.
 */
export async function impersonationLoss(
  config: ResolvedConfig,
  session: Pick<SessionRow, "actorId" | "createdAt">,
): Promise<"account_delete" | "ban" | "role_loss" | null> {
  if (session.actorId === null) return null;
  const actor = await config.storage.findOne("user", [
    { field: "id", op: "eq", value: session.actorId },
  ]);
  if (!actor) return "account_delete";
  if (bannedFor(actor, session.createdAt)) return "ban";
  const member = await platformMember(config, actor.id);
  if (!member || member.updatedAt.getTime() > session.createdAt.getTime()) return "role_loss";
  return null;
}

/**
 * The id of the platform organization, or null when the config has no
 * platform role or no organization holds the slug.
 */
export async function platformOrganizationId(
  config: ResolvedConfig,
  storage: StorageAdapter = config.storage,
): Promise<string | null> {
  const o = config.organizations;
  if (!o || o.platformRole === null || o.platformOrganization === null) return null;
  const organization = await storage.findOne("organization", [
    { field: "slug", op: "eq", value: o.platformOrganization },
  ]);
  return organization?.id ?? null;
}

/**
 * The role rule of `isPlatformOperator` for a member row in hand: a row of
 * the platform organization whose role parts hold `organizations.platformRole`.
 * A read of many users passes each row of one `in` read. The main entry
 * exports it, so the Better Auth shim reads this rule and keeps no copy
 * (ruling 54 of plan 12f). The config is a resolved config or a config input.
 */
export function holdsPlatformRole(
  config: { readonly organizations?: { readonly platformRole?: string | null } | false | null },
  platformId: string | null,
  member: Pick<MemberRow, "organizationId" | "role"> | null | undefined,
): boolean {
  const role = (config.organizations ? config.organizations.platformRole : null) ?? null;
  if (role === null || platformId === null || !member) return false;
  return member.organizationId === platformId && holdsRolePart(member.role, role);
}

/**
 * True when a member write in `organization` touches the member row that
 * gives the platform role (ruling 42 I1 of plan 12f). It is a removal, a
 * leave, or any role change of a holder. Ruling 50 counts each write of that row
 * as a new grant, so a session from before it holds no operator power.
 * `impersonationLoss` reads the same rule, so the act ends the
 * impersonation sessions that the door would refuse. The platform
 * organization keeps its slug and is never deleted.
 */
export function writesPlatformRole(
  config: ResolvedConfig,
  organization: Pick<OrganizationRow, "slug">,
  before: string,
): boolean {
  const o = config.organizations;
  const role = o?.platformRole ?? null;
  if (!o || role === null || organization.slug !== o.platformOrganization) return false;
  return holdsRolePart(before, role);
}

/** True when the user has a second factor with one method or more (plan 12c). */
async function hasSecondFactor(config: ResolvedConfig, userId: string): Promise<boolean> {
  const row = await config.storage.findOne("secondFactor", [
    { field: "userId", op: "eq", value: userId },
  ]);
  return row !== null && Array.isArray(row.methods) && row.methods.length > 0;
}

/** One log line per refusal, with the route name and no user id, so a log reader sees the attempts. */
function refused(route: string): Result<never> {
  console.error("authtempo: operator guard refused", route);
  return fail("operator_required");
}

/**
 * The operator user guard (spec 26 item 2). It checks five steps in this
 * order:
 *
 * 1. The session is not an impersonation session.
 * 2. The user holds the platform role in the platform organization, and
 *    the session is not older than the last write of that member row
 *    (ruling 50 of plan 12f). Each write of a role, a grant too, sets
 *    `updatedAt`, so a re-grant gives no power to a session from before
 *    it, such as a session that a revoke left for the sweep.
 * 3. The address is verified.
 * 4. A second factor has a method.
 * 5. The session is fresh.
 *
 * Each failure answers `operator_required`, one code for every step, so a
 * caller learns nothing about the step that failed. Then it counts on
 * `operator:user:<userId>`. `route` names the caller in the log line; an
 * engine call is `api`.
 */
export async function requireOperatorUser(
  config: ResolvedConfig,
  resolved: ResolvedSession,
  route = "api",
): Promise<Result<OperatorActor & { kind: "user" }>> {
  const { user, session } = resolved;
  if (session.actorId !== null) return refused(route);
  const member = await platformMember(config, user.id);
  if (!member) return refused(route);
  // The grant time of the role: a session from before it holds no operator power.
  if (session.createdAt.getTime() < member.updatedAt.getTime()) return refused(route);
  if (!user.emailVerified) return refused(route);
  if (!(await hasSecondFactor(config, user.id))) return refused(route);
  if (!requireFresh(config, session).ok) return refused(route);
  if (!(await config.limiter.allow(`operator:user:${user.id}`, OPERATOR_PER_USER)))
    return fail("rate_limited");
  return ok({ kind: "user", user, session });
}

/**
 * A user actor and the app hold every scope: the guard and the app's own
 * code decide for them. A secret actor needs the scope in its list.
 */
export function requireScope(actor: OperatorActor, scope: OperatorScope): Result<true> {
  if (actor.kind !== "secret" || actor.scopes.includes(scope)) return ok(true);
  return fail("operator_required");
}

/** The app in process as the actor. A name outside 1 to 64 characters of `[a-z0-9_.-]` answers `invalid_body`. */
export function appActor(name: string): Result<OperatorActor & { kind: "app" }> {
  if (!APP_NAME.test(name)) return fail("invalid_body");
  return ok({ kind: "app", name });
}

/**
 * The name rule of an app actor at each entry (spec 26 item 1). The app
 * builds the actor in process, so core checks the name before any read or
 * row. A name outside the rule answers `invalid_body`.
 */
export function checkActor(actor: OperatorActor): Result<true> {
  if (actor.kind === "app" && (typeof actor.name !== "string" || !APP_NAME.test(actor.name)))
    return fail("invalid_body");
  return ok(true);
}
