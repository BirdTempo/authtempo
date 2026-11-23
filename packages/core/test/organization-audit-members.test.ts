import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { hookRefusal } from "../src/engine/hooks.js";
import { acceptInvitation, inviteMember, revokeInvitation } from "../src/engine/invitations.js";
import { ORGANIZATION_AUDIT_REASON } from "../src/engine/operator/audit.js";
import { createOrganizationToken } from "../src/engine/organization-tokens.js";
import { addMember, removeMember } from "../src/engine/organizations.js";
import { createScimToken } from "../src/engine/scim/tokens.js";
import { createConnection } from "../src/engine/sso/connections.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { post, recordCredential } from "./helpers.js";
import { SCIM_APP, scim, scimAuth } from "./scim/helpers.js";
import { type FakeIdToken, fakeFetch, fakeJwt } from "./social-helpers.js";
import { SSO_APP } from "./sso/helpers.js";
import { endpointsOf, issuerOf, ssoSignIn } from "./sso/sign-in-helpers.js";
import { verifiedSession } from "./totp-helpers.js";

// Plan 13b Task 4: the audit rows of the member and invitation acts of an organization.

const IP = "198.51.100.44";
const AGENT = "organization-audit-members-test";
const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";

beforeEach(() => {
  for (const m of ["error", "info", "warn", "log", "debug"] as const)
    vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The world of `scimAuth` (organization `o1`, its owner `u1`, a verified domain) with OIDC on a fake IdP. */
async function world(overrides: Partial<AuthConfig> = {}) {
  const tokens: Record<string, FakeIdToken> = {};
  const idp = fakeFetch((call) =>
    Response.json({ id_token: call.form.code, token_type: "Bearer" }),
  );
  const w = await scimAuth({
    sso: { oidc: true, fetch: idp.fetchFn },
    jwt: fakeJwt(tokens),
    ...overrides,
  });
  return { ...w, tokens, o1: w.org };
}
type W = Awaited<ReturnType<typeof world>>;

/** One POST of the organization routes with the session of `token`, from `IP` with `AGENT`. */
async function act(w: W, path: string, body: unknown, token: string) {
  const res = await w.handle(
    post(`/auth/organizations${path}`, body, {
      cookie: `__Host-tempo_session=${token}`,
      "cf-connecting-ip": IP,
      "user-agent": AGENT,
    }),
  );
  const answer = (await res.json()) as Record<string, unknown>;
  if (res.status !== 200) throw new Error(`${path}: ${res.status} ${JSON.stringify(answer)}`);
  return answer;
}

/** The invitation token of the last mail to `email`. */
function invitationToken(w: W, email: string): string {
  const re = /invitation=(inv_[A-Za-z0-9_-]+)/;
  const text = w.mail.findLast((m) => m.to === email && re.test(m.text))?.text ?? "";
  const m = re.exec(text);
  if (!m?.[1]) throw new Error(`no invitation mail to ${email}`);
  return recordCredential(m[1]);
}

/** The audit rows of `o1` with an action of the member and invitation acts, in id order. */
async function memberRows(w: W) {
  const rows = await w.storage.findMany(
    "operatorAudit",
    [{ field: "organizationId", op: "eq", value: w.o1 }],
    { sort: { field: "id", dir: "asc" } },
  );
  return rows.filter((r) => r.action.startsWith("organization_"));
}

/** A store whose `create` of the audit row throws, inside a transaction and outside it. */
function auditCreateFails(inner: StorageAdapter): StorageAdapter {
  const wrap = (s: StorageAdapter): StorageAdapter =>
    new Proxy(s, {
      get(target, prop, receiver) {
        if (prop === "create")
          return (model: string, data: unknown) => {
            if (model === "operatorAudit") throw new Error("the audit insert failed");
            return (target.create as (m: string, d: unknown) => unknown)(model, data);
          };
        if (prop === "transaction")
          return (fn: (tx: StorageAdapter) => Promise<unknown>) =>
            target.transaction((tx) => fn(wrap(tx)));
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return wrap(inner);
}

const memberOf = (w: W, userId: string) =>
  w.storage.findOne("member", [
    { field: "organizationId", op: "eq", value: w.o1 },
    { field: "userId", op: "eq", value: userId },
  ]);

describe("the audit rows of the member and invitation acts (plan 13b Task 4)", () => {
  it("each act: one row with the action, the actor, the target, and the data of the table", async () => {
    const w = await world();
    const u1 = w.owner.user.id;
    const bo = await verifiedSession(w, "bo@acme.example");
    const cy = await verifiedSession(w, "cy@acme.example");
    const base = { organizationId: w.o1 };
    await act(w, "/members/add", { ...base, userId: bo.user.id, role: "member" }, w.owner.token);
    await act(w, "/members/role", { ...base, userId: bo.user.id, role: "admin" }, w.owner.token);
    const made = await act(
      w,
      "/invite",
      { ...base, email: "cy@acme.example", role: "member" },
      w.owner.token,
    );
    const invitationId = (made.invitation as { id: string }).id;
    await act(w, "/invitations/accept", { token: invitationToken(w, "cy@acme.example") }, cy.token);
    const other = await act(
      w,
      "/invite",
      { ...base, email: "di@acme.example", role: "member" },
      w.owner.token,
    );
    const revokedId = (other.invitation as { id: string }).id;
    await act(w, "/invitations/revoke", { ...base, invitationId: revokedId }, w.owner.token);
    await act(w, "/members/remove", { ...base, userId: bo.user.id }, w.owner.token);
    const rows = await memberRows(w);
    expect(
      rows.map((r) => [
        r.action,
        r.actorKind,
        r.actorId,
        r.targetUserId,
        r.data,
        r.ip,
        r.userAgent,
      ]),
    ).toEqual([
      ["organization_member_add", "user", u1, bo.user.id, { role: "member" }, IP, AGENT],
      [
        "organization_member_role_change",
        "user",
        u1,
        bo.user.id,
        { from: "member", to: "admin" },
        IP,
        AGENT,
      ],
      [
        "organization_invitation_create",
        "user",
        u1,
        null,
        { invitationId, role: "member" },
        IP,
        AGENT,
      ],
      [
        "organization_invitation_accept",
        "user",
        cy.user.id,
        cy.user.id,
        { invitationId, role: "member" },
        IP,
        AGENT,
      ],
      [
        "organization_invitation_create",
        "user",
        u1,
        null,
        { invitationId: revokedId, role: "member" },
        IP,
        AGENT,
      ],
      ["organization_invitation_revoke", "user", u1, null, { invitationId: revokedId }, IP, AGENT],
      [
        "organization_member_remove",
        "user",
        u1,
        bo.user.id,
        { role: "admin", self: false },
        IP,
        AGENT,
      ],
    ]);
    for (const row of rows) {
      expect(row.organizationId).toBe(w.o1);
      expect(row.reason).toBe(
        ORGANIZATION_AUDIT_REASON[row.action as keyof typeof ORGANIZATION_AUDIT_REASON],
      );
    }
  });

  it("refused act: a member without member:create adds a user, and no row is written", async () => {
    const w = await world();
    const bo = await verifiedSession(w, "bo@acme.example");
    const cy = await verifiedSession(w, "cy@acme.example");
    const added = await addMember(w.config, {
      user: w.owner.user,
      organizationId: w.o1,
      userId: bo.user.id,
      role: "member",
    });
    if (!added.ok) throw new Error(added.code);
    const before = await memberRows(w);
    expect(before.map((r) => r.action)).toEqual(["organization_member_add"]);
    const refused = await addMember(w.config, {
      user: bo.user,
      session: bo.session,
      organizationId: w.o1,
      userId: cy.user.id,
      role: "member",
    });
    expect(refused).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(await memberOf(w, cy.user.id)).toBeNull();
    expect(await memberRows(w)).toEqual(before);
  });

  it("hook refuses: beforeAddMember throws, and no row and no member are written", async () => {
    const w = await world({
      hooks: {
        organization: {
          // The owner of `o1` joins at the create through the same hook, so the hook refuses Bo only.
          beforeAddMember: (e) => {
            if (e.memberUser.email === "bo@acme.example")
              throw hookRefusal("Bo joins by an invitation.");
          },
        },
      },
    });
    const bo = await verifiedSession(w, "bo@acme.example");
    const refused = await addMember(w.config, {
      user: w.owner.user,
      organizationId: w.o1,
      userId: bo.user.id,
      role: "member",
    });
    expect(refused).toMatchObject({ ok: false, code: "hook_refused" });
    expect(await memberOf(w, bo.user.id)).toBeNull();
    expect(await memberRows(w)).toEqual([]);
  });

  it("audit throw: the audit insert of a member add throws, and no member and no row stay", async () => {
    const w = await world();
    const bo = await verifiedSession(w, "bo@acme.example");
    const config = { ...w.config, storage: auditCreateFails(w.config.storage) };
    await expect(
      addMember(config, {
        user: w.owner.user,
        organizationId: w.o1,
        userId: bo.user.id,
        role: "member",
      }),
    ).rejects.toThrow("the audit insert failed");
    expect(await memberOf(w, bo.user.id)).toBeNull();
    expect(await memberRows(w)).toEqual([]);
  });

  it("no address: the rows of an invitation to a@example.test hold the address in no field", async () => {
    const w = await world();
    const email = "a@example.test";
    const invite = () =>
      inviteMember(w.config, { user: w.owner.user, organizationId: w.o1, email, role: "member" });
    const first = await invite();
    if (!first.ok) throw new Error(first.code);
    const revoked = await revokeInvitation(w.config, {
      user: w.owner.user,
      organizationId: w.o1,
      invitationId: first.value.id,
    });
    expect(revoked.ok).toBe(true);
    expect((await invite()).ok).toBe(true);
    const a = await verifiedSession(w, email);
    const accepted = await acceptInvitation(w.config, {
      user: a.user,
      session: a.session,
      token: invitationToken(w, email),
      ip: null,
    });
    expect(accepted.ok).toBe(true);
    const rows = await memberRows(w);
    expect(rows.map((r) => r.action)).toEqual([
      "organization_invitation_create",
      "organization_invitation_revoke",
      "organization_invitation_create",
      "organization_invitation_accept",
    ]);
    for (const row of rows)
      for (const value of Object.values(row))
        expect(JSON.stringify(value) ?? "").not.toContain(email);
  });

  it("SCIM add: a SCIM create adds the member, and writes scim_user_create only", async () => {
    const w = await world();
    const made = await createScimToken(w.config, SCIM_APP, { organizationId: w.o1, name: "dir-1" });
    if (!made.ok) throw new Error(made.code);
    recordCredential(made.value.token);
    const res = await scim(w, made.value.token, "POST", "/Users", {
      schemas: [USER_URN],
      userName: "ada@acme.example",
    });
    expect(res.status).toBe(201);
    const ada = await w.storage.findOne("user", [
      { field: "email", op: "eq", value: "ada@acme.example" },
    ]);
    expect(await memberOf(w, ada?.id ?? "")).not.toBeNull();
    const rows = await w.storage.findMany("operatorAudit", [
      { field: "organizationId", op: "eq", value: w.o1 },
      { field: "targetUserId", op: "eq", value: ada?.id ?? "" },
    ]);
    expect(rows.map((r) => r.action)).toEqual(["scim_user_create"]);
    expect(await memberRows(w)).toEqual([]);
  });

  it("JIT: a first SSO sign-in adds the member, and writes no row", async () => {
    const w = await world();
    const connection = await createConnection(w.config, SSO_APP, {
      organizationId: w.o1,
      kind: "oidc",
      label: "Acme IdP",
      issuer: issuerOf("acme"),
      clientId: "acme-client",
      clientSecret: "acme-secret-0123456789",
      endpoints: endpointsOf("acme"),
    });
    if (!connection.ok) throw new Error(connection.code);
    const r = await ssoSignIn(w, connection.value.id, "acme", {
      sub: "a-1",
      email: "ada@acme.example",
      name: "Ada",
    });
    expect(r.token).not.toBeNull();
    const ada = await w.storage.findOne("user", [
      { field: "email", op: "eq", value: "ada@acme.example" },
    ]);
    expect(await memberOf(w, ada?.id ?? "")).not.toBeNull();
    expect(await memberRows(w)).toEqual([]);
  });

  it("leave: u2 leaves o1, and the row is organization_member_remove with self true, actor u2", async () => {
    const w = await world();
    const u2 = await verifiedSession(w, "bo@acme.example");
    const added = await addMember(w.config, {
      user: w.owner.user,
      organizationId: w.o1,
      userId: u2.user.id,
      role: "member",
    });
    if (!added.ok) throw new Error(added.code);
    const left = await removeMember(w.config, {
      user: u2.user,
      session: u2.session,
      organizationId: w.o1,
      userId: u2.user.id,
    });
    expect(left.ok).toBe(true);
    const rows = await memberRows(w);
    expect(rows.at(-1)).toMatchObject({
      action: "organization_member_remove",
      actorKind: "user",
      actorId: u2.user.id,
      targetUserId: u2.user.id,
      data: { role: "member", self: true },
      organizationId: w.o1,
    });
    expect(rows).toHaveLength(2);
  });

  it("member remove with tokens: one remove row with revokedTokens 1, and no token revoke row", async () => {
    const w = await world();
    const bo = await verifiedSession(w, "bo@acme.example");
    const added = await addMember(w.config, {
      user: w.owner.user,
      organizationId: w.o1,
      userId: bo.user.id,
      role: "admin",
    });
    if (!added.ok) throw new Error(added.code);
    const made = await createOrganizationToken(w.config, {
      session: bo,
      organizationId: w.o1,
      name: "ci",
      permissions: {},
    });
    if (!made.ok) throw new Error(made.code);
    recordCredential(made.value.token);
    const removed = await removeMember(w.config, {
      user: w.owner.user,
      session: w.owner.session,
      organizationId: w.o1,
      userId: bo.user.id,
      revokeTokens: true,
    });
    expect(removed.ok).toBe(true);
    expect(await w.storage.findMany("organizationToken", [])).toEqual([]);
    const rows = await memberRows(w);
    expect(rows.filter((r) => r.action === "organization_member_remove")).toEqual([
      expect.objectContaining({
        targetUserId: bo.user.id,
        data: { role: "admin", self: false, revokedTokens: 1 },
      }),
    ]);
    expect(rows.filter((r) => r.action === "organization_token_revoke")).toEqual([]);
  });
});
