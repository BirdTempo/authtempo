import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmEmailChange, requestEmailChange } from "../../src/engine/email-change.js";
import { hookRefusal } from "../../src/engine/hooks.js";
import { requestMagicLink, verifyMagicLink } from "../../src/engine/magic-link.js";
import { passwordSignUp } from "../../src/engine/password.js";
import { createRole, deleteRole } from "../../src/engine/roles.js";
import { createScimToken } from "../../src/engine/scim/tokens.js";
import { resolveSession } from "../../src/engine/sessions.js";
import { updateDomain } from "../../src/engine/sso/domains.js";
import type { AuthEvent } from "../../src/observe/port.js";
import { sha256Hex } from "../../src/primitives/crypto.js";
import type { ModelName } from "../../src/schema.js";
import { tokenFromMail } from "../helpers.js";
import { FAST, signUpAndVerify } from "../password-helpers.js";
import { scim } from "../scim/helpers.js";
import { SSO_APP, seedOrganization, verifiedDomain } from "./helpers.js";
import {
  acmeWithSso,
  oidcConnection,
  type SsoWorld,
  ssoSignIn,
  ssoSignInWorld,
} from "./sign-in-helpers.js";

beforeEach(() => {
  // A refused resolution writes one log line.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ADA = "ada@acme.example";

/** The row counts of the models that a resolution writes. */
async function counts(w: SsoWorld): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const model of ["user", "identity", "member", "session"] as const satisfies ModelName[])
    out[model] = (await w.storage.findMany(model, [])).length;
  return out;
}

async function userAt(w: SsoWorld, email: string) {
  return w.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
}

async function identitiesOf(w: SsoWorld, userId: string) {
  const rows = await w.storage.findMany("identity", [{ field: "userId", op: "eq", value: userId }]);
  return rows.map((r) => r.provider).sort();
}

async function sessionsOf(w: SsoWorld, userId: string) {
  return w.storage.findMany("session", [{ field: "userId", op: "eq", value: userId }]);
}

async function passwordOf(w: SsoWorld, userId: string) {
  return w.storage.findOne("password", [{ field: "userId", op: "eq", value: userId }]);
}

describe("the SSO resolution (plan 12d Task 5)", () => {
  it("refuses an address outside the verified domains, and reads no email_verified", async () => {
    const w = ssoSignInWorld();
    const { connectionId } = await acmeWithSso(w);
    const before = await counts(w);
    const r = await ssoSignIn(w, connectionId, "acme", {
      sub: "c-1",
      email: "ceo@other.example",
      email_verified: true,
    });
    expect(r.res.status).toBe(302);
    expect(r.error).toBe("sso_domain_mismatch");
    expect(r.token).toBeNull();
    // A profile with no address answers email_required, before the domain rule.
    const none = await ssoSignIn(w, connectionId, "acme", { sub: "c-2", email_verified: true });
    expect(none.error).toBe("email_required");
    expect(await counts(w)).toEqual(before);
  });

  it("refuses an address that a verified domain of another organization claims", async () => {
    const w = ssoSignInWorld({
      password: { hash: FAST, uniformSignUp: false, requireVerified: false },
    });
    await acmeWithSso(w);
    const kept = await signUpAndVerify(w, ADA);
    const ada = await userAt(w, ADA);
    if (!ada) throw new Error("no user");
    // Bo is an unverified password sign-up of acme.example, with a session.
    const up = await passwordSignUp(w.config, {
      email: "bo@acme.example",
      password: "a claimant's password",
      ip: null,
      userAgent: null,
    });
    if (!up.ok || !("token" in up.value)) throw new Error("the sign-up opened no session");
    const bo = await userAt(w, "bo@acme.example");
    if (!bo || bo.emailVerified) throw new Error("no unverified user");
    // Organization beta has its own verified domain and a connection.
    const beta = await seedOrganization(w, "beta");
    await verifiedDomain(w, beta, "beta.example");
    const betaIdp = await oidcConnection(w, beta, "beta");
    const before = await counts(w);
    for (const [sub, email] of [
      ["x-1", ADA],
      ["x-2", "bo@acme.example"],
    ] as const) {
      const r = await ssoSignIn(w, betaIdp, "beta", { sub, email });
      expect(r.error).toBe("sso_domain_mismatch");
      expect(r.token).toBeNull();
    }
    // No link, no session, and no claim: each row of Ada and Bo stays as it was.
    expect(await counts(w)).toEqual(before);
    expect(await identitiesOf(w, ada.id)).toEqual(["email"]);
    expect(await passwordOf(w, ada.id)).toEqual(kept);
    expect((await resolveSession(w.config, up.value.token))?.user.id).toBe(bo.id);
    expect(await passwordOf(w, bo.id)).not.toBeNull();
    expect((await userAt(w, "bo@acme.example"))?.emailVerified).toBe(false);
  });

  it("signs in a known identity", async () => {
    const w = ssoSignInWorld();
    const { connectionId } = await acmeWithSso(w);
    const first = await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA });
    const second = await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA });
    const one = await resolveSession(w.config, first.token ?? "");
    const two = await resolveSession(w.config, second.token ?? "");
    expect(one?.user.email).toBe(ADA);
    expect(two?.user.id).toBe(one?.user.id);
    expect(two?.session.id).not.toBe(one?.session.id);
    // The identity of the first sign-in signs the second in: no new identity.
    expect(await identitiesOf(w, one?.user.id ?? "")).toEqual(
      ["email", `sso:${connectionId}`].sort(),
    );
  });

  it("refuses a known identity whose user's address left the domain (final review M1)", async () => {
    const w = ssoSignInWorld();
    const { connectionId } = await acmeWithSso(w);
    const first = await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA });
    const me = await resolveSession(w.config, first.token ?? "");
    if (!me) throw new Error("no session");
    // The user moves the account address by the normal email change.
    const move = async (to: string) => {
      const session = await resolveSession(w.config, first.token ?? "");
      if (!session) throw new Error("no session");
      expect((await requestEmailChange(w.config, { session, newEmail: to })).ok).toBe(true);
      const token = tokenFromMail(w.mail.findLast((m) => m.to === to)?.text ?? "");
      expect((await confirmEmailChange(w.config, { token, ip: null, userAgent: null })).ok).toBe(
        true,
      );
    };
    await move("ada@personal.example");
    const before = await counts(w);
    // The IdP sends the old subject with an address of the domain.
    for (const email of [ADA, "anyone@acme.example"]) {
      const r = await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email });
      expect(r.error).toBe("sso_domain_mismatch");
      expect(r.token).toBeNull();
    }
    expect(await counts(w)).toEqual(before);
    expect((await userAt(w, "ada@personal.example"))?.id).toBe(me.user.id);
    // The check reads the current address: back in the domain, the identity signs in again.
    await move("ada.l@acme.example");
    const back = await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA });
    expect((await resolveSession(w.config, back.token ?? ""))?.user.id).toBe(me.user.id);
  });

  it("refuses a known identity whose address leaves the domain before the hold (ruling 78)", async () => {
    const w = ssoSignInWorld();
    const { connectionId } = await acmeWithSso(w);
    const first = await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA });
    const me = await resolveSession(w.config, first.token ?? "");
    if (!me) throw new Error("no session");
    // An email change commits after the domain rule read the address, and before the hold:
    // the first write of the user row in the sign-in sees the new address.
    const transaction = w.storage.transaction.bind(w.storage);
    let moved = false;
    w.storage.transaction = (fn) =>
      transaction((tx) =>
        fn({
          ...tx,
          update: async (model, where, data) => {
            if (model !== "user" || moved) return tx.update(model, where, data);
            moved = true;
            return tx.update(model, where, { ...data, email: "ada@personal.example" } as never);
          },
        }),
      );
    const before = await counts(w);
    const r = await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA });
    w.storage.transaction = transaction;
    expect(moved).toBe(true);
    expect(r.error).toBe("conflict");
    expect(r.token).toBeNull();
    expect(await counts(w)).toEqual(before);
    // With no change in between, the identity signs in.
    const again = await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA });
    expect((await resolveSession(w.config, again.token ?? ""))?.user.id).toBe(me.user.id);
  });

  it("links a verified user at the address", async () => {
    const w = ssoSignInWorld();
    const { connectionId } = await acmeWithSso(w);
    const kept = await signUpAndVerify(w, ADA);
    const user = await userAt(w, ADA);
    if (!user) throw new Error("no user");
    const r = await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA });
    expect((await resolveSession(w.config, r.token ?? ""))?.user.id).toBe(user.id);
    expect(await identitiesOf(w, user.id)).toEqual(["email", `sso:${connectionId}`].sort());
    expect(await passwordOf(w, user.id)).toEqual(kept);
  });

  it("claims an unverified user at the address", async () => {
    const w = ssoSignInWorld({
      password: { hash: FAST, uniformSignUp: false, requireVerified: false },
    });
    const { connectionId } = await acmeWithSso(w);
    const up = await passwordSignUp(w.config, {
      email: ADA,
      password: "a claimant's password",
      ip: null,
      userAgent: null,
    });
    if (!up.ok || !("token" in up.value)) throw new Error("the sign-up opened no session");
    const claimant = up.value.token;
    const user = await userAt(w, ADA);
    if (!user || user.emailVerified) throw new Error("no unverified user");
    expect(await passwordOf(w, user.id)).not.toBeNull();
    const r = await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA });
    expect(await resolveSession(w.config, claimant)).toBeNull();
    expect(await passwordOf(w, user.id)).toBeNull();
    expect((await userAt(w, ADA))?.emailVerified).toBe(true);
    const sessions = await sessionsOf(w, user.id);
    expect(sessions.map((s) => s.tokenHash)).toEqual([await sha256Hex(r.token ?? "")]);
  });

  it("sends one session.end with the count at a claim with no afterEnd hook (ruling 81 M1)", async () => {
    const batches: AuthEvent[][] = [];
    const w = ssoSignInWorld({
      password: { hash: FAST, uniformSignUp: false, requireVerified: false },
      observe: { sink: { write: (b) => void batches.push([...b]) } },
    });
    const { connectionId } = await acmeWithSso(w);
    const up = await passwordSignUp(w.config, {
      email: ADA,
      password: "a claimant's password",
      ip: null,
      userAgent: null,
    });
    if (!up.ok || !("token" in up.value)) throw new Error("the sign-up opened no session");
    await w.config.observe.flush();
    batches.splice(0);
    await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA });
    expect(await resolveSession(w.config, up.value.token)).toBeNull();
    await w.config.observe.flush();
    expect(
      batches
        .flat()
        .filter((e) => e.name === "session.end")
        .map((e) => [e.reason, e.count]),
    ).toEqual([["claim", 1]]);
  });

  it("refuses a user disabled by SCIM", async () => {
    const w = ssoSignInWorld({ scim: {} });
    const { connectionId, organizationId } = await acmeWithSso(w);
    const made = await createScimToken(w.config, SSO_APP, { organizationId, name: "directory" });
    if (!made.ok) throw new Error(made.code);
    const token = made.value.token;
    const created = await scim(w, token, "POST", "/Users", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: ADA,
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    const off = await scim(w, token, "PATCH", `/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(off.status).toBe(200);
    const user = await userAt(w, ADA);
    const before = await counts(w);
    const r = await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA });
    expect([r.res.status, r.error, r.token]).toEqual([302, "account_disabled", null]);
    expect(await sessionsOf(w, user?.id ?? "")).toEqual([]);
    expect(await counts(w)).toEqual(before);
  });

  it("provisions a user just in time with no password", async () => {
    const w = ssoSignInWorld();
    const { connectionId, organizationId } = await acmeWithSso(w);
    const r = await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA, name: "Ada" });
    const user = await userAt(w, ADA);
    if (!user) throw new Error("no user");
    expect((await resolveSession(w.config, r.token ?? ""))?.user.id).toBe(user.id);
    expect(user.emailVerified).toBe(true);
    expect(user.name).toBe("Ada");
    expect(await identitiesOf(w, user.id)).toEqual(["email", `sso:${connectionId}`].sort());
    expect(await passwordOf(w, user.id)).toBeNull();
    const members = await w.storage.findMany("member", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    expect(members.map((m) => [m.organizationId, m.role])).toEqual([[organizationId, "member"]]);
  });

  it("refuses a just-in-time create with jit off", async () => {
    const w = ssoSignInWorld();
    const { connectionId } = await acmeWithSso(w, { jit: false });
    const before = await counts(w);
    const r = await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA });
    expect(r.error).toBe("sso_not_provisioned");
    expect(r.token).toBeNull();
    expect(await userAt(w, ADA)).toBeNull();
    expect(await counts(w)).toEqual(before);
  });

  it("refuses a just-in-time create when sign-up is closed", async () => {
    const w = ssoSignInWorld({ signUp: false });
    const { connectionId } = await acmeWithSso(w);
    const before = await counts(w);
    const r = await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA });
    expect(r.error).toBe("sign_up_closed");
    expect(await counts(w)).toEqual(before);
  });

  it("lets the before hook refuse a create", async () => {
    const seen: (string | null)[] = [];
    const w = ssoSignInWorld({
      hooks: {
        sso: {
          beforeSignIn: (e) => {
            seen.push(e.user?.email ?? null);
            if (e.profile.email?.endsWith("@contractor.acme.example"))
              throw hookRefusal("No contractor signs in here.");
            if (e.profile.email === "bug@acme.example") throw new Error("a bug of the app");
          },
        },
      },
    });
    const { connectionId, domainId } = await acmeWithSso(w);
    const sub = await updateDomain(w.config, SSO_APP, {
      id: domainId,
      includeSubdomains: true,
      ip: null,
      userAgent: null,
    });
    if (!sub.ok) throw new Error(sub.code);
    const before = await counts(w);
    const r = await ssoSignIn(w, connectionId, "acme", {
      sub: "k-1",
      email: "kim@contractor.acme.example",
    });
    expect(r.error).toBe("hook_refused");
    expect(seen).toEqual([null]);
    expect(await userAt(w, "kim@contractor.acme.example")).toBeNull();
    // A hook that throws another error answers hook_failed, and writes nothing too.
    const bug = await ssoSignIn(w, connectionId, "acme", { sub: "b-1", email: "bug@acme.example" });
    expect(bug.error).toBe("hook_failed");
    expect(await counts(w)).toEqual(before);
  });

  it("adds no member past the member limit or with a role that is gone", async () => {
    const w = ssoSignInWorld({
      organizations: {
        platformRole: "operator",
        platformOrganization: "platform-co",
        ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
        dynamicRoles: {},
        limits: { membersPerOrganization: 2 },
      },
    });
    const { connectionId, organizationId } = await acmeWithSso(w);
    const owner = await userAt(w, "owner@acme.example");
    if (!owner) throw new Error("no owner");
    const made = await createRole(w.config, {
      user: owner,
      organizationId,
      name: "contractor",
      rank: 1,
      permissions: { member: ["read"] },
    });
    if (!made.ok) throw new Error(made.code);
    const contractors = await oidcConnection(w, organizationId, "acme", {
      label: "contractors",
      defaultRole: "contractor",
    });
    const gone = await deleteRole(w.config, { user: owner, organizationId, name: "contractor" });
    if (!gone.ok) throw new Error(gone.code);
    const before = await counts(w);
    const r = await ssoSignIn(w, contractors, "acme", { sub: "c-1", email: "cy@acme.example" });
    expect(r.error).toBe("role_not_found");
    expect(await counts(w)).toEqual(before);
    // The owner and Ada fill the limit of 2, so Bo gets no member row and no user.
    expect((await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA })).error).toBeNull();
    const full = await counts(w);
    const bo = await ssoSignIn(w, connectionId, "acme", { sub: "b-1", email: "bo@acme.example" });
    expect(bo.error).toBe("member_limit");
    expect(await userAt(w, "bo@acme.example")).toBeNull();
    expect(await counts(w)).toEqual(full);
  });

  it("lets organization.beforeAddMember refuse an SSO sign-in before any write", async () => {
    const order: string[] = [];
    const vias: string[] = [];
    const w = ssoSignInWorld({
      password: { hash: FAST, uniformSignUp: false, requireVerified: false },
      hooks: {
        sso: {
          beforeSignIn: () => {
            order.push("sso.beforeSignIn");
          },
        },
        organization: {
          beforeAddMember: (e) => {
            order.push("organization.beforeAddMember");
            vias.push(e.via);
            if (e.memberUser.email === ADA) throw hookRefusal("Ada joins by an invitation.");
          },
        },
        session: {
          beforeCreate: () => {
            order.push("session.beforeCreate");
          },
        },
      },
    });
    const { connectionId } = await acmeWithSso(w);
    // Ada's unverified sign-up is a claimant, so a refusal must also leave the claim undone.
    const up = await passwordSignUp(w.config, {
      email: ADA,
      password: "a claimant's password",
      ip: null,
      userAgent: null,
    });
    if (!up.ok || !("token" in up.value)) throw new Error("the sign-up opened no session");
    const claimant = up.value.token;
    const user = await userAt(w, ADA);
    if (!user || user.emailVerified) throw new Error("no unverified user");
    const kept = await passwordOf(w, user.id);
    const before = await counts(w);
    order.length = 0;
    vias.length = 0;
    const r = await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA });
    expect(r.error).toBe("hook_refused");
    expect(order).toEqual(["sso.beforeSignIn", "organization.beforeAddMember"]);
    expect(vias).toEqual(["sso"]);
    expect(await counts(w)).toEqual(before);
    expect(await userAt(w, ADA)).toEqual(user);
    expect(await identitiesOf(w, user.id)).toEqual([]);
    expect(await passwordOf(w, user.id)).toEqual(kept);
    expect((await resolveSession(w.config, claimant))?.user.id).toBe(user.id);
    // A sign-in that the hook lets through runs the three hooks in this order.
    order.length = 0;
    const bo = await ssoSignIn(w, connectionId, "acme", { sub: "b-1", email: "bo@acme.example" });
    expect(bo.error).toBeNull();
    expect(order).toEqual([
      "sso.beforeSignIn",
      "organization.beforeAddMember",
      "session.beforeCreate",
    ]);
    expect(vias).toEqual(["sso", "sso"]);
  });

  it("wins one claim in the race of plan 6b", async () => {
    let claims = 0;
    const w = ssoSignInWorld({
      password: { hash: FAST, uniformSignUp: false, requireVerified: false },
      hooks: {
        user: {
          afterVerify: () => {
            claims++;
          },
        },
      },
    });
    const { connectionId } = await acmeWithSso(w);
    const up = await passwordSignUp(w.config, {
      email: ADA,
      password: "a claimant's password",
      ip: null,
      userAgent: null,
    });
    if (!up.ok || !("token" in up.value)) throw new Error("the sign-up opened no session");
    const claimant = up.value.token;
    const user = await userAt(w, ADA);
    if (!user) throw new Error("no user");
    await requestMagicLink(w.config, { email: ADA, ip: null });
    const link = tokenFromMail(w.mail.at(-1)?.text ?? "");
    const [sso, mailed] = await Promise.all([
      ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA }),
      verifyMagicLink(w.config, { token: link, ip: null, userAgent: null }),
    ]);
    if (!mailed.ok || !("token" in mailed.value)) throw new Error("the link opened no session");
    // One claim: the second proof finds a verified user.
    expect(claims).toBe(1);
    // The claimant's session is gone. Each proof is the owner's, so its session stays.
    expect(await resolveSession(w.config, claimant)).toBeNull();
    const hashes = (await sessionsOf(w, user.id)).map((s) => s.tokenHash).sort();
    expect(hashes).toEqual(
      [await sha256Hex(sso.token ?? ""), await sha256Hex(mailed.value.token)].sort(),
    );
    expect(await passwordOf(w, user.id)).toBeNull();
  });
});
