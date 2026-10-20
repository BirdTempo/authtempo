import {
  type Auth,
  activeBan,
  holdsPlatformRole,
  type OperatorUser,
  type ResolvedSession,
  type SessionRow,
  type UserRow,
} from "@authtempo/core";
import { APIError, apiError, BETTER_AUTH_CODES, messageOf, NOT_SUPPORTED } from "../errors.js";
import type { AdminOptions, AdminSession, AdminUser } from "../types.js";
import { ADMIN_NOT_SUPPORTED } from "./admin-lines.js";
import type { Mapped } from "./map-options.js";
import { sessionTokenOf, toSession, toUser } from "./shapes.js";

export { ADMIN_NOT_SUPPORTED };

/**
 * Better Auth 1.7.7's admin paths (dist/plugins/admin/routes.mjs, read
 * 2026-10-21), served by `auth.handler` with the `admin` plugin (plan 12f,
 * spec section 26 item 14). The shim maps eight paths onto core's operator
 * routes: list-users, get-user, ban-user, unban-user, revoke-user-sessions,
 * impersonate-user, stop-impersonating, and set-role. The caller's session
 * is the user actor (ruling 39). The calls of `ADMIN_NOT_SUPPORTED` (admin-lines.ts)
 * have no core tool, so each one answers NOT_SUPPORTED with a line that
 * names section 26.
 */

/**
 * The ranks of core's organizations in this package. `mapOptions` passes
 * them to core, and the admin check reads them, so the platform role is
 * always one of them. They are Better Auth's organization roles plus
 * core's `viewer`.
 */
export const COMPAT_RANKS: Readonly<Record<string, number>> = Object.freeze({
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
});

/** Better Auth's default `adminRoles` (dist/plugins/admin/admin.mjs, read 2026-10-21). */
const DEFAULT_ADMIN_ROLES = ["admin"];
/** Better Auth's role of a user who is not an admin: `defaultRole`, which the shim refuses to change. */
export const USER_ROLE = "user";
/** Better Auth's default impersonation life (admin.mjs `getDate(3600, "sec")`). */
export const IMPERSONATION_SECONDS = 3600;

/** The roles of `adminRoles`, as Better Auth reads them: a list, or a text split at each comma. */
export function adminRolesOf(options: AdminOptions): string[] {
  const v = options.adminRoles ?? DEFAULT_ADMIN_ROLES;
  const list = Array.isArray(v) ? v : v.split(",");
  return [...new Set(list.map((r) => r.trim()))];
}

/** The one platform role of a checked `adminRoles`. The check refuses every other form. */
export function platformRoleOf(options: AdminOptions): string {
  return adminRolesOf(options)[0] ?? "admin";
}

/** Core's operator route that a list-users query maps onto, or the line of its refusal. */
export type ListUsersTarget =
  | {
      ok: true;
      path: "/operator/users" | "/operator/users/search";
      query: Record<string, string>;
    }
  | { ok: false; why: string };

const ONE_KEY = "core takes one search key per call (spec section 26 item 4)";
const BY_ADDRESS =
  "core searches by an exact address, an exact id, or the start of an address, never by the name or by a part inside (spec section 26 item 4); pass searchField email with searchOperator starts_with, or filterField email or id";
const BY_ID = "core lists the users by id ascending (spec section 26 item 4)";
const BY_CURSOR =
  "core pages by a cursor, not by an offset, and gives no total (spec section 26 item 4)";
const PAGE = "core answers 1 to 100 users per page (spec section 26 item 4)";

/**
 * Better Auth's list-users query on core's reads (plan 12f, ruling 39 Q6).
 * `searchValue` with `searchOperator` `starts_with` on the address is the
 * prefix search; `filterValue` with `filterField` `email` or `id` and the
 * operator `eq` is the exact search. Better Auth's default operator is
 * `contains`, which core has not, so a search must name `starts_with`.
 */
export function listUsersTarget(q: URLSearchParams): ListUsersTarget {
  const searchValue = q.get("searchValue");
  const filterValue = q.get("filterValue");
  const limit = q.get("limit");
  const offset = q.get("offset");
  if (q.has("sortBy") || (q.get("sortDirection") ?? "asc") !== "asc")
    return { ok: false, why: BY_ID };
  if (offset !== null && offset !== "0") return { ok: false, why: BY_CURSOR };
  const query: Record<string, string> = {};
  if (limit !== null) {
    if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100) return { ok: false, why: PAGE };
    query.limit = limit;
  }
  // Better Auth reads a search only when the value is not empty (routes.mjs listUsers).
  const search = searchValue !== null && searchValue !== "";
  const filter = filterValue !== null;
  if (search && filter) return { ok: false, why: ONE_KEY };
  // The shim's own key: the `next` of the page before (core's cursor), since core has no offset.
  const after = q.get("after");
  if (after !== null) query.after = after;
  if (search) {
    if ((q.get("searchField") ?? "email") !== "email" || q.get("searchOperator") !== "starts_with")
      return { ok: false, why: BY_ADDRESS };
    return {
      ok: true,
      path: "/operator/users/search",
      query: { ...query, emailPrefix: searchValue },
    };
  }
  if (filter) {
    const field = q.get("filterField") ?? "email";
    if ((field !== "email" && field !== "id") || (q.get("filterOperator") ?? "eq") !== "eq")
      return { ok: false, why: BY_ADDRESS };
    return { ok: true, path: "/operator/users/search", query: { ...query, [field]: filterValue } };
  }
  return { ok: true, path: "/operator/users", query };
}

/**
 * The reason of an act that Better Auth sends with no reason. Better Auth
 * requires a reason nowhere, and core requires one for each act (spec
 * section 26 item 5). So the audit row then names the path, not a
 * person's reason.
 */
export const adminReason = (path: string) => `better-auth admin plugin ${path}`;

/** Core's ban body of Better Auth's ban-user body, or null for a body Better Auth refuses too. */
export function banBodyOf(
  body: unknown,
  now: Date,
): { userId: string; reason: string; until?: string } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { userId, banReason, banExpiresIn } = body as Record<string, unknown>;
  if (typeof userId !== "string" || userId === "") return null;
  if (banReason !== undefined && typeof banReason !== "string") return null;
  if (
    banExpiresIn !== undefined &&
    (typeof banExpiresIn !== "number" || !Number.isFinite(banExpiresIn) || banExpiresIn <= 0)
  )
    return null;
  return {
    userId,
    // Better Auth keeps "No reason" for an empty reason (routes.mjs banUser); core keeps the path.
    reason: banReason ? banReason : adminReason("/admin/ban-user"),
    // Core checks the range: 1 minute to 3650 days (plan 12f Task 6).
    ...(banExpiresIn !== undefined
      ? { until: new Date(now.getTime() + banExpiresIn * 1000).toISOString() }
      : {}),
  };
}

/**
 * The change of a set-role call: a grant of the platform role for the role
 * of `adminRoles`, a revoke for Better Auth's `user`, else null. Core has
 * one platform role and no other role on a user (spec section 26 item 1).
 */
export function setRoleChange(role: unknown, platformRole: string): "grant" | "revoke" | null {
  const list =
    typeof role === "string"
      ? role.split(",")
      : Array.isArray(role) && role.every((r) => typeof r === "string")
        ? (role as string[])
        : null;
  if (list === null) return null;
  const roles = [...new Set(list.map((r) => r.trim()))];
  if (roles.length !== 1) return null;
  if (roles[0] === platformRole) return "grant";
  if (roles[0] === USER_ROLE) return "revoke";
  return null;
}

/**
 * One admin answer before it is a Response: Better Auth's body, the
 * status, and core's headers. The handler sends it as JSON, and `auth.api`
 * answers the body itself, with its dates (ruling 60 m2).
 */
export interface AdminAnswer {
  body: unknown;
  status: number;
  headers: Headers;
}

/** The JSON Response of an answer. */
function responseOf(a: AdminAnswer): Response {
  return Response.json(a.body, { status: a.status, headers: a.headers });
}

function failure(code: string, status: number, message: string): AdminAnswer {
  return { body: { code, message }, status, headers: new Headers() };
}

/**
 * The shim's own answer to an admin path. It refuses each call that core
 * does not serve, and each list-users query that core's reads cannot
 * answer. It refuses a set-role to a role that is not the platform role or
 * `user`. Null for every other request.
 * These refusals name a config fact only, so they come before the session read.
 */
export async function adminRefusal(mapped: Mapped, request: Request): Promise<Response | null> {
  const a = await refusalAnswer(mapped, request);
  return a === null ? null : responseOf(a);
}

async function refusalAnswer(mapped: Mapped, request: Request): Promise<AdminAnswer | null> {
  const url = new URL(request.url);
  const prefix = `${mapped.basePath}/admin/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const path = url.pathname.slice(mapped.basePath.length);
  const row = ADMIN_NOT_SUPPORTED[path];
  if (row && request.method === row.method) return failure(NOT_SUPPORTED, 501, row.why);
  if (path === "/admin/list-users" && request.method === "GET") {
    const target = listUsersTarget(url.searchParams);
    return target.ok ? null : failure(NOT_SUPPORTED, 501, target.why);
  }
  if (path === "/admin/set-role" && request.method === "POST" && mapped.platformRole !== null) {
    const body: unknown = await request
      .clone()
      .json()
      .catch(() => null);
    const role =
      typeof body === "object" && body !== null ? (body as { role?: unknown }).role : null;
    if (role !== undefined && role !== null && setRoleChange(role, mapped.platformRole) === null)
      return failure(
        NOT_SUPPORTED,
        501,
        `core has one platform role: set ${mapped.platformRole} to grant it or ${USER_ROLE} to revoke it (spec section 26 item 1)`,
      );
  }
  return null;
}

/**
 * Better Auth's code of each refusal by the operator guard, per path
 * (dist/plugins/admin/routes.mjs and error-codes.mjs, read 2026-10-21).
 * Core answers `operator_required` for each step of the guard and for a
 * target that is a platform operator. Better Auth names the refused action,
 * so each path answers its own name with core's status, 403.
 */
export const ADMIN_FORBIDDEN: Readonly<Record<string, string>> = {
  "/admin/list-users": "YOU_ARE_NOT_ALLOWED_TO_LIST_USERS",
  "/admin/get-user": "YOU_ARE_NOT_ALLOWED_TO_GET_USER",
  "/admin/ban-user": "YOU_ARE_NOT_ALLOWED_TO_BAN_USERS",
  "/admin/unban-user": "YOU_ARE_NOT_ALLOWED_TO_BAN_USERS",
  "/admin/set-role": "YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE",
  "/admin/revoke-user-sessions": "YOU_ARE_NOT_ALLOWED_TO_REVOKE_USERS_SESSIONS",
  "/admin/impersonate-user": "YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS",
};

/**
 * The stop of an impersonation. Core's stop needs the impersonation session
 * only, not the operator guard, so the path has no FORBIDDEN code.
 */
const STOP_PATH = "/admin/stop-impersonating";
/** Better Auth's text of a stop by a session that impersonates nobody (routes.mjs stopImpersonating, read 2026-10-21). */
const NOT_IMPERSONATING = "You are not impersonating anyone";

/** Better Auth's session with the admin plugin: `impersonatedBy` is core's `actorId`. */
export function toAdminSession(row: SessionRow, token: string): AdminSession {
  return { ...toSession(row, token), impersonatedBy: row.actorId };
}

/** Better Auth's code for an unknown user (@better-auth/core dist/error/codes.mjs:4, read 2026-10-21). */
const USER_NOT_FOUND = "USER_NOT_FOUND";
/** Better Auth's code for a ban of the caller's own user (error-codes.mjs, read 2026-10-21). */
const BAN_YOURSELF = "YOU_CANNOT_BAN_YOURSELF";

/**
 * Better Auth's user with the admin fields, from core's user row. `role`
 * is the platform role or `user`. The ban fields hold a ban that holds
 * now, by core's rule `activeBan` (spec 26 item 6). The shim keeps no copy
 * of the rule (ruling 60 L1). A ban that ended reads as no ban.
 * `twoFactorEnabled` is there with the twoFactor plugin only (ruling 60 L2).
 */
export function toAdminUser(
  row: UserRow,
  role: string,
  now: Date,
  twoFactorEnabled?: boolean,
): AdminUser {
  const holds = activeBan(row, now);
  return {
    ...toUser(row),
    role,
    banned: holds,
    banReason: holds ? row.banReason : null,
    banExpires: holds ? row.banUntil : null,
    ...(twoFactorEnabled !== undefined ? { twoFactorEnabled } : {}),
  };
}

/**
 * The users of `ids` whose second factor is on, or null without the
 * twoFactor plugin. Core's factor is on while its `secondFactor` row
 * exists (core `factorRow`), so one `in` read answers a whole page.
 */
async function factorsOf(mapped: Mapped, ids: readonly string[]): Promise<Set<string> | null> {
  if (!mapped.plugins.has("two-factor")) return null;
  if (ids.length === 0) return new Set();
  const rows = await mapped.config.storage.findMany("secondFactor", [
    { field: "userId", op: "in", value: [...ids] },
  ]);
  return new Set(rows.map((r) => r.userId));
}

/** Better Auth's admin user of one row, with `twoFactorEnabled` from one factor read. */
async function adminUserOf(mapped: Mapped, row: UserRow, role: string): Promise<AdminUser> {
  const factors = await factorsOf(mapped, [row.id]);
  return toAdminUser(row, role, new Date(), factors ? factors.has(row.id) : undefined);
}

/**
 * The Better Auth role of one user: the platform role when the user holds
 * it in the platform organization, else `user`. The rule is core's
 * `holdsPlatformRole`, so the shim keeps no copy (ruling 54 of plan 12f).
 * Two reads: the platform organization by its slug, and the member row.
 * `mapOptions` puts the slug that core resolves into the config (ruling 60).
 */
export async function roleOf(mapped: Mapped, userId: string): Promise<string> {
  const o = mapped.config.organizations;
  const slug = o ? o.platformOrganization : undefined;
  if (mapped.platformRole === null || !slug) return USER_ROLE;
  const storage = mapped.config.storage;
  const organization = await storage.findOne("organization", [
    { field: "slug", op: "eq", value: slug },
  ]);
  if (!organization) return USER_ROLE;
  const member = await storage.findOne("member", [
    { field: "organizationId", op: "eq", value: organization.id },
    { field: "userId", op: "eq", value: userId },
  ]);
  return holdsPlatformRole(mapped.config, organization.id, member)
    ? mapped.platformRole
    : USER_ROLE;
}

type Body = Record<string, unknown>;

/** A body of Better Auth's form with core's headers: the renewed cookie and CORS. */
function withHeaders(body: unknown, status: number, from: Response): AdminAnswer {
  const headers = new Headers(from.headers);
  headers.delete("content-length");
  return { body, status, headers };
}

/**
 * Core's refusal in Better Auth's form, with core's status and headers.
 * `operator_required` answers the path's own name, and `not_found`
 * answers `USER_NOT_FOUND`. `operator_self` on a ban answers
 * `YOU_CANNOT_BAN_YOURSELF`. The shim's actor is always a user, so
 * `operator_self` names the caller's own user. Each other code answers its
 * name in `BETTER_AUTH_CODES`.
 */
async function refusalOf(path: string, res: Response): Promise<AdminAnswer> {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as Body | null;
  const error = typeof body?.error === "string" ? body.error : "unexpected";
  const code =
    error === "operator_required"
      ? (ADMIN_FORBIDDEN[path] ?? BETTER_AUTH_CODES.operator_required)
      : error === "not_found"
        ? USER_NOT_FOUND
        : error === "operator_self" && path === "/admin/ban-user"
          ? BAN_YOURSELF
          : Object.hasOwn(BETTER_AUTH_CODES, error)
            ? BETTER_AUTH_CODES[error as keyof typeof BETTER_AUTH_CODES]
            : BETTER_AUTH_CODES.unexpected;
  // A hook refusal carries the app's own text (plan 9d).
  const message = typeof body?.message === "string" ? body.message : messageOf(code);
  return withHeaders({ code, message }, res.status, res);
}

/** A VALIDATION_ERROR of the shim's own, before any core route runs. */
function invalid(): AdminAnswer {
  const code = BETTER_AUTH_CODES.invalid_body;
  return failure(code, 400, messageOf(code));
}

/** The JSON object of a POST, or null for no object. */
async function objectOf(request: Request): Promise<Body | null> {
  const v: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Body) : null;
}

/** The `userId` of a body: a string of one character or more, else null. */
function userIdOf(body: Body | null): string | null {
  const v = body?.userId;
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * The answer to one of the eight admin paths that map onto core's operator
 * routes (plan 12f Tasks 10 and 11). Any other request gets null. Each
 * call posts core's own route with the caller's headers, so the session of
 * the caller is the actor. Core's guard runs there: the platform role, a
 * verified address, a second factor, and a fresh session (spec 26 item 2).
 * The stop of an impersonation needs the impersonation session only. The
 * shim adds no power and no check of its own past Better Auth's shapes.
 *
 * The cost on D1: an act answers Better Auth's `{ user }` from one read of
 * the user row after core's route. That read is on top of the route's call
 * budget (ruling 37 of plan 12f). An impersonation start or stop reads the
 * session of the token that core set, for `{ session, user }`, in 5
 * statements. The stop also reads the role in 2. With the twoFactor
 * plugin, each answer reads the factor rows in 1 more (ruling 60 L2).
 */
export async function adminRoute(
  auth: Auth,
  mapped: Mapped,
  request: Request,
): Promise<Response | null> {
  const a = await adminAnswer(auth, mapped, request);
  return a === null ? null : responseOf(a);
}

async function adminAnswer(
  auth: Auth,
  mapped: Mapped,
  request: Request,
): Promise<AdminAnswer | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${mapped.basePath}/admin/`)) return null;
  const path = url.pathname.slice(mapped.basePath.length);
  if (!Object.hasOwn(ADMIN_FORBIDDEN, path) && path !== STOP_PATH) return null;
  const get = path === "/admin/list-users" || path === "/admin/get-user";
  // Any other method, an OPTIONS preflight too, goes to core's router.
  if (request.method !== (get ? "GET" : "POST")) return null;
  const platformRole = mapped.platformRole ?? "admin";
  const storage = mapped.config.storage;
  /** One core route with the caller's headers: the cookie, the Origin, and the client IP. */
  const core = (to: string, body?: Body) => {
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    if (body !== undefined) headers.set("content-type", "application/json");
    return auth.handle(
      new Request(`${mapped.origin}${mapped.basePath}${to}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
  };
  /** The session of a token that core's answer set: the session row and the user row. */
  const sessionOf = (token: string): Promise<ResolvedSession | null> =>
    auth.session(
      new Request(`${mapped.origin}${mapped.basePath}/session`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  /** The user row after an act, in Better Auth's shape with `role`. */
  const userAfter = async (res: Response, userId: string, role: string) => {
    const row = await storage.findOne("user", [{ field: "id", op: "eq", value: userId }]);
    if (!row) throw new Error("authtempo compat: the user of an answered admin call is gone");
    return withHeaders({ user: await adminUserOf(mapped, row, role) }, 200, res);
  };

  if (path === "/admin/list-users") {
    // adminRefusal answered every query that core's reads cannot answer.
    const target = listUsersTarget(url.searchParams);
    if (!target.ok) return null;
    const res = await core(`${target.path}?${new URLSearchParams(target.query)}`);
    if (!res.ok) return refusalOf(path, res);
    const page = (await res.json()) as { users: OperatorUser[]; next: string | null };
    const users = await usersOf(mapped, page.users, platformRole);
    const limit = target.query.limit === undefined ? undefined : Number(target.query.limit);
    // Core gives no total (a count scans the table on D1). The total is
    // exact when this page ends the list; else `next` names the next page.
    return withHeaders(
      page.next === null
        ? { users, total: users.length, limit, offset: 0 }
        : { users, limit, offset: 0, next: page.next },
      200,
      res,
    );
  }
  if (path === "/admin/get-user") {
    const id = url.searchParams.get("id");
    if (id === null || id === "") return invalid();
    const res = await core(`/operator/users/get?${new URLSearchParams({ userId: id })}`);
    if (!res.ok) return refusalOf(path, res);
    const { user } = (await res.json()) as { user: OperatorUser };
    const [one] = await usersOf(mapped, [user], platformRole);
    // Better Auth answers the user itself, not `{ user }` (routes.mjs getUser).
    return withHeaders(one ?? null, 200, res);
  }
  if (path === STOP_PATH) {
    // Better Auth's stop takes no body. Core's stop ends the caller's
    // impersonation session and sets the session cookie back to the
    // operator's token while that session lives (plan 12f Task 11).
    const res = await core("/operator/impersonate/stop", { reason: adminReason(path) });
    if (!res.ok) {
      const code = (
        (await res
          .clone()
          .json()
          .catch(() => null)) as Body | null
      )?.error;
      // Core answers not_found for a session that impersonates nobody.
      return code === "not_found"
        ? withHeaders({ message: NOT_IMPERSONATING }, 400, res)
        : refusalOf(path, res);
    }
    const own = sessionTokenOf(res.headers.getSetCookie());
    const back = own === null ? null : await sessionOf(own);
    // A bearer caller, or an operator whose own session ended, gets no session back.
    if (own === null || back === null) return withHeaders({ session: null, user: null }, 200, res);
    return withHeaders(
      {
        session: toAdminSession(back.session, own),
        user: await adminUserOf(mapped, back.user, await roleOf(mapped, back.user.id)),
      },
      200,
      res,
    );
  }
  const body = await objectOf(request);
  const userId = userIdOf(body);
  if (userId === null) return invalid();
  switch (path) {
    case "/admin/ban-user": {
      const ban = banBodyOf(body, new Date());
      if (ban === null) return invalid();
      const res = await core("/operator/users/ban", ban);
      // Core refuses an act on a platform operator, so the target's role is `user`.
      return res.ok ? userAfter(res, userId, USER_ROLE) : refusalOf(path, res);
    }
    case "/admin/unban-user": {
      const res = await core("/operator/users/unban", {
        userId,
        reason: adminReason(path),
      });
      return res.ok ? userAfter(res, userId, USER_ROLE) : refusalOf(path, res);
    }
    case "/admin/set-role": {
      // adminRefusal answered every role that is not the platform role or `user`.
      const change = setRoleChange(body?.role, platformRole);
      if (change === null) return invalid();
      const res = await core("/operator/users/platform-role", {
        userId,
        grant: change === "grant",
        reason: adminReason(path),
      });
      return res.ok
        ? userAfter(res, userId, change === "grant" ? platformRole : USER_ROLE)
        : refusalOf(path, res);
    }
    case "/admin/impersonate-user": {
      const res = await core("/operator/impersonate", { userId, reason: adminReason(path) });
      if (!res.ok) return refusalOf(path, res);
      // A bearer caller gets the token in core's body. A cookie caller gets it
      // in the session cookie, and the actor cookie keeps the operator's token.
      const answer = (await res
        .clone()
        .json()
        .catch(() => null)) as { token?: unknown } | null;
      const token =
        typeof answer?.token === "string"
          ? answer.token
          : sessionTokenOf(res.headers.getSetCookie());
      const s = token === null ? null : await sessionOf(token);
      if (token === null || s === null)
        throw new Error("authtempo compat: the session of an answered impersonation is gone");
      // Core impersonates no platform operator, so the user's role is `user`.
      return withHeaders(
        {
          session: toAdminSession(s.session, token),
          user: await adminUserOf(mapped, s.user, USER_ROLE),
        },
        200,
        res,
      );
    }
    case "/admin/revoke-user-sessions": {
      const res = await core("/operator/sessions/end-user", {
        userId,
        reason: adminReason(path),
      });
      if (!res.ok) return refusalOf(path, res);
      const done = (await res.json()) as { ended: number; more: boolean };
      // One call ends one page within the call budget. While sessions stay,
      // the answer says so, and the caller calls again (spec 26 item 5).
      return withHeaders(
        done.more ? { success: false, more: true, ended: done.ended } : { success: true },
        200,
        res,
      );
    }
  }
  return null;
}

/** The input of one `auth.api` admin call, in Better Auth's shape. */
export interface AdminCallInput {
  headers?: Headers;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/**
 * One admin call of `auth.api` (ruling 60 m2). It sends the handler's own
 * steps with the caller's headers: the refusals, then the mapped route.
 * So the server call and the HTTP path answer alike. It answers Better
 * Auth's body, or throws Better Auth's `APIError` with the status and code
 * of the path. Without the `admin` plugin, each call throws 404.
 */
export async function adminCall(
  auth: Auth,
  mapped: Mapped,
  method: "GET" | "POST",
  path: string,
  input: AdminCallInput,
): Promise<unknown> {
  if (mapped.platformRole === null) throw apiError("not_found", 404);
  const url = new URL(`${mapped.origin}${mapped.basePath}${path}`);
  for (const [k, v] of Object.entries(input.query ?? {}))
    if (v !== undefined) url.searchParams.set(k, String(v));
  const headers = new Headers(input.headers);
  if (method === "POST") headers.set("content-type", "application/json");
  const request = new Request(url, {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(input.body ?? {}) } : {}),
  });
  const a = (await refusalAnswer(mapped, request)) ?? (await adminAnswer(auth, mapped, request));
  if (a === null) throw apiError("not_found", 404);
  if (a.status < 400) return a.body;
  const b = (a.body ?? {}) as { code?: unknown; message?: unknown };
  throw new APIError(a.status, {
    ...(typeof b.code === "string" ? { code: b.code } : {}),
    ...(typeof b.message === "string" ? { message: b.message } : {}),
  });
}

/**
 * Better Auth's users of core's operator users, in core's order. One read
 * of the user rows gives `image` and `updatedAt`, which core's operator
 * answer does not hold. `platformOperator` gives `role`. With the twoFactor
 * plugin, one more read gives `twoFactorEnabled`.
 */
async function usersOf(
  mapped: Mapped,
  users: readonly OperatorUser[],
  platformRole: string,
): Promise<AdminUser[]> {
  if (users.length === 0) return [];
  const ids = users.map((u) => u.id);
  const rows = await mapped.config.storage.findMany("user", [
    { field: "id", op: "in", value: ids },
  ]);
  const factors = await factorsOf(mapped, ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const now = new Date();
  const out: AdminUser[] = [];
  for (const u of users) {
    const row = byId.get(u.id);
    // A user deleted between the two reads is left out of the answer.
    if (row)
      out.push(
        toAdminUser(
          row,
          u.platformOperator ? platformRole : USER_ROLE,
          now,
          factors ? factors.has(row.id) : undefined,
        ),
      );
  }
  return out;
}
