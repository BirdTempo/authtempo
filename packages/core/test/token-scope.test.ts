import { describe, expect, it } from "vitest";
import { createAuth } from "../src/create-auth.js";
import { createSession } from "../src/engine/sessions.js";
import type { Caller } from "../src/engine/tokens.js";
import { newId } from "../src/primitives/ids.js";
import type { UserRow } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post } from "./helpers.js";

// Plan 12k Task 7: the permissions of a user token, and the narrow-only update (spec 29 items 10 and 11).

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * One storage, clock, and limiter for the engine and the routes, with
 * organizations on. `writes` logs each update as its model and its keys.
 * `race.afterRead` runs once after the next apiToken read, before the caller goes on.
 */
function scopeHandle(organizations = true) {
  const base = makeAuth(organizations ? { organizations: {} } : {});
  const writes: string[] = [];
  const race: { afterRead: (() => Promise<unknown>) | null } = { afterRead: null };
  const storage: StorageAdapter = {
    ...base.storage,
    async findOne(model, where) {
      const row = await base.storage.findOne(model, where);
      const run = race.afterRead;
      if (model === "apiToken" && run) {
        race.afterRead = null;
        await run();
      }
      return row;
    },
    update(model, where, data) {
      writes.push(`${model} ${Object.keys(data).sort().join(",")}`);
      return base.storage.update(model, where, data);
    },
  };
  const auth = createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage,
    mail: { send: async () => {} },
    clock: base.clock,
    limiter: base.config.limiter,
    ...(organizations ? { organizations: {} } : {}),
  });
  return { ...base, auth, writes, race };
}
type Handle = ReturnType<typeof scopeHandle>;

/** A verified user and a fresh `ts_` session token. */
async function signedIn(h: Handle, email: string) {
  const now = h.clock.now();
  const user = await h.storage.create("user", {
    id: newId(now),
    email,
    emailVerified: true,
    name: null,
    image: null,
    bannedAt: null,
    banReason: null,
    banUntil: null,
    createdAt: now,
    updatedAt: now,
  });
  const { token } = await createSession(h.config, { userId: user.id, ip: null, userAgent: null });
  return { user, session: token };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function mustOk<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

/** An organization of `owner` with `admin` at the admin role and `plain` at the member role. */
async function organization(h: Handle, owner: UserRow, admin: UserRow, plain: UserRow) {
  const org = mustOk(
    await h.auth.api.createOrganization({ user: owner, slug: "acme", name: "Acme" }),
  );
  const organizationId = org.organization.id;
  mustOk(
    await h.auth.api.addMember({ user: owner, organizationId, userId: admin.id, role: "admin" }),
  );
  mustOk(
    await h.auth.api.addMember({ user: owner, organizationId, userId: plain.id, role: "member" }),
  );
  return organizationId;
}

async function callerOf(h: Handle, token: string): Promise<Caller> {
  const caller = await h.auth.caller(new Request(`${BASE_URL}/app`, { headers: bearer(token) }));
  if (!caller) throw new Error("no caller");
  return caller;
}

async function answer(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A token of `session` through POST /tokens with `body`. */
async function mint(h: Handle, session: string, body: Record<string, unknown>) {
  const res = await h.auth.handle(post("/auth/tokens", { name: "ci", ...body }, bearer(session)));
  if (res.status !== 200) throw new Error(`create answered ${res.status}`);
  return (await res.json()) as {
    token: string;
    apiToken: { id: string; permissions: unknown; expiresAt: string | null };
  };
}

function update(h: Handle, session: string, body: Record<string, unknown>) {
  return h.auth.handle(post("/auth/tokens/update", body, bearer(session)));
}

describe("token permissions (plan 12k Task 7)", () => {
  it("creates a token with a narrower set and refuses an unknown name", async () => {
    const h = scopeHandle();
    const ada = await signedIn(h, "ada@example.com");
    const made = await mint(h, ada.session, { permissions: { member: ["read"] } });
    expect(made.apiToken.permissions).toEqual({ member: ["read"] });
    const [row] = await h.storage.findMany("apiToken", []);
    expect(row?.permissions).toEqual({ member: ["read"] });
    for (const permissions of [
      { member: ["fly"] },
      { ghost: ["read"] },
      { member: [] },
      { member: ["read", "read"] },
    ]) {
      const res = await h.auth.handle(
        post("/auth/tokens", { name: "bad", permissions }, bearer(ada.session)),
      );
      expect(await answer(res)).toEqual({ status: 400, body: { error: "invalid_body" } });
    }
    expect(await h.storage.findMany("apiToken", [])).toHaveLength(1);
    // With organizations off, a set has no known name: the create answers invalid_body.
    const off = scopeHandle(false);
    const bob = await off.seedUser("bob@example.com");
    expect(
      await off.auth.api.tokens.create({ user: bob, name: "x", permissions: { member: ["read"] } }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
    expect(await off.storage.findMany("apiToken", [])).toEqual([]);
  });

  it("refuses a set wider than the creator's effective set in the bound organization", async () => {
    const h = scopeHandle();
    const owner = await signedIn(h, "owner@example.com");
    const admin = await signedIn(h, "admin@example.com");
    const plain = await signedIn(h, "plain@example.com");
    const organizationId = await organization(h, owner.user, admin.user, plain.user);
    const wide = await h.auth.handle(
      post(
        "/auth/tokens",
        { name: "wide", organizationId, permissions: { member: ["read", "create"] } },
        bearer(plain.session),
      ),
    );
    expect(await answer(wide)).toEqual({ status: 403, body: { error: "forbidden_rank" } });
    expect(await h.storage.findMany("apiToken", [])).toEqual([]);
    const narrow = await mint(h, plain.session, {
      organizationId,
      permissions: { member: ["read"] },
    });
    expect(narrow.apiToken.permissions).toEqual({ member: ["read"] });
    // The admin holds member:create in the organization, so the same set passes for the admin.
    const admins = await mint(h, admin.session, {
      organizationId,
      permissions: { member: ["read", "create"] },
    });
    expect(admins.apiToken.permissions).toEqual({ member: ["read", "create"] });
  });

  it("narrows at the next request after a demotion", async () => {
    const h = scopeHandle();
    const owner = await signedIn(h, "owner@example.com");
    const admin = await signedIn(h, "admin@example.com");
    const plain = await signedIn(h, "plain@example.com");
    const organizationId = await organization(h, owner.user, admin.user, plain.user);
    const { token } = mustOk(
      await h.auth.api.tokens.create({ user: admin.user, name: "ci", organizationId }),
    );
    const wanted = { organizationId, permissions: { member: ["create"] } };
    expect(await h.auth.hasPermission(await callerOf(h, token), wanted)).toBe(true);
    mustOk(
      await h.auth.api.updateMemberRole({
        user: owner.user,
        organizationId,
        userId: admin.user.id,
        role: "member",
      }),
    );
    expect(await h.auth.hasPermission(await callerOf(h, token), wanted)).toBe(false);
  });

  it("answers hasPermission for a user token bound to O with a narrower set", async () => {
    const h = scopeHandle();
    const owner = await signedIn(h, "owner@example.com");
    const admin = await signedIn(h, "admin@example.com");
    const plain = await signedIn(h, "plain@example.com");
    const organizationId = await organization(h, owner.user, admin.user, plain.user);
    const { token } = mustOk(
      await h.auth.api.tokens.create({
        user: admin.user,
        name: "reader",
        organizationId,
        permissions: { member: ["read"] },
      }),
    );
    const caller = await callerOf(h, token);
    // The admin's role holds member:create; the token's set does not, so the token may not.
    const read = { organizationId, permissions: { member: ["read"] } };
    const create = { organizationId, permissions: { member: ["create"] } };
    expect(await h.auth.hasPermission(caller, read)).toBe(true);
    expect(await h.auth.hasPermission(caller, create)).toBe(false);
    expect(mustOk(await h.auth.permissionsOf(caller, organizationId))).toEqual({
      role: "admin",
      permissions: { member: ["read"] },
    });
  });

  it("refuses a wider set", async () => {
    const h = scopeHandle();
    const ada = await signedIn(h, "ada@example.com");
    const made = await mint(h, ada.session, { permissions: { member: ["read"] } });
    const res = await update(h, ada.session, {
      id: made.apiToken.id,
      permissions: { member: ["read", "create"] },
    });
    expect(await answer(res)).toEqual({ status: 400, body: { error: "invalid_body" } });
    const [row] = await h.storage.findMany("apiToken", []);
    expect(row?.permissions).toEqual({ member: ["read"] });
  });

  it("refuses null over a set", async () => {
    const h = scopeHandle();
    const ada = await signedIn(h, "ada@example.com");
    const made = await mint(h, ada.session, { permissions: { member: ["read"] } });
    const res = await update(h, ada.session, { id: made.apiToken.id, permissions: null });
    expect(await answer(res)).toEqual({ status: 400, body: { error: "invalid_body" } });
    const [row] = await h.storage.findMany("apiToken", []);
    expect(row?.permissions).toEqual({ member: ["read"] });
  });

  it("refuses a later expiry", async () => {
    const h = scopeHandle();
    const ada = await signedIn(h, "ada@example.com");
    const made = await mint(h, ada.session, { expiresInDays: 10 });
    const later = new Date(h.clock.now().getTime() + 20 * DAY).toISOString();
    for (const expiresAt of [later, null]) {
      const res = await update(h, ada.session, { id: made.apiToken.id, expiresAt });
      expect(await answer(res)).toEqual({ status: 400, body: { error: "invalid_body" } });
    }
    const [row] = await h.storage.findMany("apiToken", []);
    expect(row?.expiresAt).toEqual(new Date(h.clock.now().getTime() + 10 * DAY));
  });

  it("accepts a narrower set, a set over null, and an earlier expiry", async () => {
    const h = scopeHandle();
    const ada = await signedIn(h, "ada@example.com");
    const made = await mint(h, ada.session, { expiresInDays: null });
    expect(made.apiToken.permissions).toBeNull();
    const id = made.apiToken.id;
    const first = await update(h, ada.session, {
      id,
      permissions: { member: ["read", "create"] },
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { permissions: unknown }).permissions).toEqual({
      member: ["read", "create"],
    });
    const second = await update(h, ada.session, { id, permissions: { member: ["read"] } });
    expect(((await second.json()) as { permissions: unknown }).permissions).toEqual({
      member: ["read"],
    });
    // A token with no expiry may get one, and then an earlier one.
    const in5 = new Date(h.clock.now().getTime() + 5 * DAY);
    const dated = await update(h, ada.session, { id, expiresAt: in5.toISOString(), name: "cd" });
    expect(await answer(dated)).toMatchObject({
      status: 200,
      body: { id, name: "cd", expiresAt: in5.toISOString(), permissions: { member: ["read"] } },
    });
    const in2 = new Date(h.clock.now().getTime() + 2 * DAY);
    const earlier = await update(h, ada.session, { id, expiresAt: in2.toISOString() });
    expect(await answer(earlier)).toMatchObject({
      status: 200,
      body: { expiresAt: in2.toISOString() },
    });
    const [row] = await h.storage.findMany("apiToken", []);
    expect(row).toMatchObject({ name: "cd", expiresAt: in2, permissions: { member: ["read"] } });
  });

  it("answers conflict when a resolve writes the row between the read and the write", async () => {
    const h = scopeHandle();
    const ada = await signedIn(h, "ada@example.com");
    const made = await mint(h, ada.session, { permissions: { member: ["read", "create"] } });
    h.clock.advance(1_000);
    // The token's first use stamps lastUsedAt and updatedAt after the update read the row.
    h.race.afterRead = () =>
      h.auth.authenticate(new Request(`${BASE_URL}/app`, { headers: bearer(made.token) }));
    const res = await update(h, ada.session, {
      id: made.apiToken.id,
      permissions: { member: ["read"] },
    });
    expect(await answer(res)).toEqual({ status: 409, body: { error: "conflict" } });
    const [row] = await h.storage.findMany("apiToken", []);
    expect(row).toMatchObject({
      permissions: { member: ["read", "create"] },
      lastUsedAt: h.clock.now(),
    });
    // A try with the row of now goes through.
    const again = await update(h, ada.session, {
      id: made.apiToken.id,
      permissions: { member: ["read"] },
    });
    expect(again.status).toBe(200);
  });

  it("needs a fresh session for the create and the update", async () => {
    const h = scopeHandle();
    const ada = await signedIn(h, "ada@example.com");
    const made = await mint(h, ada.session, {});
    // The default fresh window is 1440 minutes; the session itself lasts longer.
    h.clock.advance(25 * HOUR);
    const create = await h.auth.handle(post("/auth/tokens", { name: "x" }, bearer(ada.session)));
    expect(await answer(create)).toEqual({ status: 403, body: { error: "session_not_fresh" } });
    const res = await update(h, ada.session, { id: made.apiToken.id, name: "renamed" });
    expect(await answer(res)).toEqual({ status: 403, body: { error: "session_not_fresh" } });
    const rows = await h.storage.findMany("apiToken", []);
    expect(rows.map((r) => r.name)).toEqual(["ci"]);
  });

  it("takes no window and no quota from a client", async () => {
    const h = scopeHandle();
    const ada = await signedIn(h, "ada@example.com");
    const made = await mint(h, ada.session, {
      rateLimit: { seconds: 60, max: 1000 },
      quota: { remaining: 1000 },
    });
    // The create body has no such keys, so the token has no window and no quota.
    expect(made.apiToken).toMatchObject({ rateLimit: null, remaining: null });
    for (const extra of [
      { rateLimitMax: 1000 },
      { rateLimit: { seconds: 60, max: 1000 } },
      { quota: { remaining: 1000 } },
      { remaining: 1000 },
    ]) {
      const res = await update(h, ada.session, { id: made.apiToken.id, ...extra });
      expect(await answer(res)).toEqual({ status: 400, body: { error: "invalid_body" } });
    }
    const [row] = await h.storage.findMany("apiToken", []);
    expect(row).toMatchObject({ rateLimitSeconds: null, rateLimitMax: null, remaining: null });
  });

  it("keeps every plan 8b answer for a token with no new field", async () => {
    const h = scopeHandle();
    const ada = await signedIn(h, "ada@example.com");
    const made = await mint(h, ada.session, {});
    // The five new fields in their default form, and no other change.
    expect(made.apiToken).toEqual({
      id: expect.any(String),
      name: "ci",
      hint: made.token.slice(3, 11),
      expiresAt: new Date(h.clock.now().getTime() + 90 * DAY).toISOString(),
      lastUsedAt: null,
      organizationId: null,
      permissions: null,
      metadata: null,
      rateLimit: null,
      remaining: null,
      retired: false,
      createdAt: h.clock.now().toISOString(),
    });
    // A resolve writes lastUsedAt and nothing else, as in plan 8b.
    h.writes.length = 0;
    const current = await h.auth.handle(get("/auth/tokens/current", bearer(made.token)));
    expect(current.status).toBe(200);
    expect(h.writes).toEqual(["apiToken lastUsedAt,updatedAt"]);
    const list = await h.auth.handle(get("/auth/tokens", bearer(ada.session)));
    expect(((await list.json()) as { tokens: unknown[] }).tokens).toHaveLength(1);
  });

  it("refuses metadata over 4096 bytes and stores the rest as given", async () => {
    const h = scopeHandle();
    const ada = await signedIn(h, "ada@example.com");
    const big = { note: "x".repeat(4096) };
    const res = await h.auth.handle(
      post("/auth/tokens", { name: "big", metadata: big }, bearer(ada.session)),
    );
    expect(await answer(res)).toEqual({ status: 400, body: { error: "invalid_body" } });
    // 4096 bytes as JSON: {"note":"..."} is 11 bytes around the text.
    const fits = { note: "é".repeat(2042) };
    expect(new TextEncoder().encode(JSON.stringify(fits)).length).toBe(4095);
    const made = await mint(h, ada.session, { metadata: fits });
    expect((made.apiToken as unknown as { metadata: unknown }).metadata).toEqual(fits);
    const [row] = await h.storage.findMany("apiToken", []);
    expect(row?.metadata).toEqual(fits);
  });

  it("takes metadata of 4096 bytes and refuses 4097 bytes", async () => {
    const h = scopeHandle();
    const ada = await signedIn(h, "ada@example.com");
    const edge = { note: "x".repeat(4085) };
    const over = { note: "x".repeat(4086) };
    expect(new TextEncoder().encode(JSON.stringify(edge)).length).toBe(4096);
    expect(new TextEncoder().encode(JSON.stringify(over)).length).toBe(4097);
    const res = await h.auth.handle(
      post("/auth/tokens", { name: "over", metadata: over }, bearer(ada.session)),
    );
    expect(await answer(res)).toEqual({ status: 400, body: { error: "invalid_body" } });
    const made = await mint(h, ada.session, { metadata: edge });
    expect((made.apiToken as unknown as { metadata: unknown }).metadata).toEqual(edge);
    const rows = await h.storage.findMany("apiToken", []);
    expect(rows.map((r) => r.metadata)).toEqual([edge]);
  });
});
