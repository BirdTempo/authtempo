import { describe, expect, it, vi } from "vitest";
import type { OrganizationsConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { createSession } from "../src/engine/sessions.js";
import type { Caller } from "../src/engine/tokens.js";
import type { UserRow } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post } from "./helpers.js";

// Plan 12k Task 8: tokens that an organization owns (spec 29 items 14 to 16).

const DAY = 86_400_000;
const HOUR = 3_600_000;

const ALL_TOKEN = ["read", "create", "update", "revoke"];
const ALL_MEMBER = ["read", "create", "update", "delete"];

/**
 * The role form with one app resource. `maker` may create a token and do no
 * more with it. `remover` may remove a maker, and holds no `apiToken:revoke`.
 */
const ORGANIZATIONS: OrganizationsConfig = {
  statements: { project: ["read", "write"] },
  roles: {
    owner: {
      rank: 3,
      permissions: {
        organization: ["update", "delete"],
        member: ALL_MEMBER,
        invitation: ["read", "create", "cancel"],
        apiToken: ALL_TOKEN,
        project: ["read", "write"],
      },
    },
    admin: {
      rank: 2,
      permissions: { member: ALL_MEMBER, apiToken: ALL_TOKEN, project: ["read", "write"] },
    },
    remover: {
      rank: 2,
      permissions: {
        member: ["read", "delete"],
        apiToken: ["read", "create", "update"],
        project: ["read"],
      },
    },
    maker: { rank: 1, permissions: { member: ["read"], apiToken: ["create"], project: ["read"] } },
    member: { rank: 1, permissions: { member: ["read"], project: ["read"] } },
  },
};

/**
 * One storage, clock, and limiter for the engine and the routes.
 * `race.afterRead` runs once after the next read of an organization token by
 * id, before the caller goes on.
 */
function orgHandle() {
  const base = makeAuth({ organizations: ORGANIZATIONS });
  const race: { afterRead: (() => Promise<unknown>) | null } = { afterRead: null };
  const storage: StorageAdapter = {
    ...base.storage,
    async findOne(model, where) {
      const row = await base.storage.findOne(model, where);
      const run = race.afterRead;
      if (model === "organizationToken" && where.some((w) => w.field === "id") && run) {
        race.afterRead = null;
        await run();
      }
      return row;
    },
  };
  const auth = instance(base, storage);
  return { ...base, auth, race };
}

/** A core instance on the clock and the limiter of `base`. */
function instance(base: ReturnType<typeof makeAuth>, storage: StorageAdapter) {
  return createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage,
    mail: { send: async () => {} },
    clock: base.clock,
    limiter: base.config.limiter,
    organizations: ORGANIZATIONS,
  });
}
type Handle = ReturnType<typeof orgHandle>;

/** A verified user and a fresh `ts_` session token. */
async function signedIn(h: Handle, email: string) {
  const user = await h.seedUser(email);
  const { token } = await createSession(h.config, { userId: user.id, ip: null, userAgent: null });
  return { user, session: token };
}

/** A new fresh session of a user that already exists. */
async function signInAgain(h: Handle, user: UserRow) {
  const { token } = await createSession(h.config, { userId: user.id, ip: null, userAgent: null });
  return token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function mustOk<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

/** A failed result with this code. */
const fault = (code: string) => expect.objectContaining({ ok: false, code });

async function answer(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** An organization of `owner` with each other user at its role. */
async function organization(
  h: Handle,
  owner: UserRow,
  slug: string,
  members: [UserRow, string][] = [],
) {
  const org = mustOk(await h.auth.api.createOrganization({ user: owner, slug, name: slug }));
  const organizationId = org.organization.id;
  for (const [user, role] of members)
    mustOk(await h.auth.api.addMember({ user: owner, organizationId, userId: user.id, role }));
  return organizationId;
}

interface TokenJson {
  id: string;
  organizationId: string;
  name: string;
  permissions: Record<string, string[]>;
  createdById: string;
  creatorIsMember: boolean;
  remaining: number | null;
}

/** A token of `session` in `organizationId` through POST /organizations/tokens. */
async function mint(
  h: Handle,
  session: string,
  organizationId: string,
  body: Record<string, unknown>,
) {
  const res = await h.auth.handle(
    post("/auth/organizations/tokens", { organizationId, name: "ci", ...body }, bearer(session)),
  );
  if (res.status !== 200) throw new Error(`create answered ${res.status}`);
  return (await res.json()) as { token: string; apiToken: TokenJson };
}

async function list(h: Handle, session: string, organizationId: string) {
  return h.auth.handle(
    get(`/auth/organizations/tokens?organizationId=${organizationId}`, bearer(session)),
  );
}

async function callerOf(h: Handle, token: string): Promise<Caller> {
  const r = await h.auth.authenticate(new Request(`${BASE_URL}/app`, { headers: bearer(token) }));
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

const authenticateOn = (auth: Handle["auth"], token: string) =>
  auth.authenticate(new Request(`${BASE_URL}/app`, { headers: bearer(token) }));

const authenticate = (h: Handle, token: string) => authenticateOn(h.auth, token);

describe("organization tokens (plan 12k Task 8)", () => {
  it("creates, lists, narrows, and revokes an organization token with the token rights", async () => {
    const h = orgHandle();
    const ada = await signedIn(h, "ada@example.com");
    const bob = await signedIn(h, "bob@example.com");
    const may = await signedIn(h, "may@example.com");
    const pat = await signedIn(h, "pat@example.com");
    const org = await organization(h, ada.user, "acme", [
      [bob.user, "admin"],
      [may.user, "maker"],
      [pat.user, "member"],
    ]);
    const made = await mint(h, bob.session, org, {
      permissions: { project: ["read", "write"] },
      expiresInDays: null,
    });
    expect(made.token).toMatch(/^to_[A-Za-z0-9_-]{43}$/);
    expect(made.apiToken).toMatchObject({
      organizationId: org,
      name: "ci",
      expiresAt: null,
      lastUsedAt: null,
      hint: made.token.slice(3, 11),
      permissions: { project: ["read", "write"] },
      metadata: null,
      rateLimit: null,
      remaining: null,
      retired: false,
      createdById: bob.user.id,
      creatorIsMember: true,
    });
    const [row] = await h.storage.findMany("organizationToken", []);
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row).not.toHaveProperty("userId");

    // The list needs apiToken:read; a member answers forbidden_rank.
    const listed = await answer(await list(h, ada.session, org));
    expect(listed.status).toBe(200);
    const tokens = listed.body.tokens as Record<string, unknown>[];
    expect(tokens.map((t) => t.id)).toEqual([made.apiToken.id]);
    expect(tokens[0]).not.toHaveProperty("tokenHash");
    expect(tokens[0]).not.toHaveProperty("token");
    expect(await answer(await list(h, pat.session, org))).toEqual({
      status: 403,
      body: { error: "forbidden_rank" },
    });

    // The update narrows only.
    const narrow = (session: string, body: Record<string, unknown>) =>
      h.auth.handle(
        post(
          "/auth/organizations/tokens/update",
          { organizationId: org, id: made.apiToken.id, ...body },
          bearer(session),
        ),
      );
    const narrowed = await answer(
      await narrow(ada.session, { permissions: { project: ["read"] } }),
    );
    expect(narrowed.status).toBe(200);
    expect(narrowed.body).toMatchObject({ permissions: { project: ["read"] } });
    for (const permissions of [{ project: ["read", "write"] }, null])
      expect(await answer(await narrow(ada.session, { permissions }))).toEqual({
        status: 400,
        body: { error: "invalid_body" },
      });
    expect(await answer(await narrow(pat.session, { name: "x" }))).toEqual({
      status: 403,
      body: { error: "forbidden_rank" },
    });

    const caller = await callerOf(h, made.token);
    expect(caller.kind).toBe("organizationToken");
    if (caller.kind !== "organizationToken") throw new Error(caller.kind);
    expect(caller.organization.id).toBe(org);
    expect(caller.apiToken).toMatchObject({
      id: made.apiToken.id,
      permissions: { project: ["read"] },
    });
    expect(caller).not.toHaveProperty("user");

    // The creator has no right of their own: a maker who made a token cannot revoke it.
    const own = await mint(h, may.session, org, { permissions: { project: ["read"] } });
    const revoke = (session: string, id: string) =>
      h.auth.handle(
        post("/auth/organizations/tokens/revoke", { organizationId: org, id }, bearer(session)),
      );
    expect(await answer(await revoke(may.session, own.apiToken.id))).toEqual({
      status: 403,
      body: { error: "forbidden_rank" },
    });
    expect(await answer(await revoke(bob.session, own.apiToken.id))).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await answer(await revoke(bob.session, own.apiToken.id))).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
    expect(await authenticate(h, own.token)).toEqual(fault("unauthorized"));
    expect((await h.storage.findMany("organizationToken", [])).map((r) => r.id)).toEqual([
      made.apiToken.id,
    ]);
  });

  /** An admin of one organization and a token of another (ruling 32 of plan 12k). */
  async function crossed() {
    const h = orgHandle();
    const ada = await signedIn(h, "ada@example.com");
    const bob = await signedIn(h, "bob@example.com");
    const cy = await signedIn(h, "cy@example.com");
    const a = await organization(h, ada.user, "acme", [[bob.user, "admin"]]);
    const b = await organization(h, cy.user, "beta");
    const theirs = await mint(h, cy.session, b, { permissions: { project: ["read", "write"] } });
    const before = await h.storage.findOne("organizationToken", [
      { field: "id", op: "eq", value: theirs.apiToken.id },
    ]);
    return { h, bob, a, theirs, before };
  }

  it("answers not_found to an update of a token of another organization and keeps the row", async () => {
    const { h, bob, a, theirs, before } = await crossed();
    const res = await h.auth.handle(
      post(
        "/auth/organizations/tokens/update",
        { organizationId: a, id: theirs.apiToken.id, name: "taken", permissions: {} },
        bearer(bob.session),
      ),
    );
    expect(await answer(res)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(
      await h.storage.findOne("organizationToken", [
        { field: "id", op: "eq", value: theirs.apiToken.id },
      ]),
    ).toEqual(before);
  });

  it("answers not_found to a revoke of a token of another organization and keeps the row", async () => {
    const { h, bob, a, theirs, before } = await crossed();
    const res = await h.auth.handle(
      post(
        "/auth/organizations/tokens/revoke",
        { organizationId: a, id: theirs.apiToken.id },
        bearer(bob.session),
      ),
    );
    expect(await answer(res)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(
      await h.storage.findOne("organizationToken", [
        { field: "id", op: "eq", value: theirs.apiToken.id },
      ]),
    ).toEqual(before);
    expect((await callerOf(h, theirs.token)).kind).toBe("organizationToken");
  });

  it("refuses a set wider than the creator's, a null set, and a stale session", async () => {
    const h = orgHandle();
    const ada = await signedIn(h, "ada@example.com");
    const may = await signedIn(h, "may@example.com");
    const pat = await signedIn(h, "pat@example.com");
    const org = await organization(h, ada.user, "acme", [
      [may.user, "maker"],
      [pat.user, "member"],
    ]);
    const create = async (session: string, body: Record<string, unknown>) =>
      answer(
        await h.auth.handle(
          post(
            "/auth/organizations/tokens",
            { organizationId: org, name: "ci", ...body },
            bearer(session),
          ),
        ),
      );
    // The maker holds project:read only.
    expect(await create(may.session, { permissions: { project: ["read", "write"] } })).toEqual({
      status: 403,
      body: { error: "forbidden_rank" },
    });
    for (const body of [
      { permissions: null },
      {},
      { permissions: { ghost: ["read"] } },
      { permissions: { project: ["fly"] } },
      { permissions: {}, quota: { remaining: 5 } },
      { permissions: {}, rateLimit: { seconds: 60, max: 5 } },
    ])
      expect(await create(may.session, body)).toEqual({
        status: 400,
        body: { error: "invalid_body" },
      });
    // A member holds no apiToken:create.
    expect(await create(pat.session, { permissions: {} })).toEqual({
      status: 403,
      body: { error: "forbidden_rank" },
    });
    const made = await mint(h, ada.session, org, { permissions: { project: ["read"] } });
    // The default fresh window is 1440 minutes; the session itself lasts longer.
    h.clock.advance(25 * HOUR);
    expect(await create(ada.session, { permissions: {} })).toEqual({
      status: 403,
      body: { error: "session_not_fresh" },
    });
    const stale = await h.auth.handle(
      post(
        "/auth/organizations/tokens/update",
        { organizationId: org, id: made.apiToken.id, name: "renamed" },
        bearer(ada.session),
      ),
    );
    expect(await answer(stale)).toEqual({ status: 403, body: { error: "session_not_fresh" } });
    const rows = await h.storage.findMany("organizationToken", []);
    expect(rows.map((r) => r.name)).toEqual(["ci"]);
  });

  it("accepts the empty set and grants nothing with it", async () => {
    const h = orgHandle();
    const ada = await signedIn(h, "ada@example.com");
    const org = await organization(h, ada.user, "acme");
    const made = await mint(h, ada.session, org, { permissions: {} });
    expect(made.apiToken.permissions).toEqual({});
    const caller = await callerOf(h, made.token);
    for (const permissions of [{ project: ["read"] }, { member: ["read"] }, {}])
      expect(await h.auth.hasPermission(caller, { organizationId: org, permissions })).toBe(false);
    expect(await h.auth.permissionsOf(caller, org)).toEqual({
      ok: true,
      value: { role: null, permissions: {} },
    });
  });

  it("answers organization_token_limit at 50 live rows", async () => {
    const h = orgHandle();
    const ada = await signedIn(h, "ada@example.com");
    const org = await organization(h, ada.user, "acme");
    const create = (expiresInDays: number | null = null) =>
      h.auth.api.organizationTokens.create({
        user: ada.user,
        organizationId: org,
        name: "ci",
        permissions: {},
        expiresInDays,
      });
    // The user tokens of 8b share the key of 20 creates per hour per user.
    for (let i = 0; i < 19; i++) mustOk(await create());
    mustOk(await h.auth.api.tokens.create({ user: ada.user, name: "mine" }));
    expect(await create()).toEqual(fault("rate_limited"));
    h.clock.advance(HOUR);
    mustOk(await create(1));
    for (let i = 0; i < 19; i++) mustOk(await create());
    h.clock.advance(HOUR);
    for (let i = 0; i < 11; i++) mustOk(await create());
    expect(await h.storage.findMany("organizationToken", [])).toHaveLength(50);
    expect(await create()).toEqual(fault("organization_token_limit"));
    // The user token does not count against the cap of the organization.
    mustOk(await h.auth.api.tokens.create({ user: ada.user, name: "mine2" }));
    // An expired row goes first, so it does not count.
    h.clock.advance(DAY);
    mustOk(await create());
    expect(await h.storage.findMany("organizationToken", [])).toHaveLength(50);
    expect(await create()).toEqual(fault("organization_token_limit"));
    // The cap is per organization.
    const other = await organization(h, ada.user, "other");
    mustOk(
      await h.auth.api.organizationTokens.create({
        user: ada.user,
        organizationId: other,
        name: "ci",
        permissions: {},
      }),
    );
  });

  it("keeps the token when its creator deletes the account, and marks the creator gone", async () => {
    const h = orgHandle();
    const ada = await signedIn(h, "ada@example.com");
    const bob = await signedIn(h, "bob@example.com");
    const org = await organization(h, ada.user, "acme", [[bob.user, "admin"]]);
    const made = await mint(h, bob.session, org, { permissions: { project: ["read"] } });
    const resolved = await h.auth.api.getSession(bob.session);
    if (!resolved) throw new Error("no session");
    expect(await h.auth.api.user.delete({ session: resolved, ip: null, userAgent: null })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(
      await h.storage.findOne("user", [{ field: "id", op: "eq", value: bob.user.id }]),
    ).toBeNull();
    const caller = await callerOf(h, made.token);
    expect(caller).toMatchObject({
      kind: "organizationToken",
      apiToken: { id: made.apiToken.id, createdById: bob.user.id, creatorIsMember: false },
    });
    const listed = await answer(await list(h, ada.session, org));
    expect(listed.body.tokens).toEqual([
      expect.objectContaining({
        id: made.apiToken.id,
        createdById: bob.user.id,
        creatorIsMember: false,
      }),
    ]);
  });

  it("revokes the creator's tokens with revokeTokens and refuses it without apiToken:revoke or with a stale session", async () => {
    const h = orgHandle();
    const ada = await signedIn(h, "ada@example.com");
    const bob = await signedIn(h, "bob@example.com");
    const may = await signedIn(h, "may@example.com");
    const rex = await signedIn(h, "rex@example.com");
    const org = await organization(h, ada.user, "acme", [
      [bob.user, "admin"],
      [may.user, "maker"],
      [rex.user, "remover"],
    ]);
    const other = await organization(h, ada.user, "other", [[may.user, "maker"]]);
    const mine1 = await mint(h, may.session, org, { permissions: {} });
    const mine2 = await mint(h, may.session, org, { permissions: { project: ["read"] } });
    const elsewhere = await mint(h, may.session, other, { permissions: {} });
    const bobs = await mint(h, bob.session, org, { permissions: {} });
    const remove = (session: string, userId: string, revokeTokens?: boolean) =>
      h.auth.handle(
        post(
          "/auth/organizations/members/remove",
          { organizationId: org, userId, ...(revokeTokens === undefined ? {} : { revokeTokens }) },
          bearer(session),
        ),
      );
    const ids = async () =>
      (await h.storage.findMany("organizationToken", [])).map((r) => r.id).sort();
    const all = [mine1, mine2, elsewhere, bobs].map((m) => m.apiToken.id).sort();
    const isMember = async (userId: string) =>
      (await h.storage.findOne("member", [
        { field: "organizationId", op: "eq", value: org },
        { field: "userId", op: "eq", value: userId },
      ])) !== null;

    // The remover may remove the maker, but holds no apiToken:revoke.
    expect(await answer(await remove(rex.session, may.user.id, true))).toEqual({
      status: 403,
      body: { error: "forbidden_rank" },
    });
    // A leave with revokeTokens follows the same rule: the creator has no right of their own.
    expect(await answer(await remove(may.session, may.user.id, true))).toEqual({
      status: 403,
      body: { error: "forbidden_rank" },
    });
    expect(await isMember(may.user.id)).toBe(true);
    expect(await ids()).toEqual(all);

    // A stale session: the fresh rule runs before any write.
    h.clock.advance(25 * HOUR);
    expect(await answer(await remove(ada.session, may.user.id, true))).toEqual({
      status: 403,
      body: { error: "session_not_fresh" },
    });
    expect(await isMember(may.user.id)).toBe(true);
    expect(await ids()).toEqual(all);

    // A removal without revokeTokens keeps the tokens, on a stale session too.
    expect(await answer(await remove(ada.session, bob.user.id))).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await ids()).toEqual(all);

    const fresh = await signInAgain(h, ada.user);
    const nowhere = await h.auth.handle(
      post(
        "/auth/organizations/members/remove",
        { organizationId: "o-none", userId: may.user.id, revokeTokens: true },
        bearer(fresh),
      ),
    );
    expect(await answer(nowhere)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await answer(await remove(fresh, may.user.id, true))).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await isMember(may.user.id)).toBe(false);
    // The tokens of the person in this organization go; another organization keeps its token.
    expect(await ids()).toEqual([elsewhere.apiToken.id, bobs.apiToken.id].sort());
    expect(await authenticate(h, mine1.token)).toEqual(fault("unauthorized"));
  });

  it("deletes the tokens with the organization", async () => {
    const h = orgHandle();
    const ada = await signedIn(h, "ada@example.com");
    const org = await organization(h, ada.user, "acme");
    const other = await organization(h, ada.user, "other");
    const gone = await mint(h, ada.session, org, { permissions: {} });
    const kept = await mint(h, ada.session, other, { permissions: {} });
    mustOk(await h.auth.api.deleteOrganization({ user: ada.user, organizationId: org }));
    expect((await h.storage.findMany("organizationToken", [])).map((r) => r.id)).toEqual([
      kept.apiToken.id,
    ]);
    expect(await authenticate(h, gone.token)).toEqual(fault("unauthorized"));
    expect((await callerOf(h, kept.token)).kind).toBe("organizationToken");
  });

  it("refuses every core route to an organization token", async () => {
    const h = orgHandle();
    const ada = await signedIn(h, "ada@example.com");
    const pat = await signedIn(h, "pat@example.com");
    const org = await organization(h, ada.user, "acme");
    const made = mustOk(
      await h.auth.api.organizationTokens.create({
        user: ada.user,
        organizationId: org,
        name: "ci",
        permissions: { member: ["create"], apiToken: ALL_TOKEN },
        quota: { remaining: 5 },
      }),
    );
    const as = bearer(made.token);
    const refused = [
      post(
        "/auth/organizations/members/add",
        { organizationId: org, userId: pat.user.id, role: "member" },
        as,
      ),
      post("/auth/tokens", { name: "x" }, as),
      get("/auth/tokens/current", as),
      post("/auth/organizations/tokens", { organizationId: org, name: "x", permissions: {} }, as),
      get(`/auth/organizations/tokens?organizationId=${org}`, as),
      post("/auth/organizations/tokens/revoke", { organizationId: org, id: made.apiToken.id }, as),
    ];
    for (const request of refused)
      expect(await answer(await h.auth.handle(request)), request.url).toEqual({
        status: 401,
        body: { error: "unauthorized" },
      });
    expect(await h.storage.findMany("member", [])).toHaveLength(1);
    // No refused route read the token, so no call of its quota went.
    const [row] = await h.storage.findMany("organizationToken", []);
    expect(row?.remaining).toBe(5);
  });

  it("answers hasPermission from the token's own set and false in another organization", async () => {
    const h = orgHandle();
    const ada = await signedIn(h, "ada@example.com");
    const bob = await signedIn(h, "bob@example.com");
    const org = await organization(h, ada.user, "acme", [[bob.user, "admin"]]);
    const other = await organization(h, ada.user, "other", [[bob.user, "admin"]]);
    // The creator holds project:write and member:create; the token holds project:read only.
    const made = await mint(h, bob.session, org, { permissions: { project: ["read"] } });
    const caller = await callerOf(h, made.token);
    const has = (organizationId: string, permissions: Record<string, string[]>) =>
      h.auth.hasPermission(caller, { organizationId, permissions });
    expect(await has(org, { project: ["read"] })).toBe(true);
    expect(await has(org, { project: ["write"] })).toBe(false);
    expect(await has(org, { member: ["create"] })).toBe(false);
    expect(await has(other, { project: ["read"] })).toBe(false);
    expect(await h.auth.permissionsOf(caller, org)).toEqual({
      ok: true,
      value: { role: null, permissions: { project: ["read"] } },
    });
    expect(await h.auth.permissionsOf(caller, other)).toEqual({
      ok: true,
      value: { role: null, permissions: {} },
    });
    // A demotion of the creator does not change the set; a revoke ends it at the next check.
    mustOk(
      await h.auth.api.updateMemberRole({
        user: ada.user,
        organizationId: org,
        userId: bob.user.id,
        role: "member",
      }),
    );
    expect(await has(org, { project: ["read"] })).toBe(true);
    mustOk(
      await h.auth.api.organizationTokens.revoke({
        user: ada.user,
        organizationId: org,
        id: made.apiToken.id,
      }),
    );
    expect(await has(org, { project: ["read"] })).toBe(false);
  });

  it("keys the window as token-use:to:<id> and spends the quota", async () => {
    const h = orgHandle();
    const ada = await signedIn(h, "ada@example.com");
    const org = await organization(h, ada.user, "acme");
    const made = mustOk(
      await h.auth.api.organizationTokens.create({
        user: ada.user,
        organizationId: org,
        name: "ci",
        permissions: {},
        rateLimit: { seconds: 60, max: 2 },
        quota: { remaining: 3 },
      }),
    );
    expect(made.apiToken).toMatchObject({ rateLimit: { seconds: 60, max: 2 }, remaining: 3 });
    const allow = vi.spyOn(h.config.limiter, "allow");
    const current = () =>
      h.auth.handle(get("/auth/organizations/tokens/current", bearer(made.token)));
    const first = await answer(await current());
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ organization: { id: org }, apiToken: { remaining: 2 } });
    expect(allow).toHaveBeenLastCalledWith(`token-use:to:${made.apiToken.id}`, {
      seconds: 60,
      max: 2,
    });
    expect((await callerOf(h, made.token)) as unknown).toMatchObject({
      apiToken: { remaining: 1 },
    });
    // Over the window: 429, and the quota spends nothing.
    expect(await answer(await current())).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(await authenticate(h, made.token)).toEqual(fault("rate_limited"));
    const read = async () =>
      (
        await h.storage.findOne("organizationToken", [
          { field: "id", op: "eq", value: made.apiToken.id },
        ])
      )?.remaining;
    expect(await read()).toBe(1);
    h.clock.advance(61_000);
    expect((await callerOf(h, made.token)) as unknown).toMatchObject({
      apiToken: { remaining: 0 },
    });
    expect(await answer(await current())).toEqual({
      status: 429,
      body: { error: "token_exhausted" },
    });
    expect(await read()).toBe(0);
    expect(
      await h.auth.caller(new Request(`${BASE_URL}/app`, { headers: bearer(made.token) })),
    ).toBeNull();
  });

  it("answers /organizations/tokens/current for a to_ bearer only", async () => {
    const h = orgHandle();
    const ada = await signedIn(h, "ada@example.com");
    const org = await organization(h, ada.user, "acme");
    const made = await mint(h, ada.session, org, {
      permissions: { project: ["read"] },
      expiresInDays: null,
    });
    const user = mustOk(
      await h.auth.api.tokens.create({ user: ada.user, name: "mine", quota: { remaining: 5 } }),
    );
    const current = (headers: Record<string, string>) =>
      h.auth.handle(get("/auth/organizations/tokens/current", headers));
    const ok = await answer(await current(bearer(made.token)));
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body).sort()).toEqual(["apiToken", "organization"]);
    expect(ok.body).toMatchObject({
      organization: { id: org, slug: "acme" },
      apiToken: {
        id: made.apiToken.id,
        permissions: { project: ["read"] },
        creatorIsMember: true,
        expiresAt: null,
        lastUsedAt: h.clock.now().toISOString(),
      },
    });
    // lastUsedAt moves at most once per hour (plan 8b).
    const stamped = async () =>
      (
        await h.storage.findOne("organizationToken", [
          { field: "id", op: "eq", value: made.apiToken.id },
        ])
      )?.lastUsedAt;
    const first = h.clock.now();
    h.clock.advance(HOUR - 1);
    expect((await current(bearer(made.token))).status).toBe(200);
    expect(await stamped()).toEqual(first);
    h.clock.advance(1);
    expect((await current(bearer(made.token))).status).toBe(200);
    expect(await stamped()).toEqual(h.clock.now());
    for (const headers of [
      bearer(user.token),
      bearer(ada.session),
      { cookie: `${h.config.cookieName}=${ada.session}` },
      {},
    ])
      expect(await answer(await current(headers))).toEqual({
        status: 401,
        body: { error: "unauthorized" },
      });
    // The user token route refuses an organization token.
    expect(
      await answer(await h.auth.handle(get("/auth/tokens/current", bearer(made.token)))),
    ).toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
    // No refused route read the user token, so its quota is whole.
    const [row] = await h.storage.findMany("apiToken", []);
    expect(row?.remaining).toBe(5);
    expect(
      mustOk(await h.auth.api.organizationTokens.current({ token: made.token })).apiToken.id,
    ).toBe(made.apiToken.id);
    expect(await h.auth.api.organizationTokens.current({ token: user.token })).toEqual(
      fault("unauthorized"),
    );
  });

  it("answers conflict when a resolve writes the row between the update read and its write", async () => {
    const h = orgHandle();
    const ada = await signedIn(h, "ada@example.com");
    const org = await organization(h, ada.user, "acme");
    const made = await mint(h, ada.session, org, { permissions: { project: ["read", "write"] } });
    h.clock.advance(1_000);
    // The token's first use stamps lastUsedAt and updatedAt after the update read the row.
    h.race.afterRead = () => authenticate(h, made.token);
    const narrow = () =>
      h.auth.handle(
        post(
          "/auth/organizations/tokens/update",
          { organizationId: org, id: made.apiToken.id, permissions: { project: ["read"] } },
          bearer(ada.session),
        ),
      );
    expect(await answer(await narrow())).toEqual({ status: 409, body: { error: "conflict" } });
    const [row] = await h.storage.findMany("organizationToken", []);
    expect(row).toMatchObject({
      permissions: { project: ["read", "write"] },
      lastUsedAt: h.clock.now(),
    });
    // A try with the row of now goes through.
    expect((await narrow()).status).toBe(200);
  });

  it("answers conflict after 20 lost spends, and spends nothing for it", async () => {
    const h = orgHandle();
    const ada = await signedIn(h, "ada@example.com");
    const org = await organization(h, ada.user, "acme");
    const { token } = mustOk(
      await h.auth.api.organizationTokens.create({
        user: ada.user,
        organizationId: org,
        name: "ci",
        permissions: {},
        quota: { remaining: 100 },
      }),
    );
    // Before each spend of this instance, another instance on the same storage spends first.
    const rival = instance(h, h.storage);
    let rivals = 0;
    const loser = instance(h, {
      ...h.storage,
      async update(model, where, data) {
        if (model === "organizationToken" && "remaining" in data) {
          rivals++;
          expect((await authenticateOn(rival, token)).ok).toBe(true);
        }
        return h.storage.update(model, where, data);
      },
    });
    const res = await loser.handle(get("/auth/organizations/tokens/current", bearer(token)));
    expect(await answer(res)).toEqual({ status: 409, body: { error: "conflict" } });
    // Each lost try saw a new count, so the spend tried 20 times (ruling 30 of plan 12k).
    expect(rivals).toBe(20);
    const [row] = await h.storage.findMany("organizationToken", []);
    expect(row?.remaining).toBe(80);
  });

  it("sweeps expired organization tokens and counts them", async () => {
    const h = orgHandle();
    const ada = await signedIn(h, "ada@example.com");
    const org = await organization(h, ada.user, "acme");
    const create = (expiresInDays: number | null) =>
      h.auth.api.organizationTokens.create({
        user: ada.user,
        organizationId: org,
        name: "ci",
        permissions: {},
        expiresInDays,
      });
    const short = mustOk(await create(1));
    mustOk(await create(2));
    const forever = mustOk(await create(null));
    h.clock.advance(DAY);
    // At exactly expiresAt the resolve refuses the row and deletes it.
    expect(await authenticate(h, short.token)).toEqual(fault("unauthorized"));
    expect(await h.storage.findMany("organizationToken", [])).toHaveLength(2);
    h.clock.advance(DAY + 1);
    const swept = await h.auth.api.sweepExpired();
    expect(swept.organizationTokens).toBe(1);
    expect((await h.storage.findMany("organizationToken", [])).map((r) => r.id)).toEqual([
      forever.apiToken.id,
    ]);
    expect((await h.auth.api.sweepExpired()).organizationTokens).toBe(0);
  });
});
