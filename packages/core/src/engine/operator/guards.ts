import type { OperatorScope, ResolvedConfig, ResolvedOperatorSecret } from "../../config.js";
import { isOperatorSecret, OPERATOR_USERS_PER_IP } from "../../operator-secret.js";
import { constantTimeEqual, sha256Hex } from "../../primitives/crypto.js";
import { fail, ok, type Result } from "../../result.js";
import type { SessionRow, UserRow } from "../../schema.js";
import type { StorageAdapter } from "../../storage/port.js";
import { requireFresh } from "../fresh.js";
import type { ResolvedSession } from "../sessions.js";

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
  const o = config.organizations;
  if (!o || o.platformRole === null || o.platformOrganization === null) return false;
  const organization = await storage.findOne("organization", [
    { field: "slug", op: "eq", value: o.platformOrganization },
  ]);
  if (!organization) return false;
  const member = await storage.findOne("member", [
    { field: "organizationId", op: "eq", value: organization.id },
    { field: "userId", op: "eq", value: userId },
  ]);
  return member?.role.split(",").includes(o.platformRole) ?? false;
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
 * 2. The user holds the platform role in the platform organization.
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
  if (!(await isPlatformOperator(config, user.id))) return refused(route);
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
