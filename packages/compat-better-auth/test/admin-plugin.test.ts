import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { adminClient, CLIENT_USER_KEYS, createAuthClient } from "../src/client/index.js";
import { betterAuthPasswordHash } from "../src/hash.js";
import { admin, organization } from "../src/plugins.js";
import {
  ADMIN_FORBIDDEN,
  ADMIN_NOT_SUPPORTED,
  banBodyOf,
  listUsersTarget,
  setRoleChange,
  toAdminUser,
} from "../src/server/admin.js";
import { betterAuth } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
import { mapOptions } from "../src/server/map-options.js";
import { COOKIE_NAME, SESSION_KEYS } from "../src/server/shapes.js";
import type { AdminOptions, BetterAuthOptions, CompatDatabase } from "../src/types.js";
import { adminApp, cookieOf, OPERATOR, PASSWORD } from "./admin-helpers.js";

// Plan 12f Task 13: Better Auth's admin plugin on core's operator tools
// (spec section 26 item 14, ruling 39). This file holds the options, the
// refusals, and the mapping logic. It also holds the calls that reach
// core's operator routes of Task 10 and the impersonation routes of Task 11.

const BASE = "https://api.example.com";
const fast = betterAuthPasswordHash({ pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }) });
const memoryDatabase = (): CompatDatabase => ({
  kind: "authtempo-compat-database",
  dialect: "postgres",
  storage: createMemoryAdapter(),
  limiter: createMemoryLimiter(systemClock),
});

function options(
  adminOptions: AdminOptions | null = {},
  extra: Partial<BetterAuthOptions> = {},
): BetterAuthOptions {
  return {
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    database: memoryDatabase(),
    authtempo: { passwordHash: fast, platformOrganization: "platform-co" },
    plugins: [
      organization({ sendInvitationEmail: async () => {} }),
      ...(adminOptions ? [admin(adminOptions)] : []),
    ],
    ...extra,
  };
}

/** Core's organizations config of a mapping, or undefined when it is off. */
const orgOf = (m: ReturnType<typeof mapOptions>) => m.config.organizations || undefined;

/** The refusals of checkOptions whose path starts with `prefix`. */
const refusalsAt = (o: BetterAuthOptions, prefix: string) =>
  checkOptions(o).refusals.filter((r) => r.startsWith(prefix));

const post = (path: string, body: unknown) =>
  new Request(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify(body),
  });

describe("the admin plugin options (plan 12f)", () => {
  it("accepts adminRoles of one rank and impersonationSessionDuration in whole minutes from 5 to 240", () => {
    for (const a of [
      {},
      { adminRoles: "admin" },
      { adminRoles: ["owner"] },
      { adminRoles: ["admin", "admin"] },
      { impersonationSessionDuration: 300 },
      { impersonationSessionDuration: 14_400 },
      { allowImpersonatingAdmins: false },
      // Better Auth's default role changes nothing.
      { defaultRole: "user" },
    ])
      expect({ a, check: checkOptions(options(a)) }).toEqual({
        a,
        check: { refusals: [], notes: [] },
      });
  });

  it("maps the platform role, the platform organization, and the tools onto core's config", () => {
    const m = mapOptions(options({ adminRoles: ["owner"], impersonationSessionDuration: 900 }));
    const org = orgOf(m);
    expect(org && { role: org.platformRole, slug: org.platformOrganization }).toEqual({
      role: "owner",
      slug: "platform-co",
    });
    expect(org?.ranks).toEqual({ viewer: 1, member: 2, admin: 3, owner: 4 });
    expect(m.config.operator).toEqual({ users: true, impersonation: { ttlMinutes: 15 } });
    expect(m.platformRole).toBe("owner");
    // Better Auth's defaults: adminRoles ["admin"], one hour of impersonation.
    const d = mapOptions(options({}));
    expect(orgOf(d)?.platformRole).toBe("admin");
    expect(d.config.operator).toEqual({ users: true, impersonation: { ttlMinutes: 60 } });
    // Without the plugin: no platform role and no operator tool.
    const none = mapOptions(options(null, { authtempo: { passwordHash: fast } }));
    expect(orgOf(none)?.platformRole).toBeUndefined();
    expect(none.config.operator).toBeUndefined();
    expect(none.platformRole).toBeNull();
    // Core takes the mapped config.
    expect(() => betterAuth(options({ impersonationSessionDuration: 900 }))).not.toThrow();
  });

  it("refuses the unmapped admin options and calls with a line that names section 26", () => {
    const refused: AdminOptions = {
      defaultRole: "member",
      defaultBanReason: "spam",
      defaultBanExpiresIn: 60,
      bannedUserMessage: "go away",
      adminUserIds: ["u1"],
      allowImpersonatingAdmins: true,
      schema: {},
      ac: {},
      roles: {},
    };
    const lines = refusalsAt(options(refused), "plugins[admin].");
    expect(lines.map((l) => l.slice(0, l.indexOf(":")))).toEqual(
      [
        "plugins[admin].ac",
        "plugins[admin].adminUserIds",
        "plugins[admin].allowImpersonatingAdmins",
        "plugins[admin].bannedUserMessage",
        "plugins[admin].defaultBanExpiresIn",
        "plugins[admin].defaultBanReason",
        "plugins[admin].defaultRole",
        "plugins[admin].roles",
        "plugins[admin].schema",
      ].sort(),
    );
    for (const l of lines) expect(l).toMatch(/\(spec section 26 item \d+\)$/);
    // A key Better Auth does not have also names section 26.
    expect(
      refusalsAt(options({ notAnOption: true } as AdminOptions), "plugins[admin].notAnOption"),
    ).toEqual([
      "plugins[admin].notAnOption: not mapped onto core's operator tools (spec section 26 item 14)",
    ]);
    for (const adminRoles of ["superadmin", ["admin", "owner"], "admin,user", "user", []])
      expect({ adminRoles, lines: refusalsAt(options({ adminRoles }), "plugins[admin]") }).toEqual({
        adminRoles,
        lines: [
          "plugins[admin].adminRoles: core has one platform role: name exactly one rank of viewer, member, admin, owner (spec section 26 item 1)",
        ],
      });
    for (const impersonationSessionDuration of [60, 90, 330, 14_460, 3600.5])
      expect(refusalsAt(options({ impersonationSessionDuration }), "plugins[admin]")).toEqual([
        "plugins[admin].impersonationSessionDuration: core takes a whole number of minutes from 5 to 240 (spec section 26 item 3)",
      ]);
  });

  it("refuses the admin plugin without organization() or the platform organization, and the slug without the plugin", () => {
    expect(refusalsAt(options({}, { plugins: [admin()] }), "plugins[admin]")).toEqual([
      "plugins[admin]: needs plugins[organization]: the platform role is a rank in the platform organization (spec section 26 item 1)",
    ]);
    expect(
      refusalsAt(options({}, { authtempo: { passwordHash: fast } }), "plugins[admin]"),
    ).toEqual([
      "plugins[admin]: needs authtempo.platformOrganization, the slug of the platform organization (spec section 26 item 1)",
    ]);
    expect(refusalsAt(options(null), "authtempo")).toEqual([
      "authtempo.platformOrganization: only with plugins[admin]",
    ]);
    expect(
      refusalsAt(
        options({}, { authtempo: { passwordHash: fast, platformOrganization: "Not a slug!" } }),
        "authtempo",
      ),
    ).toEqual(["authtempo.platformOrganization: expected a slug"]);
    // Better Auth's own plugin object is not this package's plugin.
    expect(
      checkOptions({ ...options(null), plugins: [{ id: "admin" }] }).refusals.filter((r) =>
        r.startsWith("plugins[admin]"),
      ),
    ).toEqual(["plugins[admin]: authtempo has no such plugin"]);
  });
});

describe("the admin calls that core does not serve (plan 12f)", () => {
  it("answers NOT_SUPPORTED with a line that names section 26 for each, and 404 without the plugin", async () => {
    const on = betterAuth(options());
    const off = betterAuth(options(null, { authtempo: { passwordHash: fast } }));
    expect(Object.keys(ADMIN_NOT_SUPPORTED).sort()).toEqual([
      "/admin/create-user",
      "/admin/has-permission",
      "/admin/list-user-sessions",
      "/admin/remove-user",
      "/admin/revoke-user-session",
      "/admin/set-user-password",
      "/admin/update-user",
    ]);
    for (const path of Object.keys(ADMIN_NOT_SUPPORTED)) {
      const res = await on.handler(post(path, { userId: "u1", newPassword: "x".repeat(12) }));
      const body = (await res.json()) as { code: string; message: string };
      expect({ path, status: res.status, code: body.code }).toEqual({
        path,
        status: 501,
        code: "NOT_SUPPORTED",
      });
      expect(body.message).toMatch(/\(spec section 26 items? [\d and]+\)$/);
      expect({ path, status: (await off.handler(post(path, { userId: "u1" }))).status }).toEqual({
        path,
        status: 404,
      });
    }
    const remove = await on.handler(post("/admin/remove-user", { userId: "u1" }));
    expect(((await remove.json()) as { message: string }).message).toContain(
      "an operator bans, and the person resets the password or deletes the account",
    );
  });

  it("refuses a list-users query that core's reads cannot answer", async () => {
    const auth = betterAuth(options());
    const refusals = [
      "searchValue=ann",
      "searchValue=ann&searchOperator=contains",
      "searchValue=ann&searchOperator=ends_with",
      "searchValue=ann&searchField=name&searchOperator=starts_with",
      "filterField=role&filterValue=admin",
      "filterField=email&filterValue=a%40example.com&filterOperator=ne",
      "searchValue=ann&searchOperator=starts_with&filterField=id&filterValue=u1",
      "sortBy=createdAt",
      "sortDirection=desc",
      "offset=10",
      // An offset with core's cursor too: a silent offset would give a wrong page (ruling 53).
      "offset=10&after=u2",
      "offset=1&limit=2",
      "offset=-1",
      "limit=101",
      "limit=0",
      "limit=ten",
    ];
    for (const q of refusals) {
      const res = await auth.handler(new Request(`${BASE}/api/auth/admin/list-users?${q}`));
      const body = (await res.json()) as { code: string; message: string };
      expect({ q, status: res.status, code: body.code }).toEqual({
        q,
        status: 501,
        code: "NOT_SUPPORTED",
      });
      expect(body.message).toMatch(/\(spec section 26 item 4\)/);
    }
  });

  it("refuses a set-role to a role that is not the platform role or user", async () => {
    const auth = betterAuth(options({ adminRoles: "admin" }));
    for (const role of ["editor", "owner", ["admin", "user"], "admin,owner"]) {
      const res = await auth.handler(post("/admin/set-role", { userId: "u1", role }));
      const body = (await res.json()) as { code: string; message: string };
      expect({ role, status: res.status, code: body.code }).toEqual({
        role,
        status: 501,
        code: "NOT_SUPPORTED",
      });
      expect(body.message).toBe(
        "core has one platform role: set admin to grant it or user to revoke it (spec section 26 item 1)",
      );
    }
    // The platform role and user pass this step: core's route answers them.
    for (const role of ["admin", "user", ["admin"]]) {
      const res = await auth.handler(post("/admin/set-role", { userId: "u1", role }));
      expect({ role, notRefused: res.status !== 501 }).toEqual({ role, notRefused: true });
    }
  });
});

describe("the mapping logic of the admin calls (plan 12f)", () => {
  it("maps a list-users query onto core's list and search reads", () => {
    const t = (q: string) => listUsersTarget(new URLSearchParams(q));
    expect(t("")).toEqual({ ok: true, path: "/operator/users", query: {} });
    expect(t("limit=25&offset=0&sortDirection=asc")).toEqual({
      ok: true,
      path: "/operator/users",
      query: { limit: "25" },
    });
    expect(t("searchValue=ann&searchField=email&searchOperator=starts_with&limit=100")).toEqual({
      ok: true,
      path: "/operator/users/search",
      query: { limit: "100", emailPrefix: "ann" },
    });
    // An empty searchValue is no search, as in Better Auth.
    expect(t("searchValue=&searchOperator=contains")).toEqual({
      ok: true,
      path: "/operator/users",
      query: {},
    });
    expect(t("filterValue=a%40example.com")).toEqual({
      ok: true,
      path: "/operator/users/search",
      query: { email: "a@example.com" },
    });
    expect(t("filterField=id&filterValue=u1&filterOperator=eq")).toEqual({
      ok: true,
      path: "/operator/users/search",
      query: { id: "u1" },
    });
    // The shim's own key: the next page after core's cursor.
    expect(t("limit=2&after=u2")).toEqual({
      ok: true,
      path: "/operator/users",
      query: { limit: "2", after: "u2" },
    });
  });

  it("maps a ban-user body onto core's ban: the reason, else the path, and the end in seconds", () => {
    const now = new Date("2026-10-21T00:00:00.000Z");
    expect(banBodyOf({ userId: "u1" }, now)).toEqual({
      userId: "u1",
      reason: "better-auth admin plugin /admin/ban-user",
    });
    expect(banBodyOf({ userId: "u1", banReason: "", banExpiresIn: 3600 }, now)).toEqual({
      userId: "u1",
      reason: "better-auth admin plugin /admin/ban-user",
      until: "2026-10-21T01:00:00.000Z",
    });
    expect(banBodyOf({ userId: "u1", banReason: "spam", banExpiresIn: 90 }, now)).toEqual({
      userId: "u1",
      reason: "spam",
      until: "2026-10-21T00:01:30.000Z",
    });
    for (const bad of [
      null,
      [],
      {},
      { userId: "" },
      { userId: 7 },
      { userId: "u1", banReason: 5 },
      { userId: "u1", banExpiresIn: "60" },
      { userId: "u1", banExpiresIn: 0 },
      { userId: "u1", banExpiresIn: -60 },
      { userId: "u1", banExpiresIn: Number.POSITIVE_INFINITY },
    ])
      expect({ bad, out: banBodyOf(bad, now) }).toEqual({ bad, out: null });
  });

  it("maps set-role onto a grant for the platform role and a revoke for user, else nothing", () => {
    expect(setRoleChange("admin", "admin")).toBe("grant");
    expect(setRoleChange(["admin"], "admin")).toBe("grant");
    expect(setRoleChange(" admin ", "admin")).toBe("grant");
    expect(setRoleChange("user", "admin")).toBe("revoke");
    expect(setRoleChange(["user", "user"], "admin")).toBe("revoke");
    for (const role of ["owner", "member", "editor", "admin,user", ["admin", "user"], [1], 3, null])
      expect({ role, change: setRoleChange(role, "admin") }).toEqual({ role, change: null });
    expect(setRoleChange("owner", "owner")).toBe("grant");
  });
});

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const ADMIN_USER_KEYS = [
  "banExpires",
  "banReason",
  "banned",
  "createdAt",
  "email",
  "emailVerified",
  "id",
  "image",
  "name",
  "role",
  "twoFactorEnabled",
  "updatedAt",
];

describe("the admin calls on core's operator routes (plan 12f Task 10)", () => {
  it("maps the admin plugin calls onto the operator tools", async () => {
    const a = await adminApp(memoryDatabase());
    const ann = await a.user("ann@example.com");
    const anna = await a.user("anna@example.com");
    const bob = await a.user("bob@example.com");

    // list-users by prefix: core's search by the start of the address, by address.
    const listed = await json(
      await a.read("/admin/list-users?searchValue=ann&searchOperator=starts_with", a.op),
    );
    expect(listed.status).toBe(200);
    expect(listed.body.users.map((u: { email: string }) => u.email)).toEqual([
      "ann@example.com",
      "anna@example.com",
    ]);
    expect(Object.keys(listed.body.users[0]).sort()).toEqual(ADMIN_USER_KEYS);
    expect(listed.body).toMatchObject({ total: 2, offset: 0 });
    expect(listed.body.users[0]).toMatchObject({ role: "user", banned: false, banReason: null });
    // A page that does not end the list names the next page, and the next page ends it.
    const first = await json(await a.read("/admin/list-users?limit=2", a.op));
    expect(first.body.total).toBeUndefined();
    expect(first.body.users).toHaveLength(2);
    const second = await json(
      await a.read(`/admin/list-users?limit=2&after=${first.body.next}`, a.op),
    );
    expect(second.body.users).toHaveLength(2);
    // The last page of four users: its length is no total, and no next page follows (ruling 62 M2).
    expect(second.body.total).toBeUndefined();
    expect(second.body.next).toBeUndefined();
    expect(second.body).toMatchObject({ limit: 2, offset: 0 });
    const everyone = [...first.body.users, ...second.body.users];
    expect(everyone.find((u: { email: string }) => u.email === OPERATOR).role).toBe("admin");
    // An exact id through filterField.
    const byId = await json(
      await a.read(`/admin/list-users?filterField=id&filterValue=${bob.id}`, a.op),
    );
    expect(byId.body.users.map((u: { id: string }) => u.id)).toEqual([bob.id]);

    // get-user answers the user itself.
    const got = await json(await a.read(`/admin/get-user?id=${ann.id}`, a.op));
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: ann.id, email: "ann@example.com", role: "user" });
    expect(await json(await a.read("/admin/get-user?id=nobody", a.op))).toEqual({
      status: 404,
      body: { code: "USER_NOT_FOUND", message: "User not found" },
    });

    // ban-user with a reason and an end in seconds.
    const before = Date.now();
    const banned = await json(
      await a.call(
        "/admin/ban-user",
        { userId: ann.id, banReason: "Spam", banExpiresIn: 3600 },
        a.op,
      ),
    );
    expect(banned.status).toBe(200);
    expect(banned.body.user).toMatchObject({ id: ann.id, banned: true, banReason: "Spam" });
    const end = Date.parse(banned.body.user.banExpires);
    expect(end).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(end).toBeLessThanOrEqual(Date.now() + 3_600_000);
    // The ban holds at core's doors: the session ended, and a sign-in is refused.
    expect(await (await a.read("/get-session", ann.cookie)).json()).toBeNull();
    expect(
      await json(
        await a.call("/password/sign-in", { email: "ann@example.com", password: PASSWORD }),
      ),
    ).toMatchObject({ status: 403, body: { error: "account_banned" } });

    // unban-user.
    const unbanned = await json(await a.call("/admin/unban-user", { userId: ann.id }, a.op));
    expect(unbanned.status).toBe(200);
    expect(unbanned.body.user).toMatchObject({
      id: ann.id,
      banned: false,
      banReason: null,
      banExpires: null,
    });

    // revoke-user-sessions ends every session of the user.
    expect(
      await json(await a.call("/admin/revoke-user-sessions", { userId: bob.id }, a.op)),
    ).toEqual({ status: 200, body: { success: true } });
    expect(await (await a.read("/get-session", bob.cookie)).json()).toBeNull();

    // set-role: the platform role grants it, and user revokes it.
    const granted = await json(
      await a.call("/admin/set-role", { userId: anna.id, role: "admin" }, a.op),
    );
    expect(granted).toMatchObject({ status: 200, body: { user: { id: anna.id, role: "admin" } } });
    const annaNow = await json(await a.read(`/admin/get-user?id=${anna.id}`, a.op));
    expect(annaNow.body.role).toBe("admin");
    // A user actor acts on no other platform operator (spec 26 item 1), so a
    // revoke of anna's role needs a secret or the app. A revoke of bob changes no role.
    expect(
      await json(await a.call("/admin/set-role", { userId: anna.id, role: "user" }, a.op)),
    ).toMatchObject({ status: 403, body: { code: "YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE" } });
    // A ban and an unban answer { user } with the role user. So they must
    // never act on a platform operator: each is refused, and anna keeps her role.
    for (const path of ["/admin/ban-user", "/admin/unban-user"])
      expect(await json(await a.call(path, { userId: anna.id }, a.op))).toEqual({
        status: 403,
        body: { code: "YOU_ARE_NOT_ALLOWED_TO_BAN_USERS", message: expect.any(String) },
      });
    expect((await json(await a.read(`/admin/get-user?id=${anna.id}`, a.op))).body).toMatchObject({
      role: "admin",
      banned: false,
    });
    const revoked = await json(
      await a.call("/admin/set-role", { userId: bob.id, role: "user" }, a.op),
    );
    expect(revoked).toMatchObject({ status: 200, body: { user: { id: bob.id, role: "user" } } });

    // Each act wrote core's audit row, with the operator as the actor.
    const by = { actorKind: "user", actorId: a.opId };
    expect(await a.audit(ann.id)).toEqual([
      { action: "ban", ...by, reason: "Spam" },
      { action: "unban", ...by, reason: "better-auth admin plugin /admin/unban-user" },
    ]);
    expect(await a.audit(bob.id)).toEqual([
      {
        action: "sessions_end_user",
        ...by,
        reason: "better-auth admin plugin /admin/revoke-user-sessions",
      },
      { action: "platform_role_revoke", ...by, reason: "better-auth admin plugin /admin/set-role" },
    ]);
    expect(await a.audit(anna.id)).toEqual([
      { action: "platform_role_grant", ...by, reason: "better-auth admin plugin /admin/set-role" },
    ]);

    // The operator's own user: Better Auth's code on a ban, core's FORBIDDEN on
    // another act. The status stays core's, 409.
    expect(await json(await a.call("/admin/ban-user", { userId: a.opId }, a.op))).toEqual({
      status: 409,
      body: { code: "YOU_CANNOT_BAN_YOURSELF", message: "You cannot ban yourself" },
    });
    // The README names these three as deviations (ruling 60 L3).
    for (const [path, body] of [
      ["/admin/revoke-user-sessions", { userId: a.opId }],
      ["/admin/unban-user", { userId: a.opId }],
      ["/admin/set-role", { userId: a.opId, role: "user" }],
    ] as const)
      expect({ path, ...(await json(await a.call(path, body, a.op))) }).toMatchObject({
        path,
        status: 409,
        body: { code: "FORBIDDEN" },
      });
    // A body that Better Auth refuses too, and no session.
    expect((await a.call("/admin/ban-user", { userId: "" }, a.op)).status).toBe(400);
    expect(await json(await a.call("/admin/unban-user", { userId: ann.id }))).toMatchObject({
      status: 401,
      body: { code: "UNAUTHORIZED" },
    });
  });

  it("answers success false with more while sessions stay, and success at the last page", async () => {
    // A limiter that allows each call: 501 sign-ins of one user, past the page of 500.
    const a = await adminApp({ ...memoryDatabase(), limiter: { allow: async () => true } });
    const ann = await a.user("ann@example.com");
    for (let i = 0; i < 500; i++)
      await a.call("/password/sign-in", { email: "ann@example.com", password: PASSWORD });
    const revoke = () => a.call("/admin/revoke-user-sessions", { userId: ann.id }, a.op);
    expect(await json(await revoke())).toEqual({
      status: 200,
      body: { success: false, more: true, ended: 500 },
    });
    expect(await (await a.read("/get-session", ann.cookie)).json()).toBeNull();
    expect(await json(await revoke())).toEqual({ status: 200, body: { success: true } });
    expect((await a.audit(ann.id)).map((r) => r.action)).toEqual([
      "sessions_end_user",
      "sessions_end_user",
    ]);
  });

  it("refuses a write that is not JSON with VALIDATION_ERROR, and changes nothing (ruling 62 m1)", async () => {
    const a = await adminApp(memoryDatabase());
    const ann = await a.user("ann@example.com");
    const text = JSON.stringify({ userId: ann.id, banReason: "Spam" });
    for (const type of ["text/plain", null]) {
      // A text body gets the type text/plain, so the row with no type sends bytes.
      const request = new Request(`${BASE}/api/auth/admin/ban-user`, {
        method: "POST",
        headers: { origin: BASE, cookie: a.op, ...(type === null ? {} : { "content-type": type }) },
        body: type === null ? new TextEncoder().encode(text) : text,
      });
      expect(request.headers.get("content-type")).toBe(type);
      const res = await a.auth.handler(request);
      expect({
        type,
        status: res.status,
        code: ((await res.json()) as { code: string }).code,
      }).toEqual({
        type,
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }
    expect(await a.audit(ann.id)).toEqual([]);
    expect(await (await a.read("/get-session", ann.cookie)).json()).toMatchObject({
      user: { banned: false },
    });
  });

  it("gives get-session the role and the ban fields of the admin plugin (ruling 53)", async () => {
    const a = await adminApp(memoryDatabase());
    const ann = await a.user("ann@example.com");
    const session = async (cookie: string) => {
      const res = await a.read("/get-session", cookie);
      const body = (await res.json()) as { user: Record<string, unknown> } | null;
      return (
        body && {
          role: body.user.role,
          banned: body.user.banned,
          banReason: body.user.banReason,
          banExpires: body.user.banExpires,
        }
      );
    };
    const none = { banned: false, banReason: null, banExpires: null };
    expect(await session(a.op)).toEqual({ role: "admin", ...none });
    expect(await session(ann.cookie)).toEqual({ role: "user", ...none });
    // The server api gives the same fields.
    const api = await a.auth.api.getSession({ headers: new Headers({ cookie: a.op }) });
    expect(api?.user.role).toBe("admin");
    // A banned user has no session: the ban ended it, and a sign-in is refused.
    await a.call("/admin/ban-user", { userId: ann.id, banReason: "Spam" }, a.op);
    expect(await session(ann.cookie)).toBeNull();
    // After the unban, core's row keeps the ban time and the reason, and the ban no longer holds.
    await a.call("/admin/unban-user", { userId: ann.id }, a.op);
    const again = await a.call("/password/sign-in", {
      email: "ann@example.com",
      password: PASSWORD,
    });
    expect(await session(cookieOf(again))).toEqual({ role: "user", ...none });
  });

  it("reads the platform role by the slug that core resolves (ruling 60 M1)", async () => {
    // The app writes the slug in upper case. Core folds it to lower case.
    const m = mapOptions(
      options({}, { authtempo: { passwordHash: fast, platformOrganization: "Platform-Co" } }),
    );
    expect(orgOf(m)?.platformOrganization).toBe("platform-co");
    const a = await adminApp(memoryDatabase(), { slug: "Platform-Co" });
    const ann = await a.user("ann@example.com");
    const roleIn = async (cookie: string) =>
      ((await (await a.read("/get-session", cookie)).json()) as { user: { role: string } }).user
        .role;
    const listed = await json(await a.read("/admin/list-users", a.op));
    const roles = Object.fromEntries(
      listed.body.users.map((u: { email: string; role: string }) => [u.email, u.role]),
    );
    // get-session and list-users give each user one role.
    expect({ op: await roleIn(a.op), ann: await roleIn(ann.cookie) }).toEqual({
      op: "admin",
      ann: "user",
    });
    expect(roles).toEqual({ [OPERATOR]: "admin", "ann@example.com": "user" });
  });

  it("gives each admin user twoFactorEnabled with the twoFactor plugin (ruling 60 L2)", async () => {
    const a = await adminApp(memoryDatabase());
    const ann = await a.user("ann@example.com");
    const factorOf = (users: { email: string; twoFactorEnabled?: boolean }[]) =>
      Object.fromEntries(users.map((u) => [u.email, u.twoFactorEnabled]));
    const listed = await json(await a.read("/admin/list-users", a.op));
    expect(factorOf(listed.body.users)).toEqual({ [OPERATOR]: true, "ann@example.com": false });
    const got = await json(await a.read(`/admin/get-user?id=${a.opId}`, a.op));
    expect(got.body.twoFactorEnabled).toBe(true);
    const start = await json(await a.call("/admin/impersonate-user", { userId: ann.id }, a.op));
    expect(start.body.user.twoFactorEnabled).toBe(false);
    const banned = await json(await a.call("/admin/ban-user", { userId: ann.id }, a.op));
    expect(banned.body.user.twoFactorEnabled).toBe(false);
    // Without the plugin, the key is not there, as in Better Auth's user.
    const now = new Date();
    const row = {
      id: "u1",
      email: "pat@example.com",
      emailVerified: true,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(Object.keys(toAdminUser(row, "user", now))).not.toContain("twoFactorEnabled");
  });

  it("gives the client session the role and the ban fields with adminClient() (ruling 54)", async () => {
    const a = await adminApp(memoryDatabase());
    const ann = await a.user("ann@example.com");
    const seen: string[] = [];
    const client = (cookie: string, admin = true) =>
      createAuthClient({
        baseURL: `${BASE}/api/auth`,
        fetchOptions: {
          headers: cookie ? { cookie } : {},
          customFetchImpl: async (input, init) => {
            const req = new Request(input, init);
            seen.push(`${req.method} ${new URL(req.url).pathname}`);
            return a.auth.handler(req);
          },
        },
        ...(admin ? { plugins: [adminClient()] } : {}),
      });
    const none = { banned: false, banReason: null, banExpires: null };
    const op = await client(a.op).getSession();
    expect(op.error).toBeNull();
    expect(op.data?.user).toMatchObject({ email: OPERATOR, role: "admin", ...none });
    expect(Object.keys(op.data?.user ?? {}).sort()).toEqual(
      [...CLIENT_USER_KEYS, "role", "banned", "banReason", "banExpires"].sort(),
    );
    expect(op.data?.session.expiresAt).toBeInstanceOf(Date);
    expect(seen).toEqual(["GET /api/auth/get-session"]);
    const annSession = await client(ann.cookie).getSession();
    expect(annSession.data?.user).toMatchObject({
      email: "ann@example.com",
      role: "user",
      ...none,
    });
    // No session: null and no error, as Better Auth's client answers.
    expect(await client("").getSession()).toEqual({ data: null, error: null });
    // Without adminClient(), the client reads core's session and keeps the five user keys.
    seen.length = 0;
    const plain = await client(a.op, false).getSession();
    expect(Object.keys(plain.data?.user ?? {}).sort()).toEqual([...CLIENT_USER_KEYS].sort());
    expect(seen).toEqual(["GET /api/auth/session"]);
  });

  it("refreshes a due session through POST /get-session with adminClient(), and keeps the GET answer when it fails", async () => {
    const answer = (id: string) => ({
      session: {
        id,
        userId: "u1",
        expiresAt: "2026-01-08T00:00:00.000Z",
        activeOrganizationId: null,
      },
      user: {
        id: "u1",
        name: "",
        email: "pat@example.com",
        emailVerified: true,
        image: null,
        role: "admin",
        banned: false,
        banReason: null,
        banExpires: null,
      },
      needsRefresh: id === "s-get",
    });
    const run = async (post: () => Response, get = () => Response.json(answer("s-get"))) => {
      const seen: string[] = [];
      const c = createAuthClient({
        baseURL: `${BASE}/api/auth`,
        plugins: [adminClient()],
        fetchOptions: {
          customFetchImpl: async (input, init) => {
            const req = new Request(input, init);
            seen.push(`${req.method} ${new URL(req.url).pathname}`);
            return req.method === "POST" ? post() : get();
          },
        },
      });
      const r = await c.getSession();
      return {
        error: r.error && { code: r.error.code, status: r.error.status },
        session: r.data?.session.id,
        role: r.data?.user.role,
        seen,
      };
    };
    const calls = ["GET /api/auth/get-session", "POST /api/auth/get-session"];
    expect(await run(() => Response.json(answer("s-post")))).toEqual({
      error: null,
      session: "s-post",
      role: "admin",
      seen: calls,
    });
    expect(await run(() => new Response("<html>bad gateway</html>", { status: 502 }))).toEqual({
      error: null,
      session: "s-get",
      role: "admin",
      seen: calls,
    });
    // A failed GET answers an error and no session: core's body has no Better Auth code.
    const failed = () => Response.json({ error: "unexpected" }, { status: 500 });
    expect(await run(failed, failed)).toEqual({
      error: { code: "UNEXPECTED_RESPONSE", status: 500 },
      session: undefined,
      role: undefined,
      seen: ["GET /api/auth/get-session"],
    });
    const down = () => {
      throw new TypeError("fetch failed");
    };
    expect(await run(down, down)).toEqual({
      error: { code: "NETWORK_ERROR", status: 0 },
      session: undefined,
      role: undefined,
      seen: ["GET /api/auth/get-session"],
    });
  });

  it("refuses an admin with no second factor", async () => {
    const a = await adminApp(memoryDatabase(), { factor: false });
    const ann = await a.user("ann@example.com");
    const ban = await json(await a.call("/admin/ban-user", { userId: ann.id }, a.op));
    expect(ban).toEqual({
      status: 403,
      body: {
        code: "YOU_ARE_NOT_ALLOWED_TO_BAN_USERS",
        message: "You are not allowed to ban users",
      },
    });
    // No change and no audit row.
    expect(await (await a.read("/get-session", ann.cookie)).json()).not.toBeNull();
    expect(await a.audit(ann.id)).toEqual([]);
    // Each mapped path answers Better Auth's name of its own refused action.
    const calls: [string, () => Promise<Response>][] = [
      ["/admin/list-users", () => a.read("/admin/list-users", a.op)],
      ["/admin/get-user", () => a.read(`/admin/get-user?id=${ann.id}`, a.op)],
      ["/admin/ban-user", () => a.call("/admin/ban-user", { userId: ann.id }, a.op)],
      ["/admin/unban-user", () => a.call("/admin/unban-user", { userId: ann.id }, a.op)],
      ["/admin/set-role", () => a.call("/admin/set-role", { userId: ann.id, role: "admin" }, a.op)],
      [
        "/admin/revoke-user-sessions",
        () => a.call("/admin/revoke-user-sessions", { userId: ann.id }, a.op),
      ],
      [
        "/admin/impersonate-user",
        () => a.call("/admin/impersonate-user", { userId: ann.id }, a.op),
      ],
    ];
    expect(calls.map(([p]) => p).sort()).toEqual(Object.keys(ADMIN_FORBIDDEN).sort());
    const codes: Record<string, unknown> = {};
    for (const [path, send] of calls) {
      const res = await send();
      codes[path] = [res.status, ((await res.json()) as { code: string }).code];
    }
    expect(codes).toEqual({
      "/admin/list-users": [403, "YOU_ARE_NOT_ALLOWED_TO_LIST_USERS"],
      "/admin/get-user": [403, "YOU_ARE_NOT_ALLOWED_TO_GET_USER"],
      "/admin/ban-user": [403, "YOU_ARE_NOT_ALLOWED_TO_BAN_USERS"],
      "/admin/unban-user": [403, "YOU_ARE_NOT_ALLOWED_TO_BAN_USERS"],
      "/admin/set-role": [403, "YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE"],
      "/admin/revoke-user-sessions": [403, "YOU_ARE_NOT_ALLOWED_TO_REVOKE_USERS_SESSIONS"],
      "/admin/impersonate-user": [403, "YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS"],
    });
    expect(await a.audit(ann.id)).toEqual([]);
  });
});

/** The value of a cookie that a response sets, or null. */
const setCookie = (res: Response, name: string) => {
  const c = res.headers.getSetCookie().find((v) => v.startsWith(`${name}=`));
  return c === undefined ? null : (c.slice(name.length + 1).split(";")[0] ?? "");
};
const ACTOR = `${COOKIE_NAME}_actor`;
const IMPERSONATE = "/admin/impersonate-user";
const STOP = "/admin/stop-impersonating";

describe("the impersonation calls on core's routes (plan 12f Task 11)", () => {
  it("maps impersonate-user and stop-impersonating onto core's impersonation, with Better Auth's shapes", async () => {
    const a = await adminApp(memoryDatabase());
    const ann = await a.user("ann@example.com");
    const opToken = a.op.slice(COOKIE_NAME.length + 1);

    const before = Date.now();
    const start = await a.call(IMPERSONATE, { userId: ann.id }, a.op);
    const started = await json(start.clone());
    expect(started.status).toBe(200);
    expect(Object.keys(started.body).sort()).toEqual(["session", "user"]);
    expect(Object.keys(started.body.session).sort()).toEqual(
      [...SESSION_KEYS, "impersonatedBy"].sort(),
    );
    expect(started.body.session).toMatchObject({ userId: ann.id, impersonatedBy: a.opId });
    expect(started.body.user).toMatchObject({ id: ann.id, role: "user", banned: false });
    // Better Auth's default life of one hour, which the shim maps to 60 minutes.
    const end = Date.parse(started.body.session.expiresAt);
    expect(end).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(end).toBeLessThanOrEqual(Date.now() + 3_600_000);
    // The session cookie holds the new token, and the actor cookie keeps the operator's.
    const token = setCookie(start, COOKIE_NAME);
    expect(token).toBe(started.body.session.token);
    expect(setCookie(start, ACTOR)).toBe(opToken);
    const imp = `${COOKIE_NAME}=${token}`;
    const both = `${imp}; ${ACTOR}=${opToken}`;

    // get-session names the operator of an impersonation session, and null for any other.
    const read = async (cookie: string) => (await a.read("/get-session", cookie)).json();
    expect(await read(imp)).toMatchObject({
      session: { userId: ann.id, impersonatedBy: a.opId },
      user: { id: ann.id, role: "user" },
    });
    expect(await read(a.op)).toMatchObject({ session: { impersonatedBy: null } });
    const api = await a.auth.api.getSession({ headers: new Headers({ cookie: imp }) });
    expect(api?.session.impersonatedBy).toBe(a.opId);

    // An impersonation session cannot start another one.
    expect(await json(await a.call(IMPERSONATE, { userId: ann.id }, both))).toMatchObject({
      status: 403,
      body: { code: "FORBIDDEN" },
    });

    // The stop ends the session, and the operator's session comes back.
    const stop = await a.call(STOP, undefined, both);
    const stopped = await json(stop.clone());
    expect(stopped.status).toBe(200);
    expect(stopped.body.session).toMatchObject({
      userId: a.opId,
      token: opToken,
      impersonatedBy: null,
    });
    expect(stopped.body.user).toMatchObject({ id: a.opId, email: OPERATOR, role: "admin" });
    expect(setCookie(stop, COOKIE_NAME)).toBe(opToken);
    expect(setCookie(stop, ACTOR)).toBe("");
    expect(await read(imp)).toBeNull();
    expect(await read(a.op)).toMatchObject({ user: { id: a.opId } });

    // Core's audit rows of the start and the stop, with the operator as the actor.
    // Two ids of one millisecond have no order (a ULID), so the rows go by action.
    const by = { actorKind: "user", actorId: a.opId };
    const rows = (await a.audit(ann.id)).sort((x, y) => x.action.localeCompare(y.action));
    expect(rows).toEqual([
      { action: "impersonation_start", ...by, reason: `better-auth admin plugin ${IMPERSONATE}` },
      { action: "impersonation_stop", ...by, reason: `better-auth admin plugin ${STOP}` },
    ]);
  });

  it("answers Better Auth's refusals of an impersonation, and the bearer form", async () => {
    const a = await adminApp(memoryDatabase());
    const ann = await a.user("ann@example.com");
    // A stop by a session that impersonates nobody: Better Auth's 400 and its text.
    expect(await json(await a.call(STOP, undefined, a.op))).toEqual({
      status: 400,
      body: { message: "You are not impersonating anyone" },
    });
    // Core refuses the operator, a platform operator, and an absent user with one code.
    for (const userId of [a.opId, "nobody"])
      expect(await json(await a.call(IMPERSONATE, { userId }, a.op))).toEqual({
        status: 403,
        body: { code: "YOU_CANNOT_IMPERSONATE_ADMINS", message: "You cannot impersonate admins" },
      });
    expect((await a.call(IMPERSONATE, {}, a.op)).status).toBe(400);
    for (const [path, body] of [
      [IMPERSONATE, { userId: ann.id }],
      [STOP, undefined],
    ] as const)
      expect(await json(await a.call(path, body))).toMatchObject({
        status: 401,
        body: { code: "UNAUTHORIZED" },
      });

    // A bearer caller gets the token in the session, and no cookie.
    const bearer = (token: string) => `Bearer ${token}`;
    const send = (path: string, auth: string, body?: unknown) =>
      a.auth.handler(
        new Request(`${BASE}/api/auth${path}`, {
          method: "POST",
          headers: {
            origin: BASE,
            authorization: auth,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const start = await send(IMPERSONATE, bearer(a.op.slice(COOKIE_NAME.length + 1)), {
      userId: ann.id,
    });
    const started = await json(start.clone());
    expect(started.status).toBe(200);
    expect(started.body.session).toMatchObject({ userId: ann.id, impersonatedBy: a.opId });
    expect(start.headers.getSetCookie()).toEqual([]);
    // The stop of a bearer caller ends the session. Core holds no actor cookie, so no session comes back.
    const stop = await send(STOP, bearer(started.body.session.token));
    expect(await json(stop)).toEqual({ status: 200, body: { session: null, user: null } });
    expect(
      await (await a.read("/get-session", `${COOKIE_NAME}=${started.body.session.token}`)).json(),
    ).toBeNull();
    expect((await a.audit(ann.id)).map((r) => r.action).sort()).toEqual([
      "impersonation_start",
      "impersonation_stop",
    ]);
  });
});

/** The status, code, and message of the APIError that a server call throws, or null. */
const thrown = async (call: Promise<unknown>) => {
  try {
    await call;
    return null;
  } catch (e) {
    const x = e as { statusCode: number; body: { code: string; message: string } };
    return { status: x.statusCode, code: x.body.code, message: x.body.message };
  }
};

describe("the admin calls of auth.api (ruling 60 m2)", () => {
  it("serves Better Auth's server admin calls with the steps of the paths", async () => {
    const a = await adminApp(memoryDatabase());
    const ann = await a.user("ann@example.com");
    const bob = await a.user("bob@example.com");
    const cy = await a.user("cy@example.com");
    const headers = new Headers({ cookie: a.op });
    const api = a.auth.api;

    const listed = await api.listUsers({
      query: { searchValue: "ann", searchOperator: "starts_with", limit: 10 },
      headers,
    });
    expect(listed.users.map((u) => u.email)).toEqual(["ann@example.com"]);
    expect(listed).toMatchObject({ total: 1, limit: 10, offset: 0 });
    // A server call answers dates, as Better Auth's does.
    expect(listed.users[0]?.createdAt).toBeInstanceOf(Date);
    const got = await api.getUser({ query: { id: ann.id }, headers });
    expect(got).toMatchObject({ id: ann.id, role: "user", twoFactorEnabled: false });

    const banned = await api.banUser({
      body: { userId: ann.id, banReason: "Spam", banExpiresIn: 3600 },
      headers,
    });
    expect(banned.user).toMatchObject({ id: ann.id, banned: true, banReason: "Spam" });
    expect(banned.user.banExpires).toBeInstanceOf(Date);
    const unbanned = await api.unbanUser({ body: { userId: ann.id }, headers });
    expect(unbanned.user).toMatchObject({ banned: false, banExpires: null });
    const granted = await api.setRole({ body: { userId: bob.id, role: "admin" }, headers });
    expect(granted.user).toMatchObject({ id: bob.id, role: "admin" });
    expect(await api.revokeUserSessions({ body: { userId: cy.id }, headers })).toEqual({
      success: true,
    });
    expect(await (await a.read("/get-session", cy.cookie)).json()).toBeNull();

    const start = await api.impersonateUser({ body: { userId: ann.id }, headers });
    expect(start.session).toMatchObject({ userId: ann.id, impersonatedBy: a.opId });
    expect(start.user).toMatchObject({ id: ann.id, role: "user" });
    const opToken = a.op.slice(COOKIE_NAME.length + 1);
    const stop = await api.stopImpersonating({
      headers: new Headers({
        cookie: `${COOKIE_NAME}=${start.session.token}; ${ACTOR}=${opToken}`,
      }),
    });
    expect(stop.session).toMatchObject({ userId: a.opId, token: opToken, impersonatedBy: null });
    expect(stop.user).toMatchObject({ id: a.opId, role: "admin", twoFactorEnabled: true });

    // Core's audit rows name the operator, as through the paths.
    const by = { actorKind: "user", actorId: a.opId };
    expect((await a.audit(ann.id)).filter((r) => r.action === "ban")).toEqual([
      { action: "ban", ...by, reason: "Spam" },
    ]);
  });

  it("passes core's familyEndFailed through the ban answer of the path and of auth.api (ruling 62 m2)", async () => {
    const database = memoryDatabase();
    const a = await adminApp(database);
    const ann = await a.user("ann@example.com");
    const bob = await a.user("bob@example.com");
    const headers = new Headers({ cookie: a.op });
    // The read of endFamilies after the commit is the one read of oauthToken
    // in an act. A storage limit there, such as query 51 on D1 Free, throws.
    const findMany = database.storage.findMany.bind(database.storage);
    let refused = 0;
    database.storage.findMany = ((model, ...rest) => {
      if (model === "oauthToken") {
        refused++;
        throw new Error("Too many API requests by single worker invocation.");
      }
      return findMany(model, ...rest);
    }) as typeof database.storage.findMany;

    const path = await json(await a.call("/admin/ban-user", { userId: ann.id }, a.op));
    expect(path).toMatchObject({
      status: 200,
      body: { user: { id: ann.id, banned: true }, familyEndFailed: true },
    });
    await a.call("/admin/unban-user", { userId: ann.id }, a.op);
    const banned = await a.auth.api.banUser({ body: { userId: ann.id }, headers });
    expect(banned).toMatchObject({ user: { banned: true }, familyEndFailed: true });
    expect(refused).toBe(2);
    // set-role answers through the same step. A grant ends no family, so its
    // answer holds no such key. A user actor revokes no platform operator,
    // so only the retry of a revoke that left sessions ends families here.
    const granted = await a.auth.api.setRole({ body: { userId: bob.id, role: "admin" }, headers });
    expect(Object.keys(granted)).toEqual(["user"]);

    // With the storage well again, the ban answer holds no such key.
    database.storage.findMany = findMany;
    await a.call("/admin/unban-user", { userId: ann.id }, a.op);
    const again = await a.auth.api.banUser({ body: { userId: ann.id }, headers });
    expect(Object.keys(again)).toEqual(["user"]);
  });

  it("throws Better Auth's APIError of each path, and 404 without the plugin", async () => {
    const a = await adminApp(memoryDatabase());
    const ann = await a.user("ann@example.com");
    const headers = new Headers({ cookie: a.op });
    const api = a.auth.api;
    expect(await thrown(api.listUsers({ query: { offset: 10 }, headers }))).toEqual({
      status: 501,
      code: "NOT_SUPPORTED",
      message:
        "core pages by a cursor, not by an offset, and gives no total (spec section 26 item 4)",
    });
    expect(await thrown(api.getUser({ query: { id: "nobody" }, headers }))).toEqual({
      status: 404,
      code: "USER_NOT_FOUND",
      message: "User not found",
    });
    expect(
      await thrown(api.setRole({ body: { userId: ann.id, role: "owner" }, headers })),
    ).toMatchObject({
      status: 501,
      code: "NOT_SUPPORTED",
    });
    expect(await thrown(api.banUser({ body: { userId: a.opId }, headers }))).toEqual({
      status: 409,
      code: "YOU_CANNOT_BAN_YOURSELF",
      message: "You cannot ban yourself",
    });
    expect(
      await thrown(api.unbanUser({ body: { userId: ann.id }, headers: new Headers() })),
    ).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(await thrown(api.stopImpersonating({ headers }))).toEqual({
      status: 400,
      code: "BAD_REQUEST",
      message: "You are not impersonating anyone",
    });
    // A member with no platform role gets the code of the path.
    const asAnn = new Headers({ cookie: ann.cookie });
    expect(
      await thrown(api.revokeUserSessions({ body: { userId: a.opId }, headers: asAnn })),
    ).toMatchObject({ status: 403, code: "YOU_ARE_NOT_ALLOWED_TO_REVOKE_USERS_SESSIONS" });
    expect(await a.audit(ann.id)).toEqual([]);

    const off = betterAuth(options(null, { authtempo: { passwordHash: fast } }));
    expect(await thrown(off.api.listUsers({ headers }))).toMatchObject({ status: 404 });
    expect(await thrown(off.api.stopImpersonating({ headers }))).toMatchObject({ status: 404 });
  });
});

describe("the admin calls of the client (ruling 60 m1)", () => {
  it("sends Better Auth's authClient.admin calls to the admin paths, with dates", async () => {
    const a = await adminApp(memoryDatabase());
    const ann = await a.user("ann@example.com");
    const bob = await a.user("bob@example.com");
    const cy = await a.user("cy@example.com");
    const seen: string[] = [];
    const client = (cookie: string) =>
      createAuthClient({
        baseURL: `${BASE}/api/auth`,
        plugins: [adminClient()],
        fetchOptions: {
          headers: { cookie },
          customFetchImpl: async (input, init) => {
            const req = new Request(input, init);
            const url = new URL(req.url);
            seen.push(`${req.method} ${url.pathname}${url.search}`);
            return a.auth.handler(req);
          },
        },
      });
    const admin = client(a.op).admin;
    const listed = await admin.listUsers({
      query: { searchValue: "ann", searchOperator: "starts_with", limit: 10 },
    });
    expect(listed.error).toBeNull();
    expect(listed.data?.users.map((u) => u.email)).toEqual(["ann@example.com"]);
    expect(listed.data?.users[0]?.createdAt).toBeInstanceOf(Date);
    expect(seen).toEqual([
      "GET /api/auth/admin/list-users?searchValue=ann&searchOperator=starts_with&limit=10",
    ]);
    expect((await admin.getUser({ query: { id: ann.id } })).data).toMatchObject({
      id: ann.id,
      role: "user",
    });
    const banned = await admin.banUser({ userId: ann.id, banReason: "Spam", banExpiresIn: 3600 });
    expect(banned.data?.user).toMatchObject({ banned: true, banReason: "Spam" });
    expect(banned.data?.user.banExpires).toBeInstanceOf(Date);
    expect((await admin.unbanUser({ userId: ann.id })).data?.user.banned).toBe(false);
    expect((await admin.setRole({ userId: bob.id, role: "admin" })).data?.user.role).toBe("admin");
    expect(await admin.revokeUserSessions({ userId: cy.id })).toEqual({
      data: { success: true },
      error: null,
    });
    const start = await admin.impersonateUser({ userId: ann.id });
    expect(start.data?.session).toMatchObject({ userId: ann.id, impersonatedBy: a.opId });
    expect(start.data?.session.expiresAt).toBeInstanceOf(Date);
    const opToken = a.op.slice(COOKIE_NAME.length + 1);
    const stop = await client(
      `${COOKIE_NAME}=${start.data?.session.token}; ${ACTOR}=${opToken}`,
    ).admin.stopImpersonating();
    expect(stop.data?.session).toMatchObject({ userId: a.opId, impersonatedBy: null });
    // A refusal answers Better Auth's error, with the code of the path.
    const missing = await admin.getUser({ query: { id: "nobody" } });
    expect({
      data: missing.data,
      code: missing.error?.code,
      status: missing.error?.status,
    }).toEqual({ data: null, code: "USER_NOT_FOUND", status: 404 });
    // A user with no platform role (ann's sessions ended at the ban).
    const dee = await a.user("dee@example.com");
    const asDee = await client(dee.cookie).admin.listUsers();
    expect(asDee.error).toMatchObject({ code: "YOU_ARE_NOT_ALLOWED_TO_LIST_USERS", status: 403 });
  });

  it("answers NOT_SUPPORTED with the handler's line for each call that core does not serve", async () => {
    const on = betterAuth(options());
    const seen: string[] = [];
    const admin = createAuthClient({
      baseURL: `${BASE}/api/auth`,
      plugins: [adminClient()],
      fetchOptions: {
        customFetchImpl: async (input, init) => {
          seen.push(new Request(input, init).url);
          return on.handler(new Request(input, init));
        },
      },
    }).admin;
    expect(Object.keys(admin).sort()).toEqual([
      "banUser",
      "checkRolePermission",
      "createUser",
      "getUser",
      "hasPermission",
      "impersonateUser",
      "listUserSessions",
      "listUsers",
      "removeUser",
      "revokeUserSession",
      "revokeUserSessions",
      "setRole",
      "setUserPassword",
      "stopImpersonating",
      "unbanUser",
      "updateUser",
    ]);
    const unmapped = {
      "/admin/create-user": admin.createUser,
      "/admin/update-user": admin.updateUser,
      "/admin/list-user-sessions": admin.listUserSessions,
      "/admin/revoke-user-session": admin.revokeUserSession,
      "/admin/remove-user": admin.removeUser,
      "/admin/set-user-password": admin.setUserPassword,
      "/admin/has-permission": admin.hasPermission,
    };
    for (const [path, call] of Object.entries(unmapped)) {
      const r = await call({ userId: "u1" });
      // The same line as the handler's answer to the path.
      const res = await on.handler(post(path, { userId: "u1" }));
      const { message } = (await res.json()) as { message: string };
      expect({ path, data: r.data, code: r.error?.code, status: r.error?.status }).toEqual({
        path,
        data: null,
        code: "NOT_SUPPORTED",
        status: 501,
      });
      expect({ path, message: r.error?.message }).toEqual({ path, message });
      expect(message).toMatch(/\(spec section 26 items? [\d and]+\)$/);
    }
    expect(seen).toEqual([]);
    expect(() => admin.checkRolePermission({ role: "admin", permissions: {} })).toThrow(
      /spec section 26 items 2 and 15/,
    );
  });
});
