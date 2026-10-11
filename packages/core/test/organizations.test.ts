import { describe, expect, it } from "vitest";
import {
  addMember,
  createOrganization,
  deleteOrganization,
  listMembers,
  listOrganizations,
  removeMember,
  updateMemberRole,
  updateOrganization,
  validOrganizationName,
} from "../src/engine/organizations.js";
import { createSession } from "../src/engine/sessions.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { makeAuth, platformAuth, seedPlatform } from "./helpers.js";

function orgAuth() {
  return makeAuth({ organizations: {} });
}

async function owned(
  auth: ReturnType<typeof makeAuth>,
  email = "owner@example.com",
  slug = "acme",
) {
  const user = await auth.seedUser(email);
  const r = await createOrganization(auth.config, { user, slug, name: "Acme" });
  if (!r.ok) throw new Error(r.code);
  return { user, org: r.value.organization };
}

describe("createOrganization", () => {
  it("creates the organization with the caller as owner, normalizes the slug, and lists it", async () => {
    const auth = orgAuth();
    const user = await auth.seedUser("ada@example.com");
    const r = await createOrganization(auth.config, {
      user,
      slug: "Acme-Co",
      name: "Acme",
      metadata: { plan: "free" },
    });
    expect(r.ok && r.value.organization.slug).toBe("acme-co");
    expect(r.ok && r.value.member.role).toBe("owner");
    const list = await listOrganizations(auth.config, { user });
    expect(list.ok && list.value).toEqual([
      { organization: r.ok ? r.value.organization : null, role: "owner" },
    ]);
  });

  it("refuses a reserved slug after normalization, a bad slug, a taken slug, and an unverified caller (Review Focus 4)", async () => {
    const auth = orgAuth();
    const user = await auth.seedUser("ada@example.com");
    expect(
      await createOrganization(auth.config, { user, slug: "ＡＤＭＩＮ", name: "x" }),
    ).toMatchObject({ ok: false, code: "slug_reserved" });
    expect(
      await createOrganization(auth.config, { user, slug: "My Org", name: "x" }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
    expect((await createOrganization(auth.config, { user, slug: "acme", name: "x" })).ok).toBe(
      true,
    );
    expect(await createOrganization(auth.config, { user, slug: "ACME", name: "y" })).toMatchObject({
      ok: false,
      code: "slug_taken",
    });
    expect(await auth.storage.findMany("organization", [])).toHaveLength(1);
    const unverified = await auth.storage.create("user", {
      ...(await auth.seedUser("new@example.com")),
      id: "u-unv",
      email: "unv@example.com",
      emailVerified: false,
    });
    expect(
      await createOrganization(auth.config, { user: unverified, slug: "other", name: "x" }),
    ).toMatchObject({ ok: false, code: "email_unverified" });
  });

  it("answers not_found when organizations are off", async () => {
    const auth = makeAuth();
    const user = await auth.seedUser("ada@example.com");
    expect(await createOrganization(auth.config, { user, slug: "acme", name: "x" })).toMatchObject({
      ok: false,
      code: "not_found",
      status: 404,
    });
  });
});

describe("updateOrganization and deleteOrganization", () => {
  it("refuses a name with a control character on create and on update (Review M-2)", async () => {
    const auth = orgAuth();
    const { user: owner, org } = await owned(auth);
    const controls = [
      ...Array.from({ length: 0x20 }, (_, c) => String.fromCharCode(c)),
      String.fromCharCode(0x7f),
    ];
    expect(controls).toHaveLength(33);
    for (const name of ["Acme\nBcc: x@example.com", ...controls.map((c) => `Acme${c}x`)]) {
      expect(
        await createOrganization(auth.config, { user: owner, slug: "other", name }),
      ).toMatchObject({ ok: false, code: "invalid_body" });
      expect(
        await updateOrganization(auth.config, { user: owner, organizationId: org.id, name }),
      ).toMatchObject({ ok: false, code: "invalid_body" });
    }
    expect(
      (
        await updateOrganization(auth.config, {
          user: owner,
          organizationId: org.id,
          name: "Acme Ünïcode",
        })
      ).ok,
    ).toBe(true);
  });

  it("admin updates name and metadata; only owner changes the slug; viewer gets forbidden_rank", async () => {
    const auth = orgAuth();
    const { user: owner, org } = await owned(auth);
    const admin = await auth.seedUser("admin@example.com");
    const viewer = await auth.seedUser("viewer@example.com");
    expect(
      (
        await addMember(auth.config, {
          user: owner,
          organizationId: org.id,
          userId: admin.id,
          role: "admin",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await addMember(auth.config, {
          user: owner,
          organizationId: org.id,
          userId: viewer.id,
          role: "viewer",
        })
      ).ok,
    ).toBe(true);
    const r = await updateOrganization(auth.config, {
      user: admin,
      organizationId: org.id,
      name: "Acme Inc",
      metadata: { tier: 2 },
    });
    expect(r.ok && r.value.name).toBe("Acme Inc");
    expect(
      await updateOrganization(auth.config, {
        user: admin,
        organizationId: org.id,
        slug: "acme-inc",
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(
      (
        await updateOrganization(auth.config, {
          user: owner,
          organizationId: org.id,
          slug: "acme-inc",
        })
      ).ok,
    ).toBe(true);
    expect(
      await updateOrganization(auth.config, { user: owner, organizationId: org.id, slug: "www" }),
    ).toMatchObject({ ok: false, code: "slug_reserved" });
    expect(
      await updateOrganization(auth.config, { user: viewer, organizationId: org.id, name: "x" }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    const stranger = await auth.seedUser("s@example.com");
    expect(
      await updateOrganization(auth.config, { user: stranger, organizationId: org.id, name: "x" }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(
      await updateOrganization(auth.config, { user: owner, organizationId: "nope", name: "x" }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("owner deletes the organization with its members; admin cannot", async () => {
    const auth = orgAuth();
    const { user: owner, org } = await owned(auth);
    const admin = await auth.seedUser("admin@example.com");
    await addMember(auth.config, {
      user: owner,
      organizationId: org.id,
      userId: admin.id,
      role: "admin",
    });
    expect(
      await deleteOrganization(auth.config, { user: admin, organizationId: org.id }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(await deleteOrganization(auth.config, { user: owner, organizationId: org.id })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await auth.storage.findMany("organization", [])).toEqual([]);
    expect(await auth.storage.findMany("member", [])).toEqual([]);
    expect(await listOrganizations(auth.config, { user: owner })).toEqual({ ok: true, value: [] });
  });
});

describe("members", () => {
  it("lists members with email and name sorted by email then id, for any member", async () => {
    const auth = orgAuth();
    const { user: owner, org } = await owned(auth, "z@example.com");
    const a = await auth.seedUser("a@example.com");
    await addMember(auth.config, {
      user: owner,
      organizationId: org.id,
      userId: a.id,
      role: "viewer",
    });
    const list = await listMembers(auth.config, { user: a, organizationId: org.id });
    expect(list.ok && list.value.map((m) => [m.email, m.role])).toEqual([
      ["a@example.com", "viewer"],
      ["z@example.com", "owner"],
    ]);
    const stranger = await auth.seedUser("s@example.com");
    expect(
      await listMembers(auth.config, { user: stranger, organizationId: org.id }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
  });

  it("never grants a rank above the caller's, refuses an unknown role, a duplicate, and an unverified target (Review Focus 1)", async () => {
    const auth = orgAuth();
    const { user: owner, org } = await owned(auth);
    const admin = await auth.seedUser("admin@example.com");
    const x = await auth.seedUser("x@example.com");
    await addMember(auth.config, {
      user: owner,
      organizationId: org.id,
      userId: admin.id,
      role: "admin",
    });
    expect(
      await addMember(auth.config, {
        user: admin,
        organizationId: org.id,
        userId: x.id,
        role: "owner",
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(
      await addMember(auth.config, {
        user: admin,
        organizationId: org.id,
        userId: x.id,
        role: "admin,owner",
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(
      await addMember(auth.config, {
        user: admin,
        organizationId: org.id,
        userId: x.id,
        role: "bogus",
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(
      await addMember(auth.config, {
        user: admin,
        organizationId: org.id,
        userId: x.id,
        role: "Bad Role",
      }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
    expect(
      await addMember(auth.config, {
        user: admin,
        organizationId: org.id,
        userId: "nope",
        role: "member",
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(
      (
        await addMember(auth.config, {
          user: admin,
          organizationId: org.id,
          userId: x.id,
          role: "member,admin",
        })
      ).ok,
    ).toBe(true);
    expect(
      await addMember(auth.config, {
        user: admin,
        organizationId: org.id,
        userId: x.id,
        role: "member",
      }),
    ).toMatchObject({ ok: false, code: "already_member" });
    const unv = await auth.storage.create("user", {
      id: "u-unv",
      email: "unv@example.com",
      emailVerified: false,
      name: null,
      image: null,
      createdAt: auth.clock.now(),
      updatedAt: auth.clock.now(),
    });
    expect(
      await addMember(auth.config, {
        user: owner,
        organizationId: org.id,
        userId: unv.id,
        role: "member",
      }),
    ).toMatchObject({ ok: false, code: "email_unverified" });
    expect(
      await auth.storage.findMany("member", [{ field: "userId", op: "eq", value: x.id }]),
    ).toHaveLength(1);
  });

  it("updateRole: an admin cannot touch an owner, raise anyone above admin, or demote the last owner (Review Focus 2)", async () => {
    const auth = orgAuth();
    const { user: owner, org } = await owned(auth);
    const admin = await auth.seedUser("admin@example.com");
    const m = await auth.seedUser("m@example.com");
    await addMember(auth.config, {
      user: owner,
      organizationId: org.id,
      userId: admin.id,
      role: "admin",
    });
    await addMember(auth.config, {
      user: owner,
      organizationId: org.id,
      userId: m.id,
      role: "member",
    });
    expect(
      await updateMemberRole(auth.config, {
        user: admin,
        organizationId: org.id,
        userId: owner.id,
        role: "member",
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(
      await updateMemberRole(auth.config, {
        user: admin,
        organizationId: org.id,
        userId: m.id,
        role: "owner",
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(
      (
        await updateMemberRole(auth.config, {
          user: admin,
          organizationId: org.id,
          userId: m.id,
          role: "admin",
        })
      ).ok,
    ).toBe(true);
    expect(
      await updateMemberRole(auth.config, {
        user: owner,
        organizationId: org.id,
        userId: owner.id,
        role: "admin",
      }),
    ).toMatchObject({ ok: false, code: "last_owner" });
    expect(
      (
        await updateMemberRole(auth.config, {
          user: owner,
          organizationId: org.id,
          userId: m.id,
          role: "owner",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await updateMemberRole(auth.config, {
          user: owner,
          organizationId: org.id,
          userId: owner.id,
          role: "admin",
        })
      ).ok,
    ).toBe(true);
    expect(
      await updateMemberRole(auth.config, {
        user: owner,
        organizationId: org.id,
        userId: m.id,
        role: "nope-user",
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
  });

  it("removeMember: a member leaves at any rank, an admin removes lower ranks, the last owner stays (Review Focus 2)", async () => {
    const auth = orgAuth();
    const { user: owner, org } = await owned(auth);
    const admin = await auth.seedUser("admin@example.com");
    const v = await auth.seedUser("v@example.com");
    await addMember(auth.config, {
      user: owner,
      organizationId: org.id,
      userId: admin.id,
      role: "admin",
    });
    await addMember(auth.config, {
      user: owner,
      organizationId: org.id,
      userId: v.id,
      role: "viewer",
    });
    expect(
      await removeMember(auth.config, { user: v, organizationId: org.id, userId: admin.id }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(
      await removeMember(auth.config, { user: admin, organizationId: org.id, userId: owner.id }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(
      await removeMember(auth.config, { user: owner, organizationId: org.id, userId: owner.id }),
    ).toMatchObject({ ok: false, code: "last_owner" });
    expect(
      (await removeMember(auth.config, { user: v, organizationId: org.id, userId: v.id })).ok,
    ).toBe(true);
    expect(
      (await removeMember(auth.config, { user: admin, organizationId: org.id, userId: admin.id }))
        .ok,
    ).toBe(true);
    const second = await auth.seedUser("o2@example.com");
    await addMember(auth.config, {
      user: owner,
      organizationId: org.id,
      userId: second.id,
      role: "owner",
    });
    expect(
      (await removeMember(auth.config, { user: owner, organizationId: org.id, userId: owner.id }))
        .ok,
    ).toBe(true);
    expect(
      await removeMember(auth.config, { user: second, organizationId: org.id, userId: "nope" }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(await auth.storage.findMany("member", [])).toHaveLength(1);
  });

  it("an owner removal that races a concurrent write answers conflict and changes nothing; a retry succeeds (Review Focus 2)", async () => {
    const auth = orgAuth();
    const { user: owner, org } = await owned(auth);
    const second = await auth.seedUser("o2@example.com");
    expect(
      (
        await addMember(auth.config, {
          user: owner,
          organizationId: org.id,
          userId: second.id,
          role: "owner",
        })
      ).ok,
    ).toBe(true);
    const original = auth.storage.transaction.bind(auth.storage);
    let bumped = false;
    // A concurrent owner write commits after this caller's standing read and before its transaction.
    auth.storage.transaction = async <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> => {
      if (!bumped) {
        bumped = true;
        auth.clock.advance(1000);
        await auth.storage.update("organization", [{ field: "id", op: "eq", value: org.id }], {
          updatedAt: auth.clock.now(),
        });
      }
      return original(fn);
    };
    expect(
      await removeMember(auth.config, { user: owner, organizationId: org.id, userId: owner.id }),
    ).toMatchObject({ ok: false, code: "conflict", status: 409 });
    expect(bumped).toBe(true);
    const inOrg = [{ field: "organizationId" as const, op: "eq" as const, value: org.id }];
    expect(await auth.storage.findMany("member", inOrg)).toHaveLength(2);
    expect(
      (await removeMember(auth.config, { user: owner, organizationId: org.id, userId: owner.id }))
        .ok,
    ).toBe(true);
    expect((await auth.storage.findMany("member", inOrg)).map((m) => m.userId)).toEqual([
      second.id,
    ]);
  });

  it("the platform role is valid in the platform organization only", async () => {
    const auth = makeAuth({
      organizations: {
        platformRole: "operator",
        platformOrganization: "platform-co",
        ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
      },
    });
    const root = await auth.seedUser("root@example.com");
    // The platform slug is reserved, so the app seeds that organization and root's membership through storage, as a migration would.
    const now = auth.clock.now();
    const platformOrg = await auth.storage.create("organization", {
      id: "org-platform",
      slug: "platform-co",
      name: "Platform",
      metadata: null,
      createdAt: now,
      updatedAt: now,
    });
    await auth.storage.create("member", {
      id: "m-root",
      organizationId: platformOrg.id,
      userId: root.id,
      role: "owner,operator",
      createdAt: now,
      updatedAt: now,
    });
    expect(
      await createOrganization(auth.config, { user: root, slug: "platform-co", name: "Squat" }),
    ).toMatchObject({ ok: false, code: "slug_reserved" });
    const other = await createOrganization(auth.config, {
      user: root,
      slug: "other",
      name: "Other",
    });
    const op = await auth.seedUser("op@example.com");
    if (!other.ok) throw new Error("setup");
    expect(
      (
        await addMember(auth.config, {
          user: root,
          organizationId: platformOrg.id,
          userId: op.id,
          role: "operator",
        })
      ).ok,
    ).toBe(true);
    expect(
      await addMember(auth.config, {
        user: root,
        organizationId: other.value.organization.id,
        userId: op.id,
        role: "operator",
      }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
  });

  it("refuses a rename and a delete of the platform organization (Review I-4)", async () => {
    const auth = platformAuth();
    const { root, platformOrg } = await seedPlatform(auth);
    expect(
      await updateOrganization(auth.config, {
        user: root,
        organizationId: platformOrg.id,
        slug: "staff",
      }),
    ).toMatchObject({ ok: false, code: "slug_reserved" });
    expect(
      await deleteOrganization(auth.config, { user: root, organizationId: platformOrg.id }),
    ).toMatchObject({ ok: false, code: "slug_reserved" });
    const row = await auth.storage.findOne("organization", [
      { field: "id", op: "eq", value: platformOrg.id },
    ]);
    expect(row?.slug).toBe("platform-co");
    // A rename of the name alone keeps the slug, so it stays open.
    expect(
      (
        await updateOrganization(auth.config, {
          user: root,
          organizationId: platformOrg.id,
          name: "Platform 2",
        })
      ).ok,
    ).toBe(true);
  });
});

describe("stale reads and removal (Review I-2, I-3, M-1)", () => {
  async function team() {
    const auth = orgAuth();
    const { user: owner, org } = await owned(auth);
    const admin = await auth.seedUser("admin@example.com");
    const b = await auth.seedUser("b@example.com");
    for (const [u, role] of [
      [admin, "admin"],
      [b, "member"],
    ] as const) {
      const r = await addMember(auth.config, {
        user: owner,
        organizationId: org.id,
        userId: u.id,
        role,
      });
      if (!r.ok) throw new Error(r.code);
    }
    return { auth, owner, admin, b, org };
  }

  async function roleOf(auth: ReturnType<typeof makeAuth>, orgId: string, userId: string) {
    const m = await auth.storage.findOne("member", [
      { field: "organizationId", op: "eq", value: orgId },
      { field: "userId", op: "eq", value: userId },
    ]);
    return m?.role ?? null;
  }

  it("a role change answers conflict when the target was promoted to owner after the read", async () => {
    const { auth, owner, admin, b, org } = await team();
    const original = auth.storage.update.bind(auth.storage);
    let promoted = false;
    // The owner promotes B after the admin's standing read and before the admin's write.
    auth.storage.update = (async (model, where, data) => {
      if (model === "member" && !promoted) {
        promoted = true;
        const r = await updateMemberRole(auth.config, {
          user: owner,
          organizationId: org.id,
          userId: b.id,
          role: "owner",
        });
        if (!r.ok) throw new Error(r.code);
      }
      return original(model, where, data);
    }) as StorageAdapter["update"];
    expect(
      await updateMemberRole(auth.config, {
        user: admin,
        organizationId: org.id,
        userId: b.id,
        role: "viewer",
      }),
    ).toMatchObject({ ok: false, code: "conflict", status: 409 });
    expect(promoted).toBe(true);
    expect(await roleOf(auth, org.id, b.id)).toBe("owner");
  });

  it("a removal answers conflict when the target was promoted to owner after the read", async () => {
    const { auth, owner, admin, b, org } = await team();
    const original = auth.storage.transaction.bind(auth.storage);
    let promoted = false;
    auth.storage.transaction = async <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> => {
      if (!promoted) {
        promoted = true;
        const r = await updateMemberRole(auth.config, {
          user: owner,
          organizationId: org.id,
          userId: b.id,
          role: "owner",
        });
        if (!r.ok) throw new Error(r.code);
      }
      return original(fn);
    };
    expect(
      await removeMember(auth.config, { user: admin, organizationId: org.id, userId: b.id }),
    ).toMatchObject({ ok: false, code: "conflict", status: 409 });
    expect(promoted).toBe(true);
    expect(await roleOf(auth, org.id, b.id)).toBe("owner");
  });

  it("a removal or a leave clears the member's active organization and no other session's", async () => {
    const { auth, owner, b, org } = await team();
    const second = await auth.seedUser("o2@example.com");
    await addMember(auth.config, {
      user: owner,
      organizationId: org.id,
      userId: second.id,
      role: "owner",
    });
    const sessions = new Map<string, string>();
    for (const u of [owner, b, second]) {
      const { session } = await createSession(auth.config, {
        userId: u.id,
        ip: null,
        userAgent: null,
      });
      await auth.storage.update("session", [{ field: "id", op: "eq", value: session.id }], {
        activeOrganizationId: org.id,
      });
      sessions.set(u.id, session.id);
    }
    const active = async (userId: string) =>
      (
        await auth.storage.findOne("session", [
          { field: "id", op: "eq", value: sessions.get(userId) ?? "" },
        ])
      )?.activeOrganizationId;
    expect(
      (await removeMember(auth.config, { user: owner, organizationId: org.id, userId: b.id })).ok,
    ).toBe(true);
    expect(await active(b.id)).toBeNull();
    expect(await active(owner.id)).toBe(org.id);
    // An owner leaves through the owner path.
    expect(
      (await removeMember(auth.config, { user: second, organizationId: org.id, userId: second.id }))
        .ok,
    ).toBe(true);
    expect(await active(second.id)).toBeNull();
    expect(await active(owner.id)).toBe(org.id);
  });

  it("a member whose role ranks 0 can leave (Review M-1)", async () => {
    const before = makeAuth({
      organizations: { ranks: { guest: 1, viewer: 2, member: 3, admin: 4, owner: 5 } },
    });
    const { user: owner, org } = await owned(before);
    const ghost = await before.seedUser("ghost@example.com");
    const added = await addMember(before.config, {
      user: owner,
      organizationId: org.id,
      userId: ghost.id,
      role: "guest",
    });
    expect(added.ok).toBe(true);
    // The app then drops guest from the rank table: the member's role now ranks 0.
    const after = makeAuth({ organizations: {}, storage: before.storage });
    expect(
      await removeMember(after.config, { user: ghost, organizationId: org.id, userId: ghost.id }),
    ).toEqual({ ok: true, value: { ok: true } });
    expect(await roleOf(after, org.id, ghost.id)).toBeNull();
  });
});

describe("validOrganizationName (exported for the importer, plan 9b)", () => {
  it("holds 1 to 120 characters with no control character", () => {
    const controls = [
      ...Array.from({ length: 0x20 }, (_, c) => String.fromCharCode(c)),
      String.fromCharCode(0x7f),
    ];
    expect(validOrganizationName("a")).toBe(true);
    expect(validOrganizationName("a".repeat(120))).toBe(true);
    expect(validOrganizationName("Acme Ünïcode")).toBe(true);
    expect(validOrganizationName("")).toBe(false);
    expect(validOrganizationName("a".repeat(121))).toBe(false);
    for (const c of controls) expect(validOrganizationName(`Acme${c}x`)).toBe(false);
  });
});
