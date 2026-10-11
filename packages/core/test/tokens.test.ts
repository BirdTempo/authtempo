import { describe, expect, it } from "vitest";
import { createAuth } from "../src/create-auth.js";
import { addMember, createOrganization, removeMember } from "../src/engine/organizations.js";
import { createSession } from "../src/engine/sessions.js";
import {
  API_TOKEN_CAP,
  callerFromRequest,
  createApiToken,
  listApiTokens,
  resolveApiToken,
  revokeApiToken,
} from "../src/engine/tokens.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { newId } from "../src/primitives/ids.js";
import { APP_ORIGIN, BASE_URL, makeAuth } from "./helpers.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** A user with a session and an unverified address: a password sign-up whose link was not used. */
async function unverifiedUser(auth: ReturnType<typeof makeAuth>) {
  const now = auth.clock.now();
  return auth.storage.create("user", {
    id: newId(now),
    email: "new@example.com",
    emailVerified: false,
    name: null,
    image: null,
    createdAt: now,
    updatedAt: now,
  });
}

function create(
  auth: ReturnType<typeof makeAuth>,
  user: Awaited<ReturnType<ReturnType<typeof makeAuth>["seedUser"]>>,
  over: { name?: string; expiresInDays?: number | null; organizationId?: string } = {},
) {
  return createApiToken(auth.config, { user, name: over.name ?? "ci", ...over });
}

function request(headers: Record<string, string>): Request {
  return new Request(`${BASE_URL}/x`, { headers });
}

describe("createApiToken", () => {
  it("answers the clear token once and stores only its hash", async () => {
    const auth = makeAuth();
    const ada = await auth.seedUser("ada@example.com");
    const r = await create(auth, ada, { name: "deploy script" });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.token).toMatch(/^tk_[A-Za-z0-9_-]{43}$/);
    const now = auth.clock.now();
    expect(r.value.apiToken).toEqual({
      id: expect.any(String),
      name: "deploy script",
      hint: r.value.token.slice(3, 11),
      expiresAt: new Date(now.getTime() + 90 * DAY),
      lastUsedAt: null,
      organizationId: null,
      createdAt: now,
    });
    const [row] = await auth.storage.findMany("apiToken", []);
    expect(row?.tokenHash).toBe(await sha256Hex(r.value.token));
    expect(JSON.stringify(row)).not.toContain(r.value.token);
  });

  it("refuses an unverified user with email_unverified", async () => {
    const auth = makeAuth();
    const user = await unverifiedUser(auth);
    expect(await create(auth, user)).toMatchObject({ ok: false, code: "email_unverified" });
    expect(await auth.storage.findMany("apiToken", [])).toEqual([]);
  });

  it("takes a name of 1 to 80 characters with no control character, untrimmed", async () => {
    const auth = makeAuth();
    const ada = await auth.seedUser("ada@example.com");
    for (const name of ["", "x".repeat(81), "a\nb", "tab\there"])
      expect(await create(auth, ada, { name })).toMatchObject({ ok: false, code: "invalid_body" });
    const kept = await create(auth, ada, { name: ` ${"x".repeat(78)} ` });
    expect(kept.ok && kept.value.apiToken.name).toBe(` ${"x".repeat(78)} `);
  });

  it("takes expiresInDays from 1 to 3650, defaults to 90, and stores null for no expiry", async () => {
    const auth = makeAuth();
    const ada = await auth.seedUser("ada@example.com");
    for (const expiresInDays of [0, 3651, 1.5, -1, Number.NaN])
      expect(await create(auth, ada, { expiresInDays })).toMatchObject({ code: "invalid_body" });
    const now = auth.clock.now().getTime();
    const one = await create(auth, ada, { expiresInDays: 1 });
    expect(one.ok && one.value.apiToken.expiresAt?.getTime()).toBe(now + DAY);
    const most = await create(auth, ada, { expiresInDays: 3650 });
    expect(most.ok && most.value.apiToken.expiresAt?.getTime()).toBe(now + 3650 * DAY);
    const never = await create(auth, ada, { expiresInDays: null });
    expect(never.ok && never.value.apiToken.expiresAt).toBeNull();
  });

  it("limits each user to 20 creates per hour", async () => {
    const auth = makeAuth();
    const ada = await auth.seedUser("ada@example.com");
    const bob = await auth.seedUser("bob@example.com");
    for (let i = 0; i < 20; i++) expect((await create(auth, ada)).ok).toBe(true);
    expect(await create(auth, ada)).toMatchObject({ ok: false, code: "rate_limited" });
    // The key is per user.
    expect((await create(auth, bob)).ok).toBe(true);
    auth.clock.advance(HOUR);
    expect((await create(auth, ada)).ok).toBe(true);
  });

  it("answers token_limit at 50 tokens, and an expired token does not count", async () => {
    const auth = makeAuth();
    const ada = await auth.seedUser("ada@example.com");
    // Reachable over three hours: the limit allows 20 per hour.
    for (let i = 0; i < API_TOKEN_CAP; i++) {
      if (i > 0 && i % 20 === 0) auth.clock.advance(HOUR);
      const r = await create(auth, ada, { expiresInDays: i === 0 ? 1 : 90 });
      expect(r.ok).toBe(true);
    }
    auth.clock.advance(HOUR);
    expect(await create(auth, ada)).toMatchObject({ ok: false, code: "token_limit", status: 409 });
    // The first token expires; the next create deletes it and fits under the cap.
    auth.clock.advance(DAY);
    expect((await create(auth, ada)).ok).toBe(true);
    expect(await auth.storage.findMany("apiToken", [])).toHaveLength(API_TOKEN_CAP);
  });

  it("takes an organization the user is a member of and refuses any other with not_found", async () => {
    const auth = makeAuth({ organizations: {} });
    const ada = await auth.seedUser("ada@example.com");
    const bob = await auth.seedUser("bob@example.com");
    const org = await createOrganization(auth.config, { user: bob, slug: "acme", name: "Acme" });
    if (!org.ok) throw new Error(org.code);
    const id = org.value.organization.id;
    expect(await create(auth, ada, { organizationId: id })).toMatchObject({ code: "not_found" });
    expect(await create(auth, ada, { organizationId: "missing" })).toMatchObject({
      code: "not_found",
    });
    const mine = await create(auth, bob, { organizationId: id });
    expect(mine.ok && mine.value.apiToken.organizationId).toBe(id);
    // With organizations off, no organization is a valid target.
    const off = makeAuth();
    const carl = await off.seedUser("carl@example.com");
    expect(await create(off, carl, { organizationId: id })).toMatchObject({ code: "not_found" });
  });
});

describe("resolveApiToken", () => {
  it("finds the user by the token hash and answers null for a malformed or unknown token", async () => {
    const auth = makeAuth();
    const ada = await auth.seedUser("ada@example.com");
    const r = await create(auth, ada);
    if (!r.ok) throw new Error(r.code);
    const found = await resolveApiToken(auth.config, r.value.token);
    expect(found?.user.id).toBe(ada.id);
    expect(found?.apiToken.id).toBe(r.value.apiToken.id);
    expect(found?.activeOrganizationId).toBeNull();
    // One character changed, never the same character: the token stays well-formed and unknown.
    const last = r.value.token.endsWith("A") ? "B" : "A";
    expect(await resolveApiToken(auth.config, `${r.value.token.slice(0, -1)}${last}`)).toBeNull();
    expect(await resolveApiToken(auth.config, "tk_short")).toBeNull();
    expect(await resolveApiToken(auth.config, r.value.token.replace("tk_", "ts_"))).toBeNull();
  });

  it("deletes an expired token on its first use after the expiry", async () => {
    const auth = makeAuth();
    const ada = await auth.seedUser("ada@example.com");
    const r = await create(auth, ada, { expiresInDays: 1 });
    if (!r.ok) throw new Error(r.code);
    auth.clock.advance(DAY - 1);
    expect(await resolveApiToken(auth.config, r.value.token)).not.toBeNull();
    auth.clock.advance(1);
    expect(await resolveApiToken(auth.config, r.value.token)).toBeNull();
    expect(await auth.storage.findMany("apiToken", [])).toEqual([]);
  });

  it("writes lastUsedAt at most once per hour, by the injected clock", async () => {
    const auth = makeAuth();
    const ada = await auth.seedUser("ada@example.com");
    const r = await create(auth, ada);
    if (!r.ok) throw new Error(r.code);
    const t0 = auth.clock.now();
    const stored = async () =>
      (
        await auth.storage.findOne("apiToken", [
          { field: "id", op: "eq", value: r.value.apiToken.id },
        ])
      )?.lastUsedAt;
    expect((await resolveApiToken(auth.config, r.value.token))?.apiToken.lastUsedAt).toEqual(t0);
    auth.clock.advance(HOUR - 1);
    expect((await resolveApiToken(auth.config, r.value.token))?.apiToken.lastUsedAt).toEqual(t0);
    expect(await stored()).toEqual(t0);
    auth.clock.advance(1);
    const t1 = auth.clock.now();
    expect((await resolveApiToken(auth.config, r.value.token))?.apiToken.lastUsedAt).toEqual(t1);
    expect(await stored()).toEqual(t1);
  });

  it("answers null when the membership is gone, and the token stays in the list", async () => {
    const auth = makeAuth({ organizations: {} });
    const owner = await auth.seedUser("owner@example.com");
    const ada = await auth.seedUser("ada@example.com");
    const org = await createOrganization(auth.config, { user: owner, slug: "acme", name: "Acme" });
    if (!org.ok) throw new Error(org.code);
    const organizationId = org.value.organization.id;
    expect(
      (
        await addMember(auth.config, {
          user: owner,
          organizationId,
          userId: ada.id,
          role: "member",
        })
      ).ok,
    ).toBe(true);
    const r = await create(auth, ada, { organizationId });
    if (!r.ok) throw new Error(r.code);
    expect((await resolveApiToken(auth.config, r.value.token))?.activeOrganizationId).toBe(
      organizationId,
    );
    expect(
      (await removeMember(auth.config, { user: owner, organizationId, userId: ada.id })).ok,
    ).toBe(true);
    expect(await resolveApiToken(auth.config, r.value.token)).toBeNull();
    const list = await listApiTokens(auth.config, { user: ada });
    expect(list.ok && list.value.map((t) => [t.id, t.organizationId])).toEqual([
      [r.value.apiToken.id, organizationId],
    ]);
  });
});

describe("listApiTokens and revokeApiToken", () => {
  it("lists the caller's own tokens newest first, never a hash", async () => {
    const auth = makeAuth();
    const ada = await auth.seedUser("ada@example.com");
    const bob = await auth.seedUser("bob@example.com");
    const first = await create(auth, ada, { name: "first" });
    auth.clock.advance(1000);
    const second = await create(auth, ada, { name: "second" });
    await create(auth, bob, { name: "bob's" });
    const list = await listApiTokens(auth.config, { user: ada });
    if (!list.ok || !first.ok || !second.ok) throw new Error("setup failed");
    expect(list.value.map((t) => t.name)).toEqual(["second", "first"]);
    for (const t of list.value) expect(Object.keys(t)).not.toContain("tokenHash");
    expect(JSON.stringify(list.value)).not.toContain(first.value.token);
  });

  it("revokes the caller's token by id and answers not_found for another user's", async () => {
    const auth = makeAuth();
    const ada = await auth.seedUser("ada@example.com");
    const bob = await auth.seedUser("bob@example.com");
    const r = await create(auth, ada);
    if (!r.ok) throw new Error(r.code);
    expect(await revokeApiToken(auth.config, { user: bob, id: r.value.apiToken.id })).toMatchObject(
      {
        ok: false,
        code: "not_found",
      },
    );
    expect(await resolveApiToken(auth.config, r.value.token)).not.toBeNull();
    expect(await revokeApiToken(auth.config, { user: ada, id: r.value.apiToken.id })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await resolveApiToken(auth.config, r.value.token)).toBeNull();
  });

  it("refuses an unverified caller with email_unverified", async () => {
    const auth = makeAuth();
    const user = await unverifiedUser(auth);
    expect(await listApiTokens(auth.config, { user })).toMatchObject({ code: "email_unverified" });
    expect(await revokeApiToken(auth.config, { user, id: "x" })).toMatchObject({
      code: "email_unverified",
    });
  });
});

describe("callerFromRequest", () => {
  it("answers a session for the cookie or a ts_ bearer, a token for a tk_ bearer, and null else", async () => {
    const auth = makeAuth();
    const ada = await auth.seedUser("ada@example.com");
    const { token: session } = await createSession(auth.config, {
      userId: ada.id,
      ip: null,
      userAgent: null,
    });
    const r = await create(auth, ada);
    if (!r.ok) throw new Error(r.code);
    const tk = r.value.token;
    const byCookie = await callerFromRequest(
      auth.config,
      request({ cookie: `tempo_session=${session}` }),
    );
    expect(byCookie).toMatchObject({ kind: "session", user: { id: ada.id }, refreshed: false });
    const byBearer = await callerFromRequest(
      auth.config,
      request({ authorization: `Bearer ${session}` }),
    );
    expect(byBearer?.kind).toBe("session");
    const byToken = await callerFromRequest(
      auth.config,
      request({ authorization: `Bearer ${tk}` }),
    );
    expect(byToken).toMatchObject({
      kind: "token",
      user: { id: ada.id },
      apiToken: { id: r.value.apiToken.id },
      activeOrganizationId: null,
    });
    // A token never rides in a cookie, and the cookie wins over the header, as for a session.
    expect(
      await callerFromRequest(auth.config, request({ cookie: `tempo_session=${tk}` })),
    ).toBeNull();
    expect(
      await callerFromRequest(
        auth.config,
        request({ cookie: `tempo_session=${tk}`, authorization: `Bearer ${tk}` }),
      ),
    ).toBeNull();
    expect(await callerFromRequest(auth.config, request({}))).toBeNull();
  });

  it("keeps auth.session session-only and serves auth.caller and api.tokens", async () => {
    const base = makeAuth();
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: base.storage,
      mail: { send: async () => {} },
      clock: base.clock,
    });
    const ada = await base.seedUser("ada@example.com");
    const r = await auth.api.tokens.create({ user: ada, name: "ci" });
    if (!r.ok) throw new Error(r.code);
    const req = request({ authorization: `Bearer ${r.value.token}` });
    expect(await auth.session(req)).toBeNull();
    expect((await auth.caller(req))?.kind).toBe("token");
    expect((await auth.api.tokens.current({ token: r.value.token })).ok).toBe(true);
    expect(await auth.api.tokens.current({ token: "ts_x" })).toMatchObject({
      code: "unauthorized",
    });
    expect((await auth.api.tokens.list({ user: ada })).ok).toBe(true);
    expect((await auth.api.tokens.revoke({ user: ada, id: r.value.apiToken.id })).ok).toBe(true);
  });
});
