import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrganizationLimits } from "../src/config.js";
import {
  hookRefusal,
  ORGANIZATION_HOOK_POINTS,
  type OrganizationHooks,
} from "../src/engine/hooks.js";
import {
  acceptInvitation,
  declineInvitation,
  inviteMember,
  revokeInvitation,
} from "../src/engine/invitations.js";
import {
  addMember,
  createOrganization,
  removeMember,
  updateMemberRole,
} from "../src/engine/organizations.js";
import { createSession } from "../src/engine/sessions.js";
import { createRouter } from "../src/http/router.js";
import { organizationRoutes } from "../src/http/routes/organizations.js";
import { makeAuth, post } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Every organization hook point records its name and its event, in call
 * order. `over` replaces some points with hooks that do not record.
 */
function recorded(over: OrganizationHooks = {}, limits: OrganizationLimits = {}) {
  const calls: [string, unknown][] = [];
  const organization = Object.fromEntries(
    Object.keys(ORGANIZATION_HOOK_POINTS).map((name) => [
      name,
      (e: unknown) => {
        calls.push([name, e]);
      },
    ]),
  ) as OrganizationHooks;
  const auth = makeAuth({
    organizations: { limits },
    hooks: { organization: { ...organization, ...over } },
  });
  return { auth, calls, names: () => calls.map(([name]) => name) };
}

async function acme(auth: ReturnType<typeof makeAuth>) {
  const owner = await auth.seedUser("owner@example.com");
  const r = await createOrganization(auth.config, { user: owner, slug: "acme", name: "Acme" });
  if (!r.ok) throw new Error(r.code);
  return { owner, organization: r.value.organization };
}

/** The token of the newest invitation mail. */
function lastToken(auth: ReturnType<typeof makeAuth>): string {
  const m = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(auth.mail.at(-1)?.text ?? "");
  if (!m?.[1]) throw new Error("no token in mail");
  return m[1];
}

describe("member hooks (plan 9d)", () => {
  it("fires beforeAddMember and afterAddMember with via add, and a refusal adds no row", async () => {
    const { auth, calls, names } = recorded();
    const { owner, organization } = await acme(auth);
    const bob = await auth.seedUser("bob@example.com");
    calls.length = 0;
    const r = await addMember(auth.config, {
      user: owner,
      organizationId: organization.id,
      userId: bob.id,
      role: "member",
    });
    if (!r.ok) throw new Error(r.code);
    expect(names()).toEqual(["beforeAddMember", "afterAddMember"]);
    expect(calls[0]?.[1]).toEqual({
      organization,
      member: { userId: bob.id, role: "member" },
      memberUser: bob,
      by: owner,
      via: "add",
      invitation: null,
    });
    expect(calls[1]?.[1]).toEqual({
      organization,
      member: r.value,
      memberUser: bob,
      by: owner,
      via: "add",
      invitation: null,
    });

    const refusing = recorded({
      beforeAddMember(e) {
        if (e.via === "add") throw hookRefusal("Seats are full.");
      },
    });
    const a = await acme(refusing.auth);
    const carol = await refusing.auth.seedUser("carol@example.com");
    expect(
      await addMember(refusing.auth.config, {
        user: a.owner,
        organizationId: a.organization.id,
        userId: carol.id,
        role: "member",
      }),
    ).toEqual({ ok: false, code: "hook_refused", status: 403, message: "Seats are full." });
    expect(
      await refusing.auth.storage.findMany("member", [
        { field: "userId", op: "eq", value: carol.id },
      ]),
    ).toEqual([]);
  });

  it("fires the role hooks with the previous role, and a refused owner demotion keeps the role and undoes the lock stamp", async () => {
    const { auth, calls, names } = recorded();
    const { owner, organization } = await acme(auth);
    const bob = await auth.seedUser("bob@example.com");
    const added = await addMember(auth.config, {
      user: owner,
      organizationId: organization.id,
      userId: bob.id,
      role: "member",
    });
    if (!added.ok) throw new Error(added.code);
    calls.length = 0;
    const r = await updateMemberRole(auth.config, {
      user: owner,
      organizationId: organization.id,
      userId: bob.id,
      role: "admin",
    });
    if (!r.ok) throw new Error(r.code);
    expect(names()).toEqual(["beforeUpdateMemberRole", "afterUpdateMemberRole"]);
    expect(calls[0]?.[1]).toEqual({
      organization,
      member: added.value,
      role: "admin",
      memberUser: bob,
      by: owner,
    });
    expect(calls[1]?.[1]).toEqual({
      organization,
      member: r.value,
      previousRole: "member",
      memberUser: bob,
      by: owner,
    });

    const refusing = recorded({
      beforeUpdateMemberRole() {
        throw hookRefusal("Owners stay owners.");
      },
    });
    const a = await acme(refusing.auth);
    const dana = await refusing.auth.seedUser("dana@example.com");
    const coOwner = await addMember(refusing.auth.config, {
      user: a.owner,
      organizationId: a.organization.id,
      userId: dana.id,
      role: "owner",
    });
    if (!coOwner.ok) throw new Error(coOwner.code);
    const orgRow = () =>
      refusing.auth.storage.findOne("organization", [
        { field: "id", op: "eq", value: a.organization.id },
      ]);
    const stamp = (await orgRow())?.updatedAt;
    expect(
      await updateMemberRole(refusing.auth.config, {
        user: a.owner,
        organizationId: a.organization.id,
        userId: dana.id,
        role: "member",
      }),
    ).toMatchObject({ ok: false, code: "hook_refused", message: "Owners stay owners." });
    // The owner lock wrote updatedAt before the hook ran. The refusal undid that write.
    expect((await orgRow())?.updatedAt).toEqual(stamp);
    expect(
      await refusing.auth.storage.findOne("member", [
        { field: "userId", op: "eq", value: dana.id },
      ]),
    ).toMatchObject({ role: "owner" });
  });

  it("fires the remove hooks with via remove and via leave, and a refusal keeps the member", async () => {
    const { auth, calls, names } = recorded();
    const { owner, organization } = await acme(auth);
    const bob = await auth.seedUser("bob@example.com");
    const carol = await auth.seedUser("carol@example.com");
    const bobMember = await addMember(auth.config, {
      user: owner,
      organizationId: organization.id,
      userId: bob.id,
      role: "member",
    });
    const carolMember = await addMember(auth.config, {
      user: owner,
      organizationId: organization.id,
      userId: carol.id,
      role: "member",
    });
    if (!bobMember.ok || !carolMember.ok) throw new Error("setup");
    calls.length = 0;
    expect(
      (
        await removeMember(auth.config, {
          user: owner,
          organizationId: organization.id,
          userId: bob.id,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await removeMember(auth.config, {
          user: carol,
          organizationId: organization.id,
          userId: carol.id,
        })
      ).ok,
    ).toBe(true);
    expect(names()).toEqual([
      "beforeRemoveMember",
      "afterRemoveMember",
      "beforeRemoveMember",
      "afterRemoveMember",
    ]);
    const removed = {
      organization,
      member: bobMember.value,
      memberUser: bob,
      by: owner,
      via: "remove",
    };
    expect(calls[0]?.[1]).toEqual(removed);
    expect(calls[1]?.[1]).toEqual(removed);
    expect(calls[2]?.[1]).toEqual({
      organization,
      member: carolMember.value,
      memberUser: carol,
      by: carol,
      via: "leave",
    });

    const refusing = recorded({
      beforeRemoveMember() {
        throw hookRefusal("Hand over your work first.");
      },
    });
    const a = await acme(refusing.auth);
    const dana = await refusing.auth.seedUser("dana@example.com");
    if (
      !(
        await addMember(refusing.auth.config, {
          user: a.owner,
          organizationId: a.organization.id,
          userId: dana.id,
          role: "member",
        })
      ).ok
    )
      throw new Error("setup");
    expect(
      await removeMember(refusing.auth.config, {
        user: dana,
        organizationId: a.organization.id,
        userId: dana.id,
      }),
    ).toMatchObject({ ok: false, code: "hook_refused", message: "Hand over your work first." });
    expect(
      await refusing.auth.storage.findMany("member", [
        { field: "userId", op: "eq", value: dana.id },
      ]),
    ).toHaveLength(1);
  });
});

describe("invitation hooks (plan 9d)", () => {
  it("fires beforeInvite and afterInvite, and a refusal writes no invitation and sends no mail", async () => {
    const { auth, calls, names } = recorded();
    const { owner, organization } = await acme(auth);
    calls.length = 0;
    const r = await inviteMember(auth.config, {
      user: owner,
      organizationId: organization.id,
      email: "Bob@Example.com",
      role: "member",
    });
    if (!r.ok) throw new Error(r.code);
    expect(names()).toEqual(["beforeInvite", "afterInvite"]);
    expect(calls[0]?.[1]).toEqual({
      organization,
      invitation: { email: "bob@example.com", role: "member" },
      by: owner,
    });
    expect(calls[1]?.[1]).toEqual({ organization, invitation: r.value, by: owner });

    const refusing = recorded({
      beforeInvite() {
        throw hookRefusal("Invite by domain only.");
      },
    });
    const a = await acme(refusing.auth);
    const mails = refusing.auth.mail.length;
    expect(
      await inviteMember(refusing.auth.config, {
        user: a.owner,
        organizationId: a.organization.id,
        email: "bob@example.com",
        role: "member",
      }),
    ).toMatchObject({ ok: false, code: "hook_refused", message: "Invite by domain only." });
    expect(await refusing.auth.storage.findMany("invitation", [])).toEqual([]);
    expect(refusing.auth.mail).toHaveLength(mails);
  });

  it("fires beforeAddMember with via invitation, then afterAddMember and afterAcceptInvitation", async () => {
    const { auth, calls, names } = recorded();
    const { owner, organization } = await acme(auth);
    const bob = await auth.seedUser("bob@example.com");
    const invited = await inviteMember(auth.config, {
      user: owner,
      organizationId: organization.id,
      email: "bob@example.com",
      role: "member",
    });
    if (!invited.ok) throw new Error(invited.code);
    calls.length = 0;
    const r = await acceptInvitation(auth.config, { user: bob, token: lastToken(auth), ip: null });
    if (!r.ok) throw new Error(r.code);
    const invitation = invited.value;
    expect(names()).toEqual(["beforeAddMember", "afterAddMember", "afterAcceptInvitation"]);
    expect(calls[0]?.[1]).toEqual({
      organization,
      member: { userId: bob.id, role: "member" },
      memberUser: bob,
      by: bob,
      via: "invitation",
      invitation,
    });
    expect(calls[1]?.[1]).toEqual({
      organization,
      member: r.value.member,
      memberUser: bob,
      by: bob,
      via: "invitation",
      invitation,
    });
    expect(calls[2]?.[1]).toEqual({ organization, invitation, member: r.value.member, user: bob });
  });

  it("keeps the invitation pending when the accept hook refuses, and the token accepts later", async () => {
    let open = false;
    const { auth } = recorded({
      beforeAddMember(e) {
        if (e.via === "invitation" && !open) throw hookRefusal("Not yet.");
      },
    });
    const { owner, organization } = await acme(auth);
    const bob = await auth.seedUser("bob@example.com");
    const invited = await inviteMember(auth.config, {
      user: owner,
      organizationId: organization.id,
      email: "bob@example.com",
      role: "member",
    });
    if (!invited.ok) throw new Error(invited.code);
    const token = lastToken(auth);
    expect(await acceptInvitation(auth.config, { user: bob, token, ip: null })).toMatchObject({
      ok: false,
      code: "hook_refused",
      message: "Not yet.",
    });
    expect(
      await auth.storage.findOne("invitation", [
        { field: "id", op: "eq", value: invited.value.id },
      ]),
    ).toMatchObject({ acceptedAt: null });
    open = true;
    expect((await acceptInvitation(auth.config, { user: bob, token, ip: null })).ok).toBe(true);
  });

  it("fires no afterAddMember when the invited person is a member already, and fires afterAcceptInvitation", async () => {
    const { auth, calls, names } = recorded();
    const { owner, organization } = await acme(auth);
    const bob = await auth.seedUser("bob@example.com");
    expect(
      (
        await addMember(auth.config, {
          user: owner,
          organizationId: organization.id,
          userId: bob.id,
          role: "admin",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await inviteMember(auth.config, {
          user: owner,
          organizationId: organization.id,
          email: "bob@example.com",
          role: "member",
        })
      ).ok,
    ).toBe(true);
    calls.length = 0;
    const r = await acceptInvitation(auth.config, { user: bob, token: lastToken(auth), ip: null });
    expect(r.ok && r.value.member.role).toBe("admin");
    expect(names()).toEqual(["beforeAddMember", "afterAcceptInvitation"]);
  });

  it("runs the role hooks once on an accept that raises an existing member's role, and no afterAddMember (final fix wave I-1)", async () => {
    const { auth, calls, names } = recorded();
    const { owner, organization } = await acme(auth);
    const bob = await auth.seedUser("bob@example.com");
    const added = await addMember(auth.config, {
      user: owner,
      organizationId: organization.id,
      userId: bob.id,
      role: "member",
    });
    if (!added.ok) throw new Error(added.code);
    const invited = await inviteMember(auth.config, {
      user: owner,
      organizationId: organization.id,
      email: "bob@example.com",
      role: "admin",
    });
    if (!invited.ok) throw new Error(invited.code);
    calls.length = 0;
    const r = await acceptInvitation(auth.config, { user: bob, token: lastToken(auth), ip: null });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.member.role).toBe("admin");
    expect(names()).toEqual([
      "beforeAddMember",
      "beforeUpdateMemberRole",
      "afterUpdateMemberRole",
      "afterAcceptInvitation",
    ]);
    expect(calls[1]?.[1]).toEqual({
      organization,
      member: added.value,
      role: "admin",
      memberUser: bob,
      by: owner,
    });
    expect(calls[2]?.[1]).toEqual({
      organization,
      member: { ...added.value, role: "admin" },
      previousRole: "member",
      memberUser: bob,
      by: owner,
    });
  });

  it("keeps the role and the invitation pending when beforeUpdateMemberRole refuses a raise by accept (final fix wave I-1)", async () => {
    const { auth, names, calls } = recorded({
      beforeUpdateMemberRole() {
        throw hookRefusal("Admins need a paid plan.");
      },
    });
    const { owner, organization } = await acme(auth);
    const bob = await auth.seedUser("bob@example.com");
    expect(
      (
        await addMember(auth.config, {
          user: owner,
          organizationId: organization.id,
          userId: bob.id,
          role: "member",
        })
      ).ok,
    ).toBe(true);
    const invited = await inviteMember(auth.config, {
      user: owner,
      organizationId: organization.id,
      email: "bob@example.com",
      role: "admin",
    });
    if (!invited.ok) throw new Error(invited.code);
    calls.length = 0;
    expect(
      await acceptInvitation(auth.config, { user: bob, token: lastToken(auth), ip: null }),
    ).toEqual({
      ok: false,
      code: "hook_refused",
      status: 403,
      message: "Admins need a paid plan.",
    });
    expect(names()).toEqual(["beforeAddMember"]);
    expect(
      await auth.storage.findOne("member", [{ field: "userId", op: "eq", value: bob.id }]),
    ).toMatchObject({ role: "member" });
    expect(
      await auth.storage.findOne("invitation", [
        { field: "id", op: "eq", value: invited.value.id },
      ]),
    ).toMatchObject({ acceptedAt: null });
  });

  it("fires afterDeclineInvitation with no user through the api, and with the session's user through the route", async () => {
    const { auth, calls } = recorded();
    const { owner, organization } = await acme(auth);
    const first = await inviteMember(auth.config, {
      user: owner,
      organizationId: organization.id,
      email: "bob@example.com",
      role: "member",
    });
    if (!first.ok) throw new Error(first.code);
    calls.length = 0;
    expect(await declineInvitation(auth.config, { token: lastToken(auth) })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(calls).toEqual([
      ["afterDeclineInvitation", { organization, invitation: first.value, user: null }],
    ]);

    const carol = await auth.seedUser("carol@example.com");
    const second = await inviteMember(auth.config, {
      user: owner,
      organizationId: organization.id,
      email: "carol@example.com",
      role: "member",
    });
    if (!second.ok) throw new Error(second.code);
    calls.length = 0;
    const handle = createRouter(auth.config, organizationRoutes(auth.config));
    const { token } = await createSession(auth.config, {
      userId: carol.id,
      ip: null,
      userAgent: null,
      proved: true,
    });
    const res = await handle(
      post(
        "/auth/organizations/invitations/decline",
        { token: lastToken(auth) },
        { authorization: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      ["afterDeclineInvitation", { organization, invitation: second.value, user: carol }],
    ]);
  });

  it("fires afterRevokeInvitation with the revoked invitation", async () => {
    const { auth, calls } = recorded();
    const { owner, organization } = await acme(auth);
    const invited = await inviteMember(auth.config, {
      user: owner,
      organizationId: organization.id,
      email: "bob@example.com",
      role: "member",
    });
    if (!invited.ok) throw new Error(invited.code);
    calls.length = 0;
    expect(
      (
        await revokeInvitation(auth.config, {
          user: owner,
          organizationId: organization.id,
          invitationId: invited.value.id,
        })
      ).ok,
    ).toBe(true);
    expect(calls).toEqual([
      ["afterRevokeInvitation", { organization, invitation: invited.value, by: owner }],
    ]);
  });
});

describe("member and invitation limits (plan 9d)", () => {
  it("membersPerOrganization refuses an add and an accept at the limit with no hook call, keeps the invitation pending, and accepts after a member leaves (Review Focus 5)", async () => {
    const { auth, calls, names } = recorded({}, { membersPerOrganization: 2 });
    const { owner, organization } = await acme(auth);
    const bob = await auth.seedUser("bob@example.com");
    const carol = await auth.seedUser("carol@example.com");
    const dana = await auth.seedUser("dana@example.com");
    const invited = await inviteMember(auth.config, {
      user: owner,
      organizationId: organization.id,
      email: "carol@example.com",
      role: "member",
    });
    if (!invited.ok) throw new Error(invited.code);
    const token = lastToken(auth);
    const add = (userId: string) =>
      addMember(auth.config, {
        user: owner,
        organizationId: organization.id,
        userId,
        role: "member",
      });
    expect((await add(bob.id)).ok).toBe(true);
    calls.length = 0;
    expect(await add(dana.id)).toEqual({ ok: false, code: "member_limit", status: 409 });
    expect(await acceptInvitation(auth.config, { user: carol, token, ip: null })).toEqual({
      ok: false,
      code: "member_limit",
      status: 409,
    });
    expect(names()).toEqual([]);
    expect(
      await auth.storage.findOne("invitation", [
        { field: "id", op: "eq", value: invited.value.id },
      ]),
    ).toMatchObject({ acceptedAt: null });
    expect(
      (
        await removeMember(auth.config, {
          user: bob,
          organizationId: organization.id,
          userId: bob.id,
        })
      ).ok,
    ).toBe(true);
    expect((await acceptInvitation(auth.config, { user: carol, token, ip: null })).ok).toBe(true);
  });

  it("membersPerOrganization lets an existing member accept a raise at a full organization (final fix wave I-1, parked 9)", async () => {
    const { auth } = recorded({}, { membersPerOrganization: 2 });
    const { owner, organization } = await acme(auth);
    const bob = await auth.seedUser("bob@example.com");
    expect(
      (
        await addMember(auth.config, {
          user: owner,
          organizationId: organization.id,
          userId: bob.id,
          role: "admin",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await inviteMember(auth.config, {
          user: owner,
          organizationId: organization.id,
          email: "bob@example.com",
          role: "owner",
        })
      ).ok,
    ).toBe(true);
    const r = await acceptInvitation(auth.config, { user: bob, token: lastToken(auth), ip: null });
    expect(r.ok && r.value.member.role).toBe("owner");
  });

  it("pendingInvitationsPerOrganization counts other addresses only, and an expired invitation frees a slot", async () => {
    const { auth } = recorded({}, { pendingInvitationsPerOrganization: 2 });
    const { owner, organization } = await acme(auth);
    const invite = (email: string) =>
      inviteMember(auth.config, {
        user: owner,
        organizationId: organization.id,
        email,
        role: "member",
      });
    expect((await invite("a@example.com")).ok).toBe(true);
    expect((await invite("b@example.com")).ok).toBe(true);
    const mails = auth.mail.length;
    expect(await invite("c@example.com")).toEqual({
      ok: false,
      code: "invitation_limit",
      status: 409,
    });
    expect(auth.mail).toHaveLength(mails);
    // A second invite of a@ replaces its own pending row, so it does not count against the limit.
    expect((await invite("a@example.com")).ok).toBe(true);
    // Past the 7 day lifetime both pending rows are dead, so neither counts.
    auth.clock.advance(8 * 86_400_000);
    expect((await invite("c@example.com")).ok).toBe(true);
  });
});
