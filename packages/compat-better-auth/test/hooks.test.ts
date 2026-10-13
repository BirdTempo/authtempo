import {
  createMemoryAdapter,
  createMemoryLimiter,
  type StorageAdapter,
  systemClock,
  type UserRow,
} from "@tempo-auth/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthClient, organizationClient } from "../src/client/index.js";
import { APIError } from "../src/errors.js";
import { organization } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
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
    kind: "tempo-auth-compat-database",
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
        "tempo-auth compat: organizationHooks.beforeCreateOrganization returned data that changes id; a core hook cannot change a row, so the write stops",
      ],
      ["tempo-auth: before hook failed", "organization.beforeCreate", "Error"],
    ]);
    const same = instance({
      beforeCreateOrganization: async ({ organization: o }) => ({ data: { ...o } }),
    });
    const grace = await seed(same.storage, "grace@example.com");
    expect(
      (await same.api.createOrganization({ user: grace, slug: "acme", name: "Acme" })).ok,
    ).toBe(true);
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
      "plugins[organization].organizationHooks.beforeSomething: tempo-auth has no such option",
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
