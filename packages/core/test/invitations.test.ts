import { describe, expect, it } from "vitest";
import {
  acceptInvitation,
  declineInvitation,
  INVITATION_TOKEN_RE,
  inviteMember,
  listInvitations,
  revokeInvitation,
  setActiveOrganization,
} from "../src/engine/invitations.js";
import {
  addMember,
  createOrganization,
  deleteOrganization,
  removeMember,
  updateMemberRole,
} from "../src/engine/organizations.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { makeAuth, platformAuth, seedPlatform } from "./helpers.js";

function orgAuth() {
  return makeAuth({ organizations: {} });
}

async function owned(auth: ReturnType<typeof makeAuth>) {
  const user = await auth.seedUser("owner@example.com");
  const r = await createOrganization(auth.config, { user, slug: "acme", name: "Acme" });
  if (!r.ok) throw new Error(r.code);
  return { owner: user, org: r.value.organization };
}

function tokenFrom(text: string): string {
  const m = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(text);
  if (!m?.[1]) throw new Error("no token in mail");
  return m[1];
}

describe("inviteMember", () => {
  it("names the organization and the app in the subject", async () => {
    const auth = makeAuth({ organizations: {}, appName: "Acme" });
    const user = await auth.seedUser("owner@example.com");
    const o = await createOrganization(auth.config, { user, slug: "acme-co", name: "Acme Co" });
    if (!o.ok) throw new Error(o.code);
    await inviteMember(auth.config, {
      user,
      organizationId: o.value.organization.id,
      email: "bob@example.com",
      role: "member",
    });
    expect(auth.mail[0]?.subject).toBe("You are invited to Acme Co on Acme");
  });
  it("writes a hashed row, mails the link, lists it, and replaces a pending invitation for the same email", async () => {
    const auth = orgAuth();
    const { owner, org } = await owned(auth);
    const r = await inviteMember(auth.config, {
      user: owner,
      organizationId: org.id,
      email: "Bob@Example.com",
      role: "member",
    });
    expect(r.ok && r.value.email).toBe("bob@example.com");
    expect(auth.mail).toHaveLength(1);
    expect(auth.mail[0]?.to).toBe("bob@example.com");
    const token = tokenFrom(auth.mail[0]?.text ?? "");
    expect(INVITATION_TOKEN_RE.test(token)).toBe(true);
    const rows = await auth.storage.findMany("invitation", []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).not.toContain("inv_");
    expect(rows[0]?.expiresAt.getTime()).toBe(auth.clock.now().getTime() + 7 * 86_400_000);
    const again = await inviteMember(auth.config, {
      user: owner,
      organizationId: org.id,
      email: "bob@example.com",
      role: "admin",
    });
    expect(again.ok).toBe(true);
    expect(await auth.storage.findMany("invitation", [])).toHaveLength(1);
    const list = await listInvitations(auth.config, { user: owner, organizationId: org.id });
    expect(list.ok && list.value.map((i) => [i.email, i.role])).toEqual([
      ["bob@example.com", "admin"],
    ]);
  });

  it("refuses a bad email, a rank above the caller's, a non-admin caller, and an unverified caller", async () => {
    const auth = orgAuth();
    const { owner, org } = await owned(auth);
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
      await inviteMember(auth.config, {
        user: owner,
        organizationId: org.id,
        email: "not an email",
        role: "member",
      }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
    expect(
      await inviteMember(auth.config, {
        user: admin,
        organizationId: org.id,
        email: "x@example.com",
        role: "owner",
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(
      await inviteMember(auth.config, {
        user: v,
        organizationId: org.id,
        email: "x@example.com",
        role: "viewer",
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
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
      await inviteMember(auth.config, {
        user: unv,
        organizationId: org.id,
        email: "x@example.com",
        role: "viewer",
      }),
    ).toMatchObject({ ok: false, code: "email_unverified" });
    expect(auth.mail).toHaveLength(0);
  });
});

describe("acceptInvitation", () => {
  it("needs a verified caller with the invited address, consumes once, creates the member in one transaction (Review Focus 3)", async () => {
    const auth = orgAuth();
    const { owner, org } = await owned(auth);
    await inviteMember(auth.config, {
      user: owner,
      organizationId: org.id,
      email: "bob@example.com",
      role: "member",
    });
    const token = tokenFrom(auth.mail[0]?.text ?? "");
    const other = await auth.seedUser("other@example.com");
    expect(await acceptInvitation(auth.config, { user: other, token, ip: null })).toMatchObject({
      ok: false,
      code: "email_mismatch",
      status: 403,
    });
    const bobUnverified = await auth.storage.create("user", {
      id: "u-bob",
      email: "bob@example.com",
      emailVerified: false,
      name: null,
      image: null,
      createdAt: auth.clock.now(),
      updatedAt: auth.clock.now(),
    });
    expect(
      await acceptInvitation(auth.config, { user: bobUnverified, token, ip: null }),
    ).toMatchObject({ ok: false, code: "email_unverified" });
    expect(await auth.storage.findMany("member", [])).toHaveLength(1);
    await auth.storage.update("user", [{ field: "id", op: "eq", value: "u-bob" }], {
      emailVerified: true,
    });
    const bob = { ...bobUnverified, emailVerified: true };
    const r = await acceptInvitation(auth.config, { user: bob, token, ip: null });
    expect(r.ok && r.value.member.role).toBe("member");
    expect(r.ok && r.value.organization.slug).toBe("acme");
    expect(await acceptInvitation(auth.config, { user: bob, token, ip: null })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    expect(await auth.storage.findMany("member", [])).toHaveLength(2);
    const rows = await auth.storage.findMany("invitation", []);
    expect(rows[0]?.acceptedAt).not.toBeNull();
    expect(await listInvitations(auth.config, { user: owner, organizationId: org.id })).toEqual({
      ok: true,
      value: [],
    });
  });

  it("answers token_expired after the ttl, invalid_token for a bad shape, and rate_limited after 20 per ip", async () => {
    const auth = orgAuth();
    const { owner, org } = await owned(auth);
    await inviteMember(auth.config, {
      user: owner,
      organizationId: org.id,
      email: "bob@example.com",
      role: "member",
    });
    const token = tokenFrom(auth.mail[0]?.text ?? "");
    const bob = await auth.seedUser("bob@example.com");
    expect(
      await acceptInvitation(auth.config, { user: bob, token: "inv_short", ip: "1.1.1.1" }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    auth.clock.advance(7 * 86_400_000 + 1);
    expect(await acceptInvitation(auth.config, { user: bob, token, ip: "1.1.1.1" })).toMatchObject({
      ok: false,
      code: "token_expired",
    });
    // The window allows 20 calls per ip; the 20th still reaches the token check and the 21st is refused.
    let last: Awaited<ReturnType<typeof acceptInvitation>> | null = null;
    for (let i = 0; i < 20; i++)
      last = await acceptInvitation(auth.config, { user: bob, token: "inv_short", ip: "2.2.2.2" });
    expect(last).toMatchObject({ ok: false, code: "invalid_token" });
    expect(
      await acceptInvitation(auth.config, { user: bob, token: "inv_short", ip: "2.2.2.2" }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("raises an existing member's role when the invitation ranks higher, and keeps it otherwise", async () => {
    const auth = orgAuth();
    const { owner, org } = await owned(auth);
    const bob = await auth.seedUser("bob@example.com");
    await addMember(auth.config, {
      user: owner,
      organizationId: org.id,
      userId: bob.id,
      role: "admin",
    });
    await inviteMember(auth.config, {
      user: owner,
      organizationId: org.id,
      email: "bob@example.com",
      role: "viewer",
    });
    const r1 = await acceptInvitation(auth.config, {
      user: bob,
      token: tokenFrom(auth.mail[0]?.text ?? ""),
      ip: null,
    });
    expect(r1.ok && r1.value.member.role).toBe("admin");
    await inviteMember(auth.config, {
      user: owner,
      organizationId: org.id,
      email: "bob@example.com",
      role: "owner",
    });
    const r2 = await acceptInvitation(auth.config, {
      user: bob,
      token: tokenFrom(auth.mail[1]?.text ?? ""),
      ip: null,
    });
    expect(r2.ok && r2.value.member.role).toBe("owner");
    expect(await auth.storage.findMany("member", [])).toHaveLength(2);
  });
});

describe("declineInvitation and revokeInvitation", () => {
  it("decline deletes by token; revoke needs admin of that organization", async () => {
    const auth = orgAuth();
    const { owner, org } = await owned(auth);
    await inviteMember(auth.config, {
      user: owner,
      organizationId: org.id,
      email: "a@example.com",
      role: "member",
    });
    await inviteMember(auth.config, {
      user: owner,
      organizationId: org.id,
      email: "b@example.com",
      role: "member",
    });
    const tokenA = tokenFrom(auth.mail[0]?.text ?? "");
    expect(await declineInvitation(auth.config, { token: tokenA })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await declineInvitation(auth.config, { token: tokenA })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    const list = await listInvitations(auth.config, { user: owner, organizationId: org.id });
    const idB = list.ok ? (list.value[0]?.id ?? "") : "";
    const stranger = await auth.seedUser("s@example.com");
    expect(
      await revokeInvitation(auth.config, {
        user: stranger,
        organizationId: org.id,
        invitationId: idB,
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    const other = await createOrganization(auth.config, {
      user: stranger,
      slug: "other",
      name: "Other",
    });
    if (!other.ok) throw new Error("setup");
    // An admin of another organization cannot revoke through their own organization id.
    expect(
      await revokeInvitation(auth.config, {
        user: stranger,
        organizationId: other.value.organization.id,
        invitationId: idB,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(
      await revokeInvitation(auth.config, {
        user: owner,
        organizationId: org.id,
        invitationId: idB,
      }),
    ).toEqual({ ok: true, value: { ok: true } });
    expect(await auth.storage.findMany("invitation", [])).toEqual([]);
  });
});

describe("setActiveOrganization", () => {
  it("sets a member's organization, refuses a non-member, clears with null, and is cleared by a delete (Review Focus 5)", async () => {
    const auth = orgAuth();
    const { owner, org } = await owned(auth);
    const { token } = await createSession(auth.config, {
      userId: owner.id,
      ip: null,
      userAgent: null,
    });
    const session = await resolveSession(auth.config, token);
    if (!session) throw new Error("no session");
    const r = await setActiveOrganization(auth.config, { session, organizationId: org.id });
    expect(r.ok && r.value.session.activeOrganizationId).toBe(org.id);
    const stranger = await createOrganization(auth.config, {
      user: await auth.seedUser("s@example.com"),
      slug: "other",
      name: "Other",
    });
    if (!stranger.ok) throw new Error("setup");
    expect(
      await setActiveOrganization(auth.config, {
        session,
        organizationId: stranger.value.organization.id,
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect((await resolveSession(auth.config, token))?.session.activeOrganizationId).toBe(org.id);
    await deleteOrganization(auth.config, { user: owner, organizationId: org.id });
    expect((await resolveSession(auth.config, token))?.session.activeOrganizationId).toBeNull();
    const again = await setActiveOrganization(auth.config, {
      session: (await resolveSession(auth.config, token)) ?? session,
      organizationId: null,
    });
    expect(again.ok && again.value.session.activeOrganizationId).toBeNull();
  });
});

describe("acceptInvitation re-checks the inviter (Review I-1)", () => {
  async function invitedByAdmin(auth: ReturnType<typeof makeAuth>) {
    const { owner, org } = await owned(auth);
    const admin = await auth.seedUser("admin@example.com");
    await addMember(auth.config, {
      user: owner,
      organizationId: org.id,
      userId: admin.id,
      role: "admin",
    });
    const inv = await inviteMember(auth.config, {
      user: admin,
      organizationId: org.id,
      email: "x@example.com",
      role: "member",
    });
    if (!inv.ok) throw new Error(inv.code);
    const x = await auth.seedUser("x@example.com");
    return { owner, org, admin, x, token: tokenFrom(auth.mail[0]?.text ?? "") };
  }

  async function memberOf(
    auth: ReturnType<typeof makeAuth>,
    organizationId: string,
    userId: string,
  ) {
    return auth.storage.findOne("member", [
      { field: "organizationId", op: "eq", value: organizationId },
      { field: "userId", op: "eq", value: userId },
    ]);
  }

  it("accepts while the inviter still holds the rank", async () => {
    const auth = orgAuth();
    const { org, x, token } = await invitedByAdmin(auth);
    const r = await acceptInvitation(auth.config, { user: x, token, ip: null });
    expect(r.ok && r.value.member.role).toBe("member");
    expect((await memberOf(auth, org.id, x.id))?.role).toBe("member");
  });

  it("refuses with invalid_token and deletes the invitation when the inviter was removed", async () => {
    const auth = orgAuth();
    const { owner, org, admin, x, token } = await invitedByAdmin(auth);
    expect(
      (await removeMember(auth.config, { user: owner, organizationId: org.id, userId: admin.id }))
        .ok,
    ).toBe(true);
    expect(await acceptInvitation(auth.config, { user: x, token, ip: null })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    expect(await memberOf(auth, org.id, x.id)).toBeNull();
    expect(await auth.storage.findMany("invitation", [])).toEqual([]);
  });

  it("refuses with invalid_token and deletes the invitation when the inviter was demoted to viewer", async () => {
    const auth = orgAuth();
    const { owner, org, admin, x, token } = await invitedByAdmin(auth);
    expect(
      (
        await updateMemberRole(auth.config, {
          user: owner,
          organizationId: org.id,
          userId: admin.id,
          role: "viewer",
        })
      ).ok,
    ).toBe(true);
    expect(await acceptInvitation(auth.config, { user: x, token, ip: null })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    expect(await memberOf(auth, org.id, x.id)).toBeNull();
    expect(await auth.storage.findMany("invitation", [])).toEqual([]);
  });

  it("refuses with invalid_token a role that ranks 0 after a rank table change (Review M-3)", async () => {
    const before = makeAuth({
      organizations: { ranks: { guest: 1, viewer: 2, member: 3, admin: 4, owner: 5 } },
    });
    const { owner, org } = await owned(before);
    const inv = await inviteMember(before.config, {
      user: owner,
      organizationId: org.id,
      email: "x@example.com",
      role: "guest",
    });
    expect(inv.ok).toBe(true);
    const token = tokenFrom(before.mail[0]?.text ?? "");
    const x = await before.seedUser("x@example.com");
    // The app drops guest from the rank table before the accept.
    const after = makeAuth({ organizations: {}, storage: before.storage });
    expect(await acceptInvitation(after.config, { user: x, token, ip: null })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    expect(await memberOf(after, org.id, x.id)).toBeNull();
  });

  it("refuses with invalid_token a platform role when the organization no longer has the platform slug (Review I-4)", async () => {
    const auth = platformAuth();
    const { root, platformOrg } = await seedPlatform(auth);
    const inv = await inviteMember(auth.config, {
      user: root,
      organizationId: platformOrg.id,
      email: "op2@example.com",
      role: "operator",
    });
    expect(inv.ok).toBe(true);
    const token = tokenFrom(auth.mail[0]?.text ?? "");
    const op2 = await auth.seedUser("op2@example.com");
    await auth.storage.update("organization", [{ field: "id", op: "eq", value: platformOrg.id }], {
      slug: "staff",
    });
    expect(await acceptInvitation(auth.config, { user: op2, token, ip: null })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    expect(await memberOf(auth, platformOrg.id, op2.id)).toBeNull();
  });
});

describe("inviteMember limits (Review I-6)", () => {
  it("answers rate_limited and sends no mail on the 21st invite by one user in 15 minutes", async () => {
    const auth = orgAuth();
    const { owner, org } = await owned(auth);
    for (let i = 0; i < 20; i++) {
      const r = await inviteMember(auth.config, {
        user: owner,
        organizationId: org.id,
        email: `p${i}@example.com`,
        role: "member",
      });
      expect(r.ok).toBe(true);
    }
    expect(
      await inviteMember(auth.config, {
        user: owner,
        organizationId: org.id,
        email: "p20@example.com",
        role: "member",
      }),
    ).toMatchObject({ ok: false, code: "rate_limited", status: 429 });
    expect(auth.mail).toHaveLength(20);
  });

  it("answers rate_limited and sends no mail on the sixth invite to one address in an hour", async () => {
    const auth = orgAuth();
    const { owner, org } = await owned(auth);
    for (let i = 0; i < 5; i++) {
      const r = await inviteMember(auth.config, {
        user: owner,
        organizationId: org.id,
        email: "victim@example.com",
        role: "member",
      });
      expect(r.ok).toBe(true);
    }
    expect(
      await inviteMember(auth.config, {
        user: owner,
        organizationId: org.id,
        email: "Victim@Example.com",
        role: "member",
      }),
    ).toMatchObject({ ok: false, code: "rate_limited", status: 429 });
    expect(auth.mail).toHaveLength(5);
  });

  it("checks the limits after the rank checks, so a stranger spends no budget", async () => {
    const auth = orgAuth();
    const { owner, org } = await owned(auth);
    const stranger = await auth.seedUser("s@example.com");
    for (let i = 0; i < 10; i++) {
      expect(
        await inviteMember(auth.config, {
          user: stranger,
          organizationId: org.id,
          email: "victim@example.com",
          role: "member",
        }),
      ).toMatchObject({ ok: false, code: "forbidden_rank" });
    }
    expect(
      (
        await inviteMember(auth.config, {
          user: owner,
          organizationId: org.id,
          email: "victim@example.com",
          role: "member",
        })
      ).ok,
    ).toBe(true);
  });
});
