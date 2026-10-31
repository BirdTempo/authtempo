import {
  type Auth,
  activeBan,
  holdsPlatformRole,
  isJsonRequest,
  normalizeEmail,
  type OperatorUser,
  type ResolvedSession,
  type SessionRow,
  type UserRow,
} from "@authtempo/core";
import { APIError, apiError, BETTER_AUTH_CODES, messageOf, NOT_SUPPORTED } from "../errors.js";
import type { AdminOptions, AdminSession, AdminUser } from "../types.js";
import { ADMIN_NOT_SUPPORTED, NO_PASSWORD_SET } from "./admin-lines.js";
import { readJsonOf, readObjectOf } from "./body.js";
import type { Mapped } from "./map-options.js";
import { sessionTokenOf, toSession, toUser } from "./shapes.js";

export { ADMIN_NOT_SUPPORTED };

/**
 * Better Auth 1.7.7's admin paths (dist/plugins/admin/routes.mjs, read
 * 2026-10-21), served by `auth.handler` with the `admin` plugin (plan 12f,
 * spec section 26 item 14). The shim maps eleven paths onto core's operator
 * routes: list-users, get-user, ban-user, unban-user, revoke-user-sessions,
 * impersonate-user, stop-impersonating, set-role, and the create-user,
 * update-user, and remove-user of plan 12f2. The caller's session is the user actor (ruling
 * 39, and ruling 1 B9 of plan 12f2: no app actor). The calls of `ADMIN_NOT_SUPPORTED` (admin-lines.ts)
 * have no core tool, so each one answers NOT_SUPPORTED with a line that
 * names section 26.
 */

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
 * The fields of Better Auth's update-user `data` that core's operator
 * update takes (plan 12f2 Task 4): the name and the image only.
 */
const UPDATE_FIELDS = new Set(["name", "image"]);

/** Better Auth's codes of update-user (dist/plugins/admin/error-codes.mjs, read 2026-10-24). */
const NO_DATA_TO_UPDATE = "NO_DATA_TO_UPDATE";
const PASSWORD_VIA_UPDATE = "PASSWORD_CANNOT_BE_UPDATED_VIA_UPDATE_USER";
/** The shim's code of a field that core does not take (plan 12a, `COMPAT_CODES`). */
const FIELD_NOT_ALLOWED = "FIELD_NOT_ALLOWED";

/** The line of a field of update-user `data` that core's operator update does not take. */
function updateFieldLine(key: string): string {
  if (key === "email" || key === "emailVerified")
    return `core lets no operator set ${key}: the person changes the address and proves it (spec section 8.15 item 5)`;
  if (key === "role") return "core sets the platform role through /admin/set-role only";
  if (key === "banned" || key === "banReason" || key === "banExpires")
    return `core sets ${key} through /admin/ban-user and /admin/unban-user only`;
  return `core's operator update takes name and image only, not ${key} (spec section 26)`;
}

/**
 * The keys of update-user `data` that Better Auth refuses with its own 403
 * code when the caller lacks the right, in Better Auth's order: the role,
 * the ban keys, then the address (routes.mjs adminUpdateUser, read
 * 2026-10-25). Core lets no operator set them on this path, so the shim
 * answers that code (review-12f2-task7 L1).
 */
const UPDATE_RIGHTS: readonly { keys: readonly string[]; code: string }[] = [
  { keys: ["role"], code: "YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE" },
  { keys: ["banned", "banReason", "banExpires"], code: "YOU_ARE_NOT_ALLOWED_TO_BAN_USERS" },
  { keys: ["email", "emailVerified"], code: "YOU_ARE_NOT_ALLOWED_TO_SET_USERS_EMAIL" },
];

/**
 * The shim's refusal of an update-user `data`, or null when core's update
 * takes it. Better Auth's order: no data, then the password, then the
 * keys of `UPDATE_RIGHTS` (routes.mjs adminUpdateUser, read 2026-10-25).
 * Then each other field that core does not take. A field is never dropped
 * in silence.
 */
function updateDataRefusal(data: Body): AdminAnswer | null {
  const keys = Object.keys(data);
  if (keys.length === 0) return failure(NO_DATA_TO_UPDATE, 400, "No data to update");
  if (Object.hasOwn(data, "password"))
    return failure(
      PASSWORD_VIA_UPDATE,
      400,
      "core lets no operator set a password (spec section 26); the person resets it through the reset link",
    );
  for (const right of UPDATE_RIGHTS) {
    const key = right.keys.find((k) => Object.hasOwn(data, k));
    if (key !== undefined) return failure(right.code, 403, updateFieldLine(key));
  }
  const extra = keys.find((k) => !UPDATE_FIELDS.has(k));
  return extra === undefined ? null : failure(FIELD_NOT_ALLOWED, 400, updateFieldLine(extra));
}

/** Better Auth's codes of create-user (routes.mjs createUser and error-codes.mjs, read 2026-10-25). */
const SET_PASSWORD = "YOU_ARE_NOT_ALLOWED_TO_SET_USERS_PASSWORD";
const CHANGE_ROLE = "YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE";
const BAN_USERS = "YOU_ARE_NOT_ALLOWED_TO_BAN_USERS";
const INVALID_ROLE_TYPE = "INVALID_ROLE_TYPE";
const USER_EXISTS = "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL";
const INVALID_EMAIL = "INVALID_EMAIL";
const BAN_KEYS = ["banned", "banReason", "banExpires"];
const CREATE_PATH = "/admin/create-user";
/**
 * The keys of Better Auth's create-user `data` that core's operator create
 * takes (plan 12f2 Task 2). `role` is here only as the default role.
 */
const CREATE_DATA_FIELDS = new Set(["emailVerified", "image", "role"]);

/**
 * The shim's refusal of a create-user body, or null when core's create
 * takes it. Core sets no password, no role but `user`, no ban, and no
 * added field (spec section 26), so each one refuses, never drops in
 * silence. Better Auth refuses a role and a ban key with these codes when
 * the caller may not set them (routes.mjs createUser, read 2026-10-25).
 * Better Auth sets a password at create, and core never does. So a
 * password answers the code of set-user-password (plan 12f2 Task 7 item 2).
 * A body outside the object form answers null: the mapped route refuses it.
 */
function createRefusal(body: Body, platformRole: string): AdminAnswer | null {
  // Better Auth's schema takes a string or a list of strings as `role`, so
  // a null or another form answers VALIDATION_ERROR before the handler
  // (createUserBodySchema; review-12f2-task7b I2).
  const role = body.role;
  if (
    role !== undefined &&
    typeof role !== "string" &&
    !(Array.isArray(role) && role.every((r) => typeof r === "string"))
  )
    return invalid();
  if (Object.hasOwn(body, "password")) return failure(SET_PASSWORD, 403, NO_PASSWORD_SET);
  const data = dataOf(body) ?? {};
  // Better Auth reads `role`, else `data.role`, and answers INVALID_ROLE_TYPE
  // for a role that is no string (routes.mjs createUser).
  const requested = role ?? data.role;
  if (
    requested !== undefined &&
    (Array.isArray(requested) ? requested : [requested]).some((r) => typeof r !== "string")
  )
    return failure(INVALID_ROLE_TYPE, 400, "Invalid role type");
  // Better Auth reads `role`, else `data.role` (routes.mjs createUser).
  for (const role of [body.role, data.role])
    if (role !== undefined && setRoleChange(role, platformRole) !== "revoke")
      return failure(
        CHANGE_ROLE,
        403,
        `core creates a user with the role ${USER_ROLE} only; grant the platform role through /admin/set-role (spec section 26 item 1)`,
      );
  if (BAN_KEYS.some((k) => Object.hasOwn(data, k)))
    return failure(
      BAN_USERS,
      403,
      "core bans a user through /admin/ban-user only (spec section 26 item 6)",
    );
  const extra = Object.keys(data).find((k) => !CREATE_DATA_FIELDS.has(k));
  return extra === undefined
    ? null
    : failure(
        FIELD_NOT_ALLOWED,
        400,
        `core's operator create takes data.emailVerified and data.image only, not ${extra} (spec section 26)`,
      );
}

/** The `data` object of an update-user or a create-user body, or null for no object. */
function dataOf(body: unknown): Body | null {
  const v = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : null;
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Body) : null;
}

/**
 * The shim's own answer to an admin path. It refuses each call that core
 * does not serve, and each list-users query that core's reads cannot
 * answer. It refuses a set-role to a role that is not the platform role or
 * `user`, and an update-user field that core does not take. Null for
 * every other request.
 * These refusals name a config fact or the body only, so they come before
 * the session read and before any storage call.
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
    const body = await readJsonOf(request, "POST /operator/users/platform-role");
    const role =
      typeof body === "object" && body !== null ? (body as { role?: unknown }).role : null;
    if (role !== undefined && role !== null && setRoleChange(role, mapped.platformRole) === null)
      return failure(
        NOT_SUPPORTED,
        501,
        `core has one platform role: set ${mapped.platformRole} to grant it or ${USER_ROLE} to revoke it (spec section 26 item 1)`,
      );
  }
  if (path === "/admin/update-user" && request.method === "POST") {
    const body = await readJsonOf(request, "POST /operator/users/update");
    const data = dataOf(body);
    if (data !== null) return updateDataRefusal(data);
  }
  if (path === CREATE_PATH && request.method === "POST") {
    const body = await objectOf(request);
    if (body !== null) return createRefusal(body, mapped.platformRole ?? "admin");
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
  // Plan 12f2 Task 7.
  "/admin/update-user": "YOU_ARE_NOT_ALLOWED_TO_UPDATE_USERS",
  "/admin/remove-user": "YOU_ARE_NOT_ALLOWED_TO_DELETE_USERS",
  "/admin/create-user": "YOU_ARE_NOT_ALLOWED_TO_CREATE_USERS",
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
/** Better Auth's code for a remove of the caller's own user (error-codes.mjs, read 2026-10-24). */
const REMOVE_YOURSELF = "YOU_CANNOT_REMOVE_YOURSELF";

/**
 * Better Auth's user with the admin fields, from core's user row. `role`
 * is the platform role or `user`. The ban fields hold a ban that holds
 * now, by core's rule `activeBan` (spec 26 item 6). The shim keeps no copy
 * of the rule (ruling 60 L1). A ban that ended reads as no ban.
 * `twoFactorEnabled` is there with the twoFactor plugin only (ruling 60 L2).
 */
export function toAdminUser(
  row: UserRow,
  plugins: ReadonlySet<string>,
  role: string,
  now: Date,
  twoFactorEnabled?: boolean,
): AdminUser {
  const holds = activeBan(row, now);
  return {
    ...toUser(row, plugins),
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
  return toAdminUser(
    row,
    mapped.plugins,
    role,
    new Date(),
    factors ? factors.has(row.id) : undefined,
  );
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
 * `YOU_CANNOT_BAN_YOURSELF`, and on a remove `YOU_CANNOT_REMOVE_YOURSELF`.
 * The shim's actor is always a user, so
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
          : error === "operator_self" && path === "/admin/remove-user"
            ? REMOVE_YOURSELF
            : Object.hasOwn(BETTER_AUTH_CODES, error)
              ? BETTER_AUTH_CODES[error as keyof typeof BETTER_AUTH_CODES]
              : BETTER_AUTH_CODES.unexpected;
  // A hook refusal carries the app's own text (plan 9d).
  const message = typeof body?.message === "string" ? body.message : messageOf(code);
  // Better Auth answers a remove of the caller's own user with 400
  // (routes.mjs removeUser, read 2026-10-25; final-12f2-A I1). Core's
  // operator_self is 409.
  return withHeaders({ code, message }, code === REMOVE_YOURSELF ? 400 : res.status, res);
}

/** A VALIDATION_ERROR of the shim's own, before any core route runs. */
function invalid(): AdminAnswer {
  const code = BETTER_AUTH_CODES.invalid_body;
  return failure(code, 400, messageOf(code));
}

/** The JSON object of a POST, or null for no object. Each operator route takes core's floor cap. */
async function objectOf(request: Request): Promise<Body | null> {
  return readObjectOf(request);
}

/** The `userId` of a body: a string of one character or more, else null. */
function userIdOf(body: Body | null): string | null {
  const v = body?.userId;
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Core's create body of a Better Auth create-user body, or null for a body
 * that Better Auth refuses too: `email` and `name` are strings (routes.mjs
 * createUserBodySchema). `createRefusal` answered every other key first.
 * `firstSignIn` is `none`, because Better Auth mails nothing at create.
 * Core then writes no invitation and mails no link.
 */
function createBodyOf(body: Body | null): Body | null {
  if (body === null) return null;
  const { email, name } = body;
  if (typeof email !== "string" || typeof name !== "string") return null;
  if (body.data !== undefined && dataOf(body) === null) return null;
  const { emailVerified, image } = dataOf(body) ?? {};
  return {
    email,
    // Better Auth keeps an empty name; core keeps null for no name (as profilePatch).
    name: name === "" ? null : name,
    ...(emailVerified !== undefined ? { emailVerified } : {}),
    ...(image !== undefined ? { image } : {}),
    firstSignIn: "none",
    reason: adminReason(CREATE_PATH),
  };
}

/**
 * Core's refusal of a create in Better Auth's form. A taken address answers
 * Better Auth's code and status, 400 (plan 12f2 Task 7 item 2). Core
 * answers `invalid_body` for a malformed address, and Better Auth
 * `INVALID_EMAIL` 400; the rule is core's own `normalizeEmail`. Each other
 * code answers as on every admin path.
 */
async function createRefusalOf(res: Response, email: unknown): Promise<AdminAnswer> {
  const error = (
    (await res
      .clone()
      .json()
      .catch(() => null)) as Body | null
  )?.error;
  if (error === "email_taken")
    return withHeaders(
      { code: USER_EXISTS, message: "User already exists. Use another email." },
      400,
      res,
    );
  if (error === "invalid_body" && typeof email === "string" && normalizeEmail(email) === null)
    return withHeaders({ code: INVALID_EMAIL, message: "Invalid email" }, 400, res);
  return refusalOf(CREATE_PATH, res);
}

/**
 * The answer to one of the eleven admin paths that map onto core's operator
 * routes (plan 12f Tasks 10 and 11, plan 12f2 Task 7). Any other request gets null. Each
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
      mapped.handleOptions,
    );
  };
  /** The session of a token that core's answer set: the session row and the user row. */
  const sessionOf = (token: string): Promise<ResolvedSession | null> =>
    auth.session(
      new Request(`${mapped.origin}${mapped.basePath}/session`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  /**
   * The user row after an act, in Better Auth's shape with `role`. Core's
   * `familyEndFailed: true` passes through (ruling 62 m2). The act ran, but
   * the end of the OAuth refresh families failed. So the caller must end
   * the user's sessions again.
   */
  const userAfter = async (res: Response, userId: string, role: string) => {
    const done = (await res
      .clone()
      .json()
      .catch(() => null)) as { familyEndFailed?: unknown } | null;
    const row = await storage.findOne("user", [{ field: "id", op: "eq", value: userId }]);
    if (!row) throw new Error("authtempo compat: the user of an answered admin call is gone");
    const user = await adminUserOf(mapped, row, role);
    return withHeaders(
      done?.familyEndFailed === true ? { user, familyEndFailed: true } : { user },
      200,
      res,
    );
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
    // Core gives no total (a count scans the table on D1). The length of a
    // page is the total only on a first page (no `after`) that ends the
    // list (ruling 62 M2). A later page that ends the list gives no total
    // and no `next`; any other page names the next page.
    const answer =
      page.next !== null
        ? { users, limit, offset: 0, next: page.next }
        : target.query.after === undefined
          ? { users, total: users.length, limit, offset: 0 }
          : { users, limit, offset: 0 };
    return withHeaders(answer, 200, res);
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
  // A write that is not JSON gets core's answer (ruling 62 m1). A text/plain
  // post with a JSON text, or a post with no type, never acts. The rule is
  // core's own isJsonRequest, so the shim holds no copy (ruling 64).
  if (!isJsonRequest(request)) return invalid();
  const body = await objectOf(request);
  if (path === CREATE_PATH) {
    // adminRefusal answered a password, a role, a ban key, and each other key of data.
    const create = createBodyOf(body);
    if (create === null) return invalid();
    const res = await core("/operator/users/create", create);
    if (!res.ok) return createRefusalOf(res, create.email);
    const { userId } = (await res.clone().json()) as { userId: string };
    // Core creates no platform operator, so the role is `user`. Better Auth answers { user }.
    return userAfter(res, userId, USER_ROLE);
  }
  const userId = userIdOf(body);
  if (userId === null) return invalid();
  switch (path) {
    case "/admin/ban-user": {
      const ban = banBodyOf(body, new Date());
      if (ban === null) return invalid();
      const res = await core("/operator/users/ban", ban);
      // Core refuses a user actor's act on a platform operator (targetOf), and
      // the shim always acts as a user. So the target's role is `user`, with no
      // read of the role, which a ban of 501 sessions on D1 cannot afford.
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
    case "/admin/update-user": {
      // adminRefusal answered every data that core's update does not take.
      const data = dataOf(body);
      if (data === null) return invalid();
      const { name, image } = data;
      const res = await core("/operator/users/update", {
        userId,
        // Better Auth keeps an empty name; core keeps null for no name (as profilePatch).
        ...(name !== undefined ? { name: name === "" ? null : name } : {}),
        ...(image !== undefined ? { image } : {}),
        reason: adminReason(path),
      });
      if (!res.ok) return refusalOf(path, res);
      // Core refuses a user actor's act on a platform operator, so the role is `user`.
      const row = await storage.findOne("user", [{ field: "id", op: "eq", value: userId }]);
      if (!row) throw new Error("authtempo compat: the user of an answered admin call is gone");
      // Better Auth answers the user itself, not { user } (routes.mjs adminUpdateUser).
      return withHeaders(await adminUserOf(mapped, row, USER_ROLE), 200, res);
    }
    case "/admin/remove-user": {
      // Core's delete needs the scope delete; a user actor holds every scope
      // (ruling 1 B7 of plan 12f2), with a fresh session and a second factor.
      const res = await core("/operator/users/delete", { userId, reason: adminReason(path) });
      return res.ok ? withHeaders({ success: true }, 200, res) : refusalOf(path, res);
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
          mapped.plugins,
          u.platformOperator ? platformRole : USER_ROLE,
          now,
          factors ? factors.has(row.id) : undefined,
        ),
      );
  }
  return out;
}
