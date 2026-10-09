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
} from "../src/engine/organizations.js";
import { makeAuth } from "./helpers.js";

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

  it("the platform role is valid in the platform organization only", async () => {
    const auth = makeAuth({
      organizations: {
        platformRole: "operator",
        platformOrganization: "platform-co",
        ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
      },
    });
    const root = await auth.seedUser("root@example.com");
    const platform = await createOrganization(auth.config, {
      user: root,
      slug: "platform-co",
      name: "Platform",
    });
    const other = await createOrganization(auth.config, {
      user: root,
      slug: "other",
      name: "Other",
    });
    const op = await auth.seedUser("op@example.com");
    if (!platform.ok || !other.ok) throw new Error("setup");
    // The creator is owner (4), so granting operator (5) is above their rank: forbidden_rank. Raise root first through storage, as an app's seed would.
    await auth.storage.update(
      "member",
      [
        { field: "userId", op: "eq", value: root.id },
        { field: "organizationId", op: "eq", value: platform.value.organization.id },
      ],
      { role: "owner,operator" },
    );
    expect(
      (
        await addMember(auth.config, {
          user: root,
          organizationId: platform.value.organization.id,
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
});
