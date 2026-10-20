import { describe, expect, it } from "vitest";
import type { Statements } from "../src/access.js";
import type { AuthConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import type { Caller } from "../src/engine/tokens.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { newId } from "../src/primitives/ids.js";
import type { UserRow } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { APP_ORIGIN, BASE_URL, get, post } from "./helpers.js";
import {
  basicHeader,
  codeFor,
  exchange,
  type Handle,
  oauthHandle,
  RESOURCE,
  tokenPost,
} from "./oauth-helpers.js";

const P = "/auth/organizations";
const t0 = new Date("2026-01-01T00:00:00.000Z");

/** consumerd's rank table: guardian and teacher share rank 2 and hold other statements. */
const CONSUMER_D_ROLES = {
  learner: { rank: 1, permissions: { member: ["read"] } },
  guardian: { rank: 2, permissions: { member: ["read"], invitation: ["read", "create"] } },
  teacher: { rank: 2, permissions: { member: ["read", "update"] } },
  admin: {
    rank: 3,
    permissions: {
      member: ["read", "create", "update", "delete"],
      invitation: ["read", "create", "cancel"],
    },
  },
  owner: {
    rank: 4,
    permissions: {
      organization: ["update", "delete"],
      member: ["read", "create", "update", "delete"],
      invitation: ["read", "create", "cancel"],
    },
  },
};

/**
 * An app resource `grades`: grader holds `grades:write` at rank 1, and admin
 * does not hold it at rank 3. So admin outranks grader and still may not touch it.
 */
const GRADES = {
  statements: { grades: ["write"] },
  roles: {
    grader: { rank: 1, permissions: { member: ["read"], grades: ["write"] } },
    member: { rank: 2, permissions: { member: ["read"] } },
    admin: {
      rank: 3,
      permissions: {
        member: ["read", "create", "update", "delete"],
        invitation: ["read", "create", "cancel"],
      },
    },
    owner: {
      rank: 4,
      permissions: {
        organization: ["update", "delete"],
        member: ["read", "create", "update", "delete"],
        invitation: ["read", "create", "cancel"],
        grades: ["write"],
      },
    },
  },
};

function world(over: Partial<AuthConfig> = {}, storage: StorageAdapter = createMemoryAdapter()) {
  const clock = { now: () => t0 };
  const auth = createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage,
    mail: { send: async () => {} },
    clock,
    limiter: createMemoryLimiter(clock),
    organizations: {},
    ...over,
  });
  const user = (email: string): Promise<UserRow> =>
    storage.create("user", {
      id: newId(t0),
      email,
      emailVerified: true,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      createdAt: t0,
      updatedAt: t0,
    });
  return { auth, storage, user };
}

/** A session of `user` through the magic link, as its cookie and its Caller. */
async function sessionOf(auth: ReturnType<typeof createAuth>, sent: string[], email: string) {
  await auth.api.requestMagicLink({ email, ip: null });
  const text = sent.at(-1) ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  return r.value.token;
}

async function callerOf(auth: ReturnType<typeof createAuth>, request: Request): Promise<Caller> {
  const caller = await auth.caller(request);
  if (!caller) throw new Error("no caller");
  return caller;
}

function bearer(token: string, url = `${BASE_URL}/app`) {
  return new Request(url, { headers: { authorization: `Bearer ${token}` } });
}

function mustOk<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

describe("the grant and touch checks (plan 12k Task 3)", () => {
  it("lets the subset check decide between two roles of one rank", async () => {
    const w = world({ organizations: { roles: CONSUMER_D_ROLES } });
    const owner = await w.user("owner@example.com");
    const teacher = await w.user("teacher@example.com");
    const guardian = await w.user("guardian@example.com");
    const learner = await w.user("learner@example.com");
    const org = mustOk(
      await w.auth.api.createOrganization({ user: owner, slug: "school", name: "School" }),
    );
    const organizationId = org.organization.id;
    for (const [u, role] of [
      [teacher, "teacher"],
      [guardian, "guardian"],
      [learner, "learner"],
    ] as const)
      mustOk(await w.auth.api.addMember({ user: owner, organizationId, userId: u.id, role }));

    // One rank, so the rank check passes; guardian holds invitation:create, which teacher lacks.
    expect(
      await w.auth.api.updateMemberRole({
        user: teacher,
        organizationId,
        userId: learner.id,
        role: "guardian",
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    expect(
      await w.auth.api.updateMemberRole({
        user: teacher,
        organizationId,
        userId: guardian.id,
        role: "learner",
      }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    // A role whose statements teacher holds: the change goes through.
    expect(
      await w.auth.api.updateMemberRole({
        user: teacher,
        organizationId,
        userId: learner.id,
        role: "learner",
      }),
    ).toMatchObject({ ok: true, value: { role: "learner" } });
    const roles = (await w.storage.findMany("member", [])).map((m) => m.role).sort();
    expect(roles).toEqual(["guardian", "learner", "owner", "teacher"]);
  });

  /** An organization of the GRADES roles with an admin and a grader, and the mail texts it sent. */
  async function graded() {
    const sent: string[] = [];
    const w = world({
      organizations: GRADES,
      mail: {
        send: async (m) => {
          sent.push(m.text);
        },
      },
    });
    const owner = await w.user("owner@example.com");
    const admin = await w.user("admin@example.com");
    const grader = await w.user("grader@example.com");
    const org = mustOk(
      await w.auth.api.createOrganization({ user: owner, slug: "school", name: "School" }),
    );
    const organizationId = org.organization.id;
    mustOk(
      await w.auth.api.addMember({ user: owner, organizationId, userId: admin.id, role: "admin" }),
    );
    mustOk(
      await w.auth.api.addMember({
        user: owner,
        organizationId,
        userId: grader.id,
        role: "grader",
      }),
    );
    return { w, sent, owner, admin, grader, organizationId };
  }

  it("refuses the removal of a member of a lower rank whose statements the caller lacks", async () => {
    const { w, admin, grader, organizationId } = await graded();
    expect(
      await w.auth.api.removeMember({ user: admin, organizationId, userId: grader.id }),
    ).toMatchObject({ ok: false, code: "forbidden_rank" });
    const roles = (await w.storage.findMany("member", [])).map((m) => m.role).sort();
    expect(roles).toEqual(["admin", "grader", "owner"]);
  });

  it("refuses an accept that raises a member whom the inviter may not touch", async () => {
    const { w, sent, admin, grader, organizationId } = await graded();
    // member ranks above grader and is a subset of admin, so the invite is a valid grant.
    mustOk(
      await w.auth.api.inviteMember({
        user: admin,
        organizationId,
        email: grader.email,
        role: "member",
      }),
    );
    const token = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(sent.at(-1) ?? "")?.[1] ?? "";
    // The raise would drop grades:write, a statement that admin does not hold.
    expect(await w.auth.api.acceptInvitation({ user: grader, token, ip: null })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    const roles = (await w.storage.findMany("member", [])).map((m) => m.role).sort();
    expect(roles).toEqual(["admin", "grader", "owner"]);
    expect(await w.storage.findMany("invitation", [])).toEqual([]);
  });

  it("refuses an accept after the inviter moves to a role of one rank without the granted statements", async () => {
    const sent: string[] = [];
    const w = world({
      organizations: {
        roles: {
          ...CONSUMER_D_ROLES,
          recruiter: { rank: 2, permissions: { invitation: ["read", "create"] } },
        },
      },
      mail: {
        send: async (m) => {
          sent.push(m.text);
        },
      },
    });
    const owner = await w.user("owner@example.com");
    const guardian = await w.user("guardian@example.com");
    const x = await w.user("x@example.com");
    const org = mustOk(
      await w.auth.api.createOrganization({ user: owner, slug: "school", name: "School" }),
    );
    const organizationId = org.organization.id;
    mustOk(
      await w.auth.api.addMember({
        user: owner,
        organizationId,
        userId: guardian.id,
        role: "guardian",
      }),
    );
    mustOk(
      await w.auth.api.inviteMember({
        user: guardian,
        organizationId,
        email: x.email,
        role: "learner",
      }),
    );
    const token = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(sent.at(-1) ?? "")?.[1] ?? "";
    // recruiter keeps rank 2 and invitation:create, but not member:read, which learner holds.
    mustOk(
      await w.auth.api.updateMemberRole({
        user: owner,
        organizationId,
        userId: guardian.id,
        role: "recruiter",
      }),
    );
    expect(await w.auth.api.acceptInvitation({ user: x, token, ip: null })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    const roles = (await w.storage.findMany("member", [])).map((m) => m.role).sort();
    expect(roles).toEqual(["owner", "recruiter"]);
    expect(await w.storage.findMany("invitation", [])).toEqual([]);
  });
});

/** An OAuth handle with organizations on, and the mail texts it sent. */
function oauthWorld() {
  const sent: string[] = [];
  const h = oauthHandle({
    organizations: {},
    mail: {
      send: async (m) => {
        sent.push(m.text);
      },
    },
  });
  return { h, sent };
}

/** An access token of the client_credentials grant: an `oauth-client` caller. */
async function clientCaller(h: Handle): Promise<Caller> {
  const clients = h.auth.api.oauth?.clients;
  if (!clients) throw new Error("oauth is off");
  const made = await clients.create({
    name: "Billing service",
    authMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    credentialsScopes: ["mcp:read"],
  });
  if (!made.ok || !made.value.clientSecret) throw new Error("no client");
  const res = await h.auth.handle(
    tokenPost(
      { grant_type: "client_credentials", resource: RESOURCE },
      { authorization: basicHeader(made.value.client.id, made.value.clientSecret) },
    ),
  );
  const token = String(((await res.json()) as Record<string, unknown>).access_token);
  return callerOf(h.auth, bearer(token, `${RESOURCE}/tools`));
}

describe("hasPermission (plan 12k Task 3)", () => {
  it("answers hasPermission by the kind of the caller", async () => {
    const { h } = oauthWorld();
    // The OAuth user: an owner of acme and of other.
    const s = await codeFor(h);
    const user = s.user;
    const acme = mustOk(await h.auth.api.createOrganization({ user, slug: "acme", name: "Acme" }));
    const other = mustOk(
      await h.auth.api.createOrganization({ user, slug: "other", name: "Other" }),
    );
    const O = acme.organization.id;
    const add = { organizationId: O, permissions: { member: ["create"] } };

    const session = await callerOf(
      h.auth,
      new Request(`${BASE_URL}/app`, { headers: { cookie: s.cookie } }),
    );
    const free = mustOk(await h.auth.api.tokens.create({ user, name: "free" }));
    const bound = mustOk(
      await h.auth.api.tokens.create({ user, name: "bound", organizationId: O }),
    );
    const elsewhere = mustOk(
      await h.auth.api.tokens.create({
        user,
        name: "elsewhere",
        organizationId: other.organization.id,
      }),
    );
    const res = await h.auth.handle(exchange(s.code, s.clientId, s.verifier));
    const access = String(((await res.json()) as Record<string, unknown>).access_token);
    const oauth = await callerOf(h.auth, bearer(access, `${RESOURCE}/tools`));
    const client = await clientCaller(h);

    const rows: [string, Caller][] = [
      ["session", session],
      ["token with no organization", await callerOf(h.auth, bearer(free.token))],
      ["token bound to O", await callerOf(h.auth, bearer(bound.token))],
      ["token bound to another organization", await callerOf(h.auth, bearer(elsewhere.token))],
      ["oauth", oauth],
      ["oauth-client", client],
    ];
    const answers: Record<string, boolean> = {};
    for (const [name, caller] of rows) answers[name] = await h.auth.hasPermission(caller, add);
    expect(answers).toEqual({
      session: true,
      "token with no organization": true,
      "token bound to O": true,
      "token bound to another organization": false,
      oauth: false,
      "oauth-client": false,
    });
    expect(rows.map(([, c]) => c.kind)).toEqual([
      "session",
      "token",
      "token",
      "token",
      "oauth",
      "oauth-client",
    ]);
    // The bound token acts in its own organization.
    expect(
      await h.auth.hasPermission(rows[3]?.[1] as Caller, {
        organizationId: other.organization.id,
        permissions: { member: ["create"] },
      }),
    ).toBe(true);
    // An empty request, an unknown action, and an unknown organization answer false.
    for (const input of [
      { organizationId: O, permissions: {} },
      { organizationId: O, permissions: { member: ["fly"] } },
      { organizationId: "01JUNKNOWNORGANIZATION0000", permissions: { member: ["read"] } },
    ])
      expect(await h.auth.hasPermission(session, input)).toBe(false);
  });

  it("answers false when the storage throws", async () => {
    const base = createMemoryAdapter();
    let broken = false;
    const storage: StorageAdapter = {
      ...base,
      findOne(model, where) {
        if (broken && model === "member") throw new Error("storage down");
        return base.findOne(model, where);
      },
    };
    const sent: string[] = [];
    const w = world(
      {
        mail: {
          send: async (m) => {
            sent.push(m.text);
          },
        },
      },
      storage,
    );
    const ada = await w.user("ada@example.com");
    const org = mustOk(await w.auth.api.createOrganization({ user: ada, slug: "acme", name: "A" }));
    const caller = await callerOf(w.auth, bearer(await sessionOf(w.auth, sent, ada.email)));
    const input = { organizationId: org.organization.id, permissions: { member: ["read"] } };
    expect(await w.auth.hasPermission(caller, input)).toBe(true);
    broken = true;
    expect(await w.auth.hasPermission(caller, input)).toBe(false);
  });

  it("answers false with organizations off", async () => {
    const sent: string[] = [];
    const storage = createMemoryAdapter();
    const clock = { now: () => t0 };
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage,
      mail: {
        send: async (m) => {
          sent.push(m.text);
        },
      },
      clock,
      limiter: createMemoryLimiter(clock),
    });
    const caller = await callerOf(auth, bearer(await sessionOf(auth, sent, "ada@example.com")));
    const input = {
      organizationId: "01JUNKNOWNORGANIZATION0000",
      permissions: { member: ["read"] },
    };
    expect(await auth.hasPermission(caller, input)).toBe(false);
    expect(await auth.permissionsOf(caller, input.organizationId)).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});

describe("the permission routes (plan 12k Task 3)", () => {
  async function owned() {
    const sent: string[] = [];
    const w = world({
      mail: {
        send: async (m) => {
          sent.push(m.text);
        },
      },
    });
    const ada = await w.user("ada@example.com");
    const bob = await w.user("bob@example.com");
    const org = mustOk(await w.auth.api.createOrganization({ user: ada, slug: "acme", name: "A" }));
    const id = org.organization.id;
    mustOk(
      await w.auth.api.addMember({ user: ada, organizationId: id, userId: bob.id, role: "member" }),
    );
    const ts = await sessionOf(w.auth, sent, ada.email);
    const tk = mustOk(await w.auth.api.tokens.create({ user: ada, name: "script" })).token;
    return { w, sent, ada, id, ts, tk };
  }
  const json = async (res: Response) => ({ status: res.status, body: await res.json() });

  it("serves has-permission and permissions to a session only", async () => {
    const { w, sent, id, ts, tk } = await owned();
    const auth = { authorization: `Bearer ${ts}` };
    const ask = (permissions: Statements, headers = auth) =>
      w.auth.handle(post(`${P}/has-permission`, { organizationId: id, permissions }, headers));
    const read = (headers: Record<string, string>, organizationId = id) =>
      w.auth.handle(get(`${P}/permissions?organizationId=${organizationId}`, headers));

    const token = { authorization: `Bearer ${tk}` };
    expect(await json(await ask({ member: ["read"] }, token))).toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
    expect(await json(await read(token))).toEqual({ status: 401, body: { error: "unauthorized" } });

    expect(await json(await ask({ member: ["create"] }))).toEqual({
      status: 200,
      body: { success: true },
    });
    expect(await json(await read(auth))).toEqual({
      status: 200,
      body: {
        role: "owner",
        permissions: {
          organization: ["update", "delete"],
          member: ["read", "create", "update", "delete"],
          invitation: ["read", "create", "cancel"],
          team: ["create", "update", "delete"],
          ac: ["read", "create", "update", "delete"],
          apiToken: ["read", "create", "update", "revoke"],
        },
      },
    });

    // A member: the default member role holds the two read actions only.
    const bob = { authorization: `Bearer ${await sessionOf(w.auth, sent, "bob@example.com")}` };
    expect(await json(await ask({ member: ["create"] }, bob))).toEqual({
      status: 200,
      body: { success: false },
    });
    expect(await json(await read(bob))).toEqual({
      status: 200,
      body: { role: "member", permissions: { member: ["read"], ac: ["read"] } },
    });

    // A person who is no member: no role and no permission, so a page hides every control.
    const eve = { authorization: `Bearer ${await sessionOf(w.auth, sent, "eve@example.com")}` };
    expect(await json(await read(eve))).toEqual({
      status: 200,
      body: { role: null, permissions: {} },
    });
    expect(await json(await read(auth, "01JUNKNOWNORGANIZATION0000"))).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
    expect(await json(await w.auth.handle(get(`${P}/permissions`, auth)))).toEqual({
      status: 400,
      body: { error: "invalid_body" },
    });
  });

  it("refuses an extra key in the has-permission body", async () => {
    const { w, id, ts } = await owned();
    const res = await w.auth.handle(
      post(
        `${P}/has-permission`,
        {
          organizationId: id,
          permissions: { member: ["read"] },
          permission: { member: ["read"] },
        },
        { authorization: `Bearer ${ts}` },
      ),
    );
    expect(await json(res)).toEqual({ status: 400, body: { error: "invalid_body" } });
  });
});
