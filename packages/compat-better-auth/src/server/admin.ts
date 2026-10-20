import { NOT_SUPPORTED } from "../errors.js";
import type { AdminOptions } from "../types.js";
import type { Mapped } from "./map-options.js";

/**
 * Better Auth 1.7.7's admin paths (dist/plugins/admin/routes.mjs, read
 * 2026-10-21), served by `auth.handler` with the `admin` plugin (plan 12f,
 * spec section 26 item 14). The shim maps list-users, get-user, ban-user,
 * unban-user, revoke-user-sessions, impersonate-user, stop-impersonating,
 * and set-role onto core's operator routes, with the caller's session as a
 * user actor (ruling 39). The calls below have no core tool, so each one
 * answers NOT_SUPPORTED with a line that names section 26.
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

const NOT_A_DELETE =
  "core has no password set and no user delete by an operator in plan 12f; an operator bans, and the person resets the password or deletes the account (spec section 26 item 15)";

/** Each admin call that core does not serve, by path, with its method and its line. */
export const ADMIN_NOT_SUPPORTED: Readonly<
  Record<string, { method: "GET" | "POST"; why: string }>
> = {
  "/admin/set-user-password": { method: "POST", why: NOT_A_DELETE },
  "/admin/remove-user": { method: "POST", why: NOT_A_DELETE },
  "/admin/create-user": {
    method: "POST",
    why: "core has no user create by an operator in plan 12f; createAdmin makes the first operator only (spec section 26 items 11 and 15)",
  },
  "/admin/update-user": {
    method: "POST",
    why: "core has no user update by an operator in plan 12f (spec section 26 item 15)",
  },
  "/admin/list-user-sessions": {
    method: "POST",
    why: "core gives an operator the count of live sessions in get-user, never the session rows (spec section 26 item 4)",
  },
  "/admin/revoke-user-session": {
    method: "POST",
    why: "core ends all sessions of a user, never one by its token; use /admin/revoke-user-sessions (spec section 26 item 5)",
  },
  "/admin/has-permission": {
    method: "POST",
    why: "core has no permission statements for operators; the platform role holds every operator tool (spec section 26 items 2 and 15)",
  },
};

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
 * section 26 item 5), so the audit row then names the path, not a person's
 * reason.
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

function failure(code: string, status: number, message: string) {
  return Response.json({ code, message }, { status });
}

/**
 * The shim's own answer to an admin path: each call core does not serve, a
 * list-users query that core's reads cannot answer, and a set-role to a role
 * that is not the platform role or `user`. Null for every other request.
 * These refusals name a config fact only, so they come before the session read.
 */
export async function adminRefusal(mapped: Mapped, request: Request): Promise<Response | null> {
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
