import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { betterAuthPasswordHash } from "../src/hash.js";
import { admin, organization } from "../src/plugins.js";
import {
  ADMIN_NOT_SUPPORTED,
  banBodyOf,
  listUsersTarget,
  setRoleChange,
} from "../src/server/admin.js";
import { betterAuth } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
import { mapOptions } from "../src/server/map-options.js";
import type { AdminOptions, BetterAuthOptions, CompatDatabase } from "../src/types.js";

// Plan 12f Task 13: Better Auth's admin plugin on core's operator tools
// (spec section 26 item 14, ruling 39). This file holds the options, the
// refusals, and the mapping logic. The calls that reach core's operator
// routes land with those routes (Tasks 10 and 11).

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
