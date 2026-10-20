import {
  createMemoryAdapter,
  createMemoryLimiter,
  HOOK_REFUSED_TEXT,
  type OrganizationsConfig,
  type StorageAdapter,
  systemClock,
  type UserRow,
} from "@authtempo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthClient, organizationClient } from "../src/client/index.js";
import { APIError } from "../src/errors.js";
import { magicLink, organization } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
import { mapOptions } from "../src/server/map-options.js";
import type {
  BetterAuthOptions,
  CompatDatabase,
  InvitationEmailData,
  OrganizationHookOptions,
} from "../src/types.js";

const BASE = "https://api.example.com";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The argument keys of each mapped hook in Better Auth 1.7.2's typings (types.d.mts:296-690, read 2026-10-13). */
const SHAPES: Record<keyof OrganizationHookOptions, string[]> = {
  beforeCreateOrganization: ["organization", "user"],
  afterCreateOrganization: ["member", "organization", "user"],
  beforeUpdateOrganization: ["member", "organization", "user"],
  afterUpdateOrganization: ["member", "organization", "user"],
  beforeDeleteOrganization: ["organization", "user"],
  afterDeleteOrganization: ["organization", "user"],
  beforeAddMember: ["member", "organization", "user"],
  afterAddMember: ["member", "organization", "user"],
  beforeRemoveMember: ["member", "organization", "user"],
  afterRemoveMember: ["member", "organization", "user"],
  beforeUpdateMemberRole: ["member", "newRole", "organization", "user"],
  afterUpdateMemberRole: ["member", "organization", "previousRole", "user"],
  beforeCreateInvitation: ["invitation", "inviter", "organization"],
  afterCreateInvitation: ["invitation", "inviter", "organization"],
  beforeAcceptInvitation: ["invitation", "organization", "user"],
  afterAcceptInvitation: ["invitation", "member", "organization", "user"],
  afterRejectInvitation: ["invitation", "organization", "user"],
  afterCancelInvitation: ["cancelledBy", "invitation", "organization"],
};

function instance(
  organizationHooks: OrganizationHookOptions,
  extra: Partial<BetterAuthOptions> = {},
) {
  const invitations: InvitationEmailData[] = [];
  const database: CompatDatabase = {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    storage: createMemoryAdapter(),
    limiter: createMemoryLimiter(systemClock),
  };
  const auth = betterAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    database,
    plugins: [
      organization({
        sendInvitationEmail: async (d) => void invitations.push(d),
        organizationHooks,
      }),
    ],
    ...extra,
  });
  /** The token of the newest invitation: the mail callback's `data.id`. */
  const lastToken = () => invitations.at(-1)?.id ?? "";
  return { auth, api: auth.tempo.api, storage: database.storage, lastToken };
}

async function seed(storage: StorageAdapter, email: string, name: string | null = null) {
  const now = new Date("2026-10-13T00:00:00.000Z");
  return storage.create("user", {
    id: `u-${email}`,
    email,
    emailVerified: true,
    name,
    image: null,
    bannedAt: null,
    banReason: null,
    banUntil: null,
    createdAt: now,
    updatedAt: now,
  }) as Promise<UserRow>;
}

describe("organizationHooks (plan 9d)", () => {
  it("calls each of the 18 mapped hooks with Better Auth 1.7.2's argument keys and names", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const hooks = Object.fromEntries(
      Object.keys(SHAPES).map((name) => [
        name,
        async (data: Record<string, unknown>) => {
          calls.push([name, data]);
        },
      ]),
    ) as OrganizationHookOptions;
    const { api, storage, lastToken } = instance(hooks);
    const owner = await seed(storage, "owner@example.com", "Olive");
    const bob = await seed(storage, "bob@example.com");
    const carol = await seed(storage, "carol@example.com");
    const created = await api.createOrganization({ user: owner, slug: "acme", name: "Acme" });
    if (!created.ok) throw new Error(created.code);
    const organizationId = created.value.organization.id;
    expect(
      (await api.updateOrganization({ user: owner, organizationId, name: "Acme Two" })).ok,
    ).toBe(true);
    expect(
      (await api.addMember({ user: owner, organizationId, userId: bob.id, role: "member" })).ok,
    ).toBe(true);
    expect(
      (await api.updateMemberRole({ user: owner, organizationId, userId: bob.id, role: "admin" }))
        .ok,
    ).toBe(true);
    const toCarol = await api.inviteMember({
      user: owner,
      organizationId,
      email: "carol@example.com",
      role: "member",
    });
    if (!toCarol.ok) throw new Error(toCarol.code);
    expect((await api.acceptInvitation({ user: carol, token: lastToken(), ip: null })).ok).toBe(
      true,
    );
    const toDana = await api.inviteMember({
      user: owner,
      organizationId,
      email: "dana@example.com",
      role: "member",
    });
    if (!toDana.ok) throw new Error(toDana.code);
    expect((await api.declineInvitation({ token: lastToken() })).ok).toBe(true);
    const toErin = await api.inviteMember({
      user: owner,
      organizationId,
      email: "erin@example.com",
      role: "member",
    });
    if (!toErin.ok) throw new Error(toErin.code);
    expect(
      (await api.revokeInvitation({ user: owner, organizationId, invitationId: toErin.value.id }))
        .ok,
    ).toBe(true);
    expect((await api.removeMember({ user: owner, organizationId, userId: bob.id })).ok).toBe(true);
    expect((await api.deleteOrganization({ user: owner, organizationId })).ok).toBe(true);

    expect([...new Set(calls.map(([name]) => name))].sort()).toEqual(Object.keys(SHAPES).sort());
    for (const [name, data] of calls)
      expect({ name, keys: Object.keys(data).sort() }).toEqual({
        name,
        keys: SHAPES[name as keyof OrganizationHookOptions],
      });
    // Better Auth fires its member hooks for the creator's row and for an add, not for an accept.
    expect(calls.filter(([name]) => name === "beforeAddMember")).toHaveLength(2);
    expect(calls.filter(([name]) => name === "afterAddMember")).toHaveLength(2);
    const arg = (name: string) => calls.find(([n]) => n === name)?.[1];
    expect(arg("beforeCreateOrganization")).toEqual({
      organization: { id: organizationId, name: "Acme", slug: "acme", logo: null, metadata: null },
      user: {
        id: owner.id,
        name: "Olive",
        email: "owner@example.com",
        emailVerified: true,
        image: null,
        createdAt: owner.createdAt,
        updatedAt: owner.updatedAt,
      },
    });
    expect(arg("beforeAddMember")).toMatchObject({
      member: { userId: owner.id, organizationId, role: "owner" },
    });
    expect(arg("afterCreateOrganization")).toMatchObject({
      organization: { id: organizationId, logo: null },
      member: { organizationId, userId: owner.id, role: "owner" },
    });
    expect(arg("beforeUpdateOrganization")).toMatchObject({
      organization: { name: "Acme Two" },
      member: { userId: owner.id, organizationId },
    });
    expect(arg("beforeUpdateMemberRole")).toMatchObject({
      newRole: "admin",
      member: { userId: bob.id, role: "member" },
      user: { id: bob.id, name: "" },
    });
    expect(arg("afterUpdateMemberRole")).toMatchObject({
      previousRole: "member",
      member: { role: "admin" },
    });
    expect(arg("beforeCreateInvitation")).toMatchObject({
      invitation: {
        email: "carol@example.com",
        role: "member",
        organizationId,
        inviterId: owner.id,
      },
      inviter: { id: owner.id },
    });
    expect(arg("beforeAcceptInvitation")).toMatchObject({
      invitation: { id: toCarol.value.id, status: "pending" },
      user: { id: carol.id },
    });
    expect(arg("afterAcceptInvitation")).toMatchObject({
      invitation: { id: toCarol.value.id, status: "accepted" },
      member: { userId: carol.id, organizationId },
    });
    expect(arg("afterRejectInvitation")).toMatchObject({
      invitation: { id: toDana.value.id, status: "rejected" },
      user: null,
    });
    expect(arg("afterCancelInvitation")).toMatchObject({
      invitation: { id: toErin.value.id, status: "canceled" },
      cancelledBy: { id: owner.id },
    });
    expect(arg("beforeRemoveMember")).toMatchObject({
      member: { userId: bob.id, role: "admin" },
      user: { id: bob.id },
    });
  });

  it("answers hook_refused with the message of a thrown APIError in Better Auth's form, and writes no row", async () => {
    const { api, storage } = instance({
      beforeCreateOrganization: async () => {
        throw new APIError("FORBIDDEN", { message: "Choose another name." });
      },
    });
    const ada = await seed(storage, "ada@example.com");
    expect(await api.createOrganization({ user: ada, slug: "acme", name: "Acme" })).toEqual({
      ok: false,
      code: "hook_refused",
      status: 403,
      message: "Choose another name.",
    });
    expect(await storage.findMany("organization", [])).toEqual([]);
  });

  it("builds APIError in this package's form and in Better Auth's form", () => {
    const own = new APIError(403, "FORBIDDEN", "Own form.");
    const theirs = new APIError("FORBIDDEN", { message: "Better Auth form." });
    const bare = new APIError("BAD_REQUEST");
    expect([own.statusCode, own.status, own.body, own.message]).toEqual([
      403,
      "FORBIDDEN",
      { code: "FORBIDDEN", message: "Own form." },
      "Own form.",
    ]);
    expect([theirs.statusCode, theirs.status, theirs.body, theirs.message]).toEqual([
      403,
      "FORBIDDEN",
      { code: "FORBIDDEN", message: "Better Auth form." },
      "Better Auth form.",
    ]);
    expect([bare.statusCode, bare.body]).toEqual([
      400,
      { code: "BAD_REQUEST", message: "Bad request" },
    ]);
  });

  it("stops the write with hook_failed and one line when a before hook returns data that changes a field, and passes data that changes nothing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const changing = instance({
      // consumerc's form before its cutover: its own id in place of core's.
      beforeCreateOrganization: async ({ organization: o }) => ({ data: { ...o, id: "studio-1" } }),
    });
    const ada = await seed(changing.storage, "ada@example.com");
    expect(
      await changing.api.createOrganization({ user: ada, slug: "acme", name: "Acme" }),
    ).toEqual({ ok: false, code: "hook_failed", status: 500 });
    expect(await changing.storage.findMany("organization", [])).toEqual([]);
    expect(log.mock.calls).toEqual([
      [
        "authtempo compat: organizationHooks.beforeCreateOrganization returned data that changes id; a core hook cannot change a row, so the write stops",
      ],
      ["authtempo: before hook failed", "organization.beforeCreate", "Error"],
    ]);
    const same = instance({
      beforeCreateOrganization: async ({ organization: o }) => ({ data: { ...o } }),
    });
    const grace = await seed(same.storage, "grace@example.com");
    expect(
      (await same.api.createOrganization({ user: grace, slug: "acme", name: "Acme" })).ok,
    ).toBe(true);
  });

  it("stops beforeAddMember and beforeCreateInvitation on data that changes a field, and passes data that changes nothing (parked Minor 17)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let change = true;
    const { api, storage, lastToken } = instance({
      beforeAddMember: async ({ member }) =>
        change ? { data: { ...member, role: "admin" } } : { data: { ...member } },
      beforeCreateInvitation: async ({ invitation }) =>
        change ? { data: { ...invitation, role: "admin" } } : { data: { ...invitation } },
    });
    const owner = await seed(storage, "owner@example.com");
    const bob = await seed(storage, "bob@example.com");
    change = false;
    const created = await api.createOrganization({ user: owner, slug: "acme", name: "Acme" });
    if (!created.ok) throw new Error(created.code);
    const organizationId = created.value.organization.id;
    change = true;
    expect(
      await api.addMember({ user: owner, organizationId, userId: bob.id, role: "member" }),
    ).toEqual({ ok: false, code: "hook_failed", status: 500 });
    expect(
      await api.inviteMember({
        user: owner,
        organizationId,
        email: "carol@example.com",
        role: "member",
      }),
    ).toEqual({ ok: false, code: "hook_failed", status: 500 });
    expect(await storage.findMany("member", [])).toHaveLength(1);
    expect(await storage.findMany("invitation", [])).toEqual([]);
    expect(lastToken()).toBe("");
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "authtempo compat: organizationHooks.beforeAddMember returned data that changes role; a core hook cannot change a row, so the write stops",
      "authtempo: before hook failed",
      "authtempo compat: organizationHooks.beforeCreateInvitation returned data that changes role; a core hook cannot change a row, so the write stops",
      "authtempo: before hook failed",
    ]);
    change = false;
    expect(
      (await api.addMember({ user: owner, organizationId, userId: bob.id, role: "member" })).ok,
    ).toBe(true);
    expect(
      (
        await api.inviteMember({
          user: owner,
          organizationId,
          email: "carol@example.com",
          role: "member",
        })
      ).ok,
    ).toBe(true);
  });

  it("calls beforeRemoveMember and afterRemoveMember in Better Auth's shape on a leave (parked Minor 18)", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const record = (name: string) => async (data: Record<string, unknown>) => {
      calls.push([name, data]);
    };
    const { api, storage } = instance({
      beforeRemoveMember: record("beforeRemoveMember"),
      afterRemoveMember: record("afterRemoveMember"),
    });
    const owner = await seed(storage, "owner@example.com");
    const bob = await seed(storage, "bob@example.com");
    const created = await api.createOrganization({ user: owner, slug: "acme", name: "Acme" });
    if (!created.ok) throw new Error(created.code);
    const organizationId = created.value.organization.id;
    expect(
      (await api.addMember({ user: owner, organizationId, userId: bob.id, role: "member" })).ok,
    ).toBe(true);
    expect((await api.removeMember({ user: bob, organizationId, userId: bob.id })).ok).toBe(true);
    expect(calls.map(([name]) => name)).toEqual(["beforeRemoveMember", "afterRemoveMember"]);
    for (const [name, data] of calls) {
      expect(Object.keys(data).sort()).toEqual(SHAPES[name as keyof OrganizationHookOptions]);
      expect(data).toMatchObject({
        member: { userId: bob.id, organizationId, role: "member" },
        user: { id: bob.id },
        organization: { id: organizationId },
      });
    }
  });

  it("calls the role hooks when an accept raises an existing member's role, and a refusal keeps the invitation (final fix wave I-1)", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    let refuse = true;
    const { api, storage, lastToken } = instance({
      beforeUpdateMemberRole: async (data) => {
        calls.push(["beforeUpdateMemberRole", data]);
        if (refuse) throw new APIError("FORBIDDEN", { message: "Admins need a paid plan." });
      },
      afterUpdateMemberRole: async (data) => {
        calls.push(["afterUpdateMemberRole", data]);
      },
    });
    const owner = await seed(storage, "owner@example.com");
    const bob = await seed(storage, "bob@example.com");
    const created = await api.createOrganization({ user: owner, slug: "acme", name: "Acme" });
    if (!created.ok) throw new Error(created.code);
    const organizationId = created.value.organization.id;
    expect(
      (await api.addMember({ user: owner, organizationId, userId: bob.id, role: "member" })).ok,
    ).toBe(true);
    expect(
      (
        await api.inviteMember({
          user: owner,
          organizationId,
          email: "bob@example.com",
          role: "admin",
        })
      ).ok,
    ).toBe(true);
    const token = lastToken();
    expect(await api.acceptInvitation({ user: bob, token, ip: null })).toMatchObject({
      ok: false,
      code: "hook_refused",
      message: "Admins need a paid plan.",
    });
    expect(await storage.findMany("invitation", [])).toEqual([
      expect.objectContaining({ acceptedAt: null }),
    ]);
    refuse = false;
    calls.length = 0;
    expect((await api.acceptInvitation({ user: bob, token, ip: null })).ok).toBe(true);
    expect(calls.map(([name]) => name)).toEqual([
      "beforeUpdateMemberRole",
      "afterUpdateMemberRole",
    ]);
    expect(calls[0]?.[1]).toMatchObject({ newRole: "admin", member: { role: "member" } });
    expect(calls[1]?.[1]).toMatchObject({ previousRole: "member", member: { role: "admin" } });
  });

  it("refuses the team hooks, beforeCancelInvitation, beforeRejectInvitation, an unknown name, and a value that is not a function", () => {
    const f = async () => {};
    const c = checkOptions({
      plugins: [
        organization({
          sendInvitationEmail: f,
          organizationHooks: {
            ...Object.fromEntries(Object.keys(SHAPES).map((name) => [name, f])),
            beforeCreateTeam: f,
            afterRemoveTeamMember: f,
            beforeCancelInvitation: f,
            beforeRejectInvitation: f,
            beforeSomething: f,
            afterCreateOrganization: "x",
          } as never,
        }),
      ],
    } as BetterAuthOptions);
    expect(
      c.refusals.filter((r) => r.startsWith("plugins[organization].organizationHooks")),
    ).toEqual([
      "plugins[organization].organizationHooks.afterCreateOrganization: expected a function",
      "plugins[organization].organizationHooks.afterRemoveTeamMember: core has no teams",
      "plugins[organization].organizationHooks.beforeCancelInvitation: core runs no hook before a revoke; use afterCancelInvitation",
      "plugins[organization].organizationHooks.beforeCreateTeam: core has no teams",
      "plugins[organization].organizationHooks.beforeRejectInvitation: core runs no hook before a decline; use afterRejectInvitation",
      "plugins[organization].organizationHooks.beforeSomething: authtempo has no such option",
    ]);
  });

  it("gives the client error the hook's message", async () => {
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      plugins: [organizationClient()],
      fetchOptions: {
        customFetchImpl: async () =>
          Response.json(
            { error: "hook_refused", message: "Choose another name." },
            { status: 403 },
          ),
      },
    });
    expect((await c.organization.create({ name: "Acme", slug: "acme" })).error).toMatchObject({
      code: "HOOK_REFUSED",
      message: "Choose another name.",
      status: 403,
    });
  });
});

const memory = (): CompatDatabase => ({
  kind: "authtempo-compat-database",
  dialect: "postgres",
  storage: createMemoryAdapter(),
  limiter: createMemoryLimiter(systemClock),
});

function sessionInstance(databaseHooks: NonNullable<BetterAuthOptions["databaseHooks"]>) {
  const links: string[] = [];
  const database = memory();
  const auth = betterAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    database,
    databaseHooks,
    plugins: [
      organization({ sendInvitationEmail: async () => {} }),
      magicLink({ sendMagicLink: async (d) => void links.push(d.token) }),
    ],
  });
  const signIn = async (email: string) => {
    const ip = "198.51.100.9";
    const sent = await auth.tempo.api.requestMagicLink({ email, ip });
    if (!sent.ok) throw new Error(sent.code);
    return auth.tempo.api.verifyMagicLink({ token: links.at(-1) ?? "", ip, userAgent: "Agent/2" });
  };
  return { auth, storage: database.storage, signIn };
}

describe("databaseHooks.session.create (plan 9d)", () => {
  it("stores the null userAgent of consumere's hook and keeps the ip", async () => {
    const { storage, signIn } = sessionInstance({
      session: { create: { before: async (s) => ({ data: { ...s, userAgent: null } }) } },
    });
    expect((await signIn("ada@example.com")).ok).toBe(true);
    expect(await storage.findMany("session", [])).toEqual([
      expect.objectContaining({ ip: "198.51.100.9", userAgent: null }),
    ]);
  });

  it("hands the before hook the four draft fields in Better Auth's names", async () => {
    const seen: unknown[] = [];
    const { signIn } = sessionInstance({
      session: {
        create: {
          before: async (s) => {
            seen.push(s);
          },
        },
      },
    });
    const r = await signIn("ada@example.com");
    if (!r.ok) throw new Error(r.code);
    expect(seen).toEqual([
      {
        userId: r.value.user.id,
        ipAddress: "198.51.100.9",
        userAgent: "Agent/2",
        activeOrganizationId: null,
      },
    ]);
  });

  it("drops a change of userId with one log line at the first call, and applies the allowed fields", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { storage, signIn } = sessionInstance({
      session: {
        create: {
          before: async (s) => ({ data: { ...s, userId: "someone-else", ipAddress: null } }),
        },
      },
    });
    const first = await signIn("ada@example.com");
    const second = await signIn("ada@example.com");
    if (!first.ok || !second.ok) throw new Error("sign-in");
    expect((await storage.findMany("session", [])).map((s) => [s.userId, s.ip])).toEqual([
      [first.value.user.id, null],
      [first.value.user.id, null],
    ]);
    expect(log.mock.calls).toEqual([
      [
        "authtempo compat: databaseHooks.session.create.before changed userId; core takes ipAddress, userAgent, and activeOrganizationId only and drops the rest (one line per instance)",
      ],
    ]);
  });

  it("sets an organization the user is a member of, and answers not_found for another", async () => {
    let organizationId = "";
    const { auth, storage, signIn } = sessionInstance({
      session: {
        create: { before: async (s) => ({ data: { ...s, activeOrganizationId: organizationId } }) },
      },
    });
    const ada = await seed(storage, "ada@example.com");
    const created = await auth.tempo.api.createOrganization({ user: ada, slug: "acme", name: "A" });
    if (!created.ok) throw new Error(created.code);
    organizationId = created.value.organization.id;
    expect((await signIn("ada@example.com")).ok).toBe(true);
    expect(await storage.findMany("session", [])).toEqual([
      expect.objectContaining({ activeOrganizationId: organizationId }),
    ]);
    organizationId = "01JNOSUCHORGANIZATION000";
    expect(await signIn("ada@example.com")).toMatchObject({ ok: false, code: "not_found" });
    // The refused patch writes no session: the one row is still the first sign-in's (parked Minor 22).
    expect(await storage.findMany("session", [])).toEqual([
      expect.objectContaining({ activeOrganizationId: created.value.organization.id }),
    ]);
  });

  it("answers hook_refused with the default text when the before hook returns false, and writes no session", async () => {
    const { storage, signIn } = sessionInstance({
      session: { create: { before: async () => false } },
    });
    expect(await signIn("ada@example.com")).toEqual({
      ok: false,
      code: "hook_refused",
      status: 403,
      message: HOOK_REFUSED_TEXT,
    });
    expect(await storage.findMany("session", [])).toEqual([]);
  });

  it("hands create.after the stored session in Better Auth's shape, with the token hash as token", async () => {
    const seen: Record<string, unknown>[] = [];
    const { storage, signIn } = sessionInstance({
      session: {
        create: {
          after: async (s) => {
            seen.push({ ...s });
          },
        },
      },
    });
    expect((await signIn("ada@example.com")).ok).toBe(true);
    const [row] = await storage.findMany("session", []);
    if (!row) throw new Error("no session");
    expect(seen).toEqual([
      {
        id: row.id,
        token: row.tokenHash,
        userId: row.userId,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ipAddress: "198.51.100.9",
        userAgent: "Agent/2",
        activeOrganizationId: null,
      },
    ]);
  });

  it("refuses every other databaseHooks key, a hook that is not a function, and request hooks", () => {
    const f = async () => {};
    const c = checkOptions({
      databaseHooks: {
        // Plan 12a maps user.create, user.update, user.delete, account.create, and account.delete.
        user: { create: { before: f, other: f }, upsert: { before: f } },
        account: { update: { before: f } },
        verification: { create: { before: f } },
        session: { update: { before: f }, create: { before: "x", after: f, other: f } },
      },
      hooks: { before: f },
    } as never);
    expect(
      c.refusals.filter((r) => r.startsWith("databaseHooks") || r.startsWith("hooks")),
    ).toEqual([
      "databaseHooks.account.update: core has no row hook on account.update; see the plan index",
      "databaseHooks.session.create.before: expected a function",
      "databaseHooks.session.create.other: core has no row hook on session.create.other; see the plan index",
      "databaseHooks.session.update: core has no row hook on session.update; see the plan index",
      "databaseHooks.user.create.other: core has no row hook on user.create.other; see the plan index",
      "databaseHooks.user.upsert: core has no row hook on user.upsert; see the plan index",
      "databaseHooks.verification: core has no row hook on verification; see the plan index",
      "hooks: core has no request hooks: wrap auth.handler and read auth.tempo.session(request); see the README recipe",
    ]);
  });
});

describe("organization limits (plan 9d)", () => {
  const options = (o: Parameters<typeof organization>[0]): BetterAuthOptions => ({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    database: memory(),
    plugins: [organization({ sendInvitationEmail: async () => {}, ...o })],
  });

  it("maps the numbers onto core's limits, with Better Auth's defaults of 100", () => {
    const limits = (o: Parameters<typeof organization>[0]) =>
      (mapOptions(options(o)).config.organizations as OrganizationsConfig).limits;
    expect(limits({ organizationLimit: 3, membershipLimit: 50, invitationLimit: 7 })).toEqual({
      perUser: 3,
      membersPerOrganization: 50,
      pendingInvitationsPerOrganization: 7,
    });
    expect(limits({})).toEqual({
      membersPerOrganization: 100,
      pendingInvitationsPerOrganization: 100,
    });
    expect(limits({ organizationLimit: () => false })).toEqual({
      membersPerOrganization: 100,
      pendingInvitationsPerOrganization: 100,
    });
  });

  it("refuses a create with Better Auth's text when the function organizationLimit answers true, and hands it the Better Auth user", async () => {
    const asked: unknown[] = [];
    const { api, storage } = instance(
      {},
      {
        plugins: [
          organization({
            sendInvitationEmail: async () => {},
            organizationLimit: (user) => {
              asked.push(user);
              return user.email === "full@example.com";
            },
          }),
        ],
      },
    );
    const full = await seed(storage, "full@example.com");
    const free = await seed(storage, "free@example.com");
    expect(await api.createOrganization({ user: full, slug: "acme", name: "Acme" })).toEqual({
      ok: false,
      code: "hook_refused",
      status: 403,
      message: "You have reached the maximum number of organizations",
    });
    expect((await api.createOrganization({ user: free, slug: "acme", name: "Acme" })).ok).toBe(
      true,
    );
    expect(asked).toEqual([
      expect.objectContaining({ id: full.id, name: "" }),
      expect.objectContaining({ id: free.id }),
    ]);
  });

  it("answers member_limit at membershipLimit", async () => {
    const { api, storage } = instance(
      {},
      { plugins: [organization({ sendInvitationEmail: async () => {}, membershipLimit: 1 })] },
    );
    const owner = await seed(storage, "owner@example.com");
    const bob = await seed(storage, "bob@example.com");
    const created = await api.createOrganization({ user: owner, slug: "acme", name: "Acme" });
    if (!created.ok) throw new Error(created.code);
    expect(
      await api.addMember({
        user: owner,
        organizationId: created.value.organization.id,
        userId: bob.id,
        role: "member",
      }),
    ).toEqual({ ok: false, code: "member_limit", status: 409 });
  });

  it("refuses a limit that is not a positive integer, and a function membershipLimit or invitationLimit", () => {
    const refusals = checkOptions(
      options({
        organizationLimit: 0,
        membershipLimit: (() => 5) as never,
        invitationLimit: 1.5,
      }),
    ).refusals.filter((r) => r.startsWith("plugins[organization]"));
    expect(refusals).toEqual([
      "plugins[organization].invitationLimit: expected a positive integer",
      "plugins[organization].membershipLimit: a function is refused; pass a positive integer",
      "plugins[organization].organizationLimit: expected a positive integer",
    ]);
  });
});
