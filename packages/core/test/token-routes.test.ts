import { describe, expect, it } from "vitest";
import { createAuth } from "../src/create-auth.js";
import { createSession } from "../src/engine/sessions.js";
import { newId } from "../src/primitives/ids.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post } from "./helpers.js";
import { FAST } from "./password-helpers.js";

/** One storage, clock, and limiter for the engine view and the routes. Passwords and organizations are on, for the session-only routes. */
function tokenHandle() {
  const base = makeAuth({ organizations: {}, password: { hash: FAST } });
  const auth = createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: base.storage,
    mail: { send: async () => {} },
    clock: base.clock,
    limiter: base.config.limiter,
    organizations: {},
    password: { hash: FAST },
  });
  return { ...base, auth };
}

/** A user and a `ts_` session token. An unverified user with a session is a password sign-up whose link was not used. */
async function signedIn(h: ReturnType<typeof tokenHandle>, email: string, verified = true) {
  const now = h.clock.now();
  const user = await h.storage.create("user", {
    id: newId(now),
    email,
    emailVerified: verified,
    name: null,
    image: null,
    bannedAt: null,
    banReason: null,
    banUntil: null,
    username: null,
    displayUsername: null,
    phone: null,
    isAnonymous: false,
    createdAt: now,
    updatedAt: now,
  });
  const { token } = await createSession(h.config, { userId: user.id, ip: null, userAgent: null });
  return { user, session: token };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function mint(h: ReturnType<typeof tokenHandle>, session: string, name = "ci") {
  const res = await h.auth.handle(post("/auth/tokens", { name }, bearer(session)));
  if (res.status !== 200) throw new Error(`create answered ${res.status}`);
  return (await res.json()) as { token: string; apiToken: { id: string; hint: string } };
}

describe("token routes", () => {
  it("POST /tokens takes organizationId null as no organization (M-1)", async () => {
    const h = tokenHandle();
    const ada = await signedIn(h, "ada@example.com");
    const res = await h.auth.handle(
      post("/auth/tokens", { name: "x", organizationId: null }, bearer(ada.session)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { apiToken: { organizationId: string | null } };
    expect(body.apiToken.organizationId).toBeNull();
  });

  it("POST /tokens expires in 90 days when expiresInDays is absent (M-8)", async () => {
    const h = tokenHandle();
    const ada = await signedIn(h, "ada@example.com");
    const res = await h.auth.handle(post("/auth/tokens", { name: "x" }, bearer(ada.session)));
    const body = (await res.json()) as { apiToken: { expiresAt: string } };
    expect(body.apiToken.expiresAt).toBe(
      new Date(h.clock.now().getTime() + 90 * 86_400_000).toISOString(),
    );
  });

  it("refuses an unverified user on GET /tokens and POST /tokens/revoke (M-8)", async () => {
    const h = tokenHandle();
    const pat = await signedIn(h, "pat@example.com", false);
    const list = await h.auth.handle(get("/auth/tokens", bearer(pat.session)));
    expect(list.status).toBe(403);
    expect(await list.json()).toEqual({ error: "email_unverified" });
    const revoke = await h.auth.handle(
      post("/auth/tokens/revoke", { id: "x" }, bearer(pat.session)),
    );
    expect(revoke.status).toBe(403);
    expect(await revoke.json()).toEqual({ error: "email_unverified" });
  });

  it("refuses a number organizationId and a revoke body with no id (M-8)", async () => {
    const h = tokenHandle();
    const ada = await signedIn(h, "ada@example.com");
    const number = await h.auth.handle(
      post("/auth/tokens", { name: "x", organizationId: 5 }, bearer(ada.session)),
    );
    expect(number.status).toBe(400);
    expect(await number.json()).toEqual({ error: "invalid_body" });
    const noId = await h.auth.handle(post("/auth/tokens/revoke", {}, bearer(ada.session)));
    expect(noId.status).toBe(400);
    expect(await noId.json()).toEqual({ error: "invalid_body" });
  });

  it("POST /tokens answers the clear token once, and GET /tokens never shows it", async () => {
    const h = tokenHandle();
    const ada = await signedIn(h, "ada@example.com");
    const res = await h.auth.handle(
      post("/auth/tokens", { name: "deploy", expiresInDays: null }, bearer(ada.session)),
    );
    expect(res.status).toBe(200);
    const created = (await res.json()) as {
      token: string;
      apiToken: Record<string, unknown>;
    };
    expect(created.token).toMatch(/^tk_[A-Za-z0-9_-]{43}$/);
    expect(created.apiToken).toEqual({
      id: expect.any(String),
      name: "deploy",
      hint: created.token.slice(3, 11),
      expiresAt: null,
      lastUsedAt: null,
      organizationId: null,
      permissions: null,
      metadata: null,
      rateLimit: null,
      remaining: null,
      retired: false,
      createdAt: h.clock.now().toISOString(),
    });
    const list = await h.auth.handle(get("/auth/tokens", bearer(ada.session)));
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain(created.token);
    expect(text).not.toContain("tokenHash");
    expect(JSON.parse(text)).toEqual({ tokens: [created.apiToken] });
  });

  it("answers 401 to a tk_ bearer on every route that takes a session (Review Focus 1)", async () => {
    const h = tokenHandle();
    const ada = await signedIn(h, "ada@example.com");
    const { token } = await mint(h, ada.session);
    const calls = [
      post("/auth/tokens", { name: "minted by a token" }, bearer(token)),
      get("/auth/tokens", bearer(token)),
      post("/auth/tokens/revoke", { id: "x" }, bearer(token)),
      post("/auth/password/change", { newPassword: "a new password" }, bearer(token)),
      post("/auth/organizations/create", { slug: "acme", name: "Acme" }, bearer(token)),
      get("/auth/session", bearer(token)),
    ];
    for (const req of calls) {
      const res = await h.auth.handle(req);
      expect({ path: new URL(req.url).pathname, status: res.status }).toEqual({
        path: new URL(req.url).pathname,
        status: 401,
      });
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    // Nothing changed: one token, no password, no organization.
    expect(await h.storage.findMany("apiToken", [])).toHaveLength(1);
    expect(await h.storage.findMany("password", [])).toEqual([]);
    expect(await h.storage.findMany("organization", [])).toEqual([]);
  });

  it("GET /tokens/current answers the user for a tk_ bearer and 401 for a session or nothing", async () => {
    const h = tokenHandle();
    const ada = await signedIn(h, "ada@example.com");
    const { token, apiToken } = await mint(h, ada.session, "laptop");
    const res = await h.auth.handle(get("/auth/tokens/current", bearer(token)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: {
        id: ada.user.id,
        email: "ada@example.com",
        emailVerified: true,
        name: null,
        image: null,
      },
      apiToken: expect.objectContaining({ id: apiToken.id, name: "laptop" }),
    });
    for (const headers of [
      bearer(ada.session),
      { cookie: `__Host-tempo_session=${ada.session}` },
      { cookie: `__Host-tempo_session=${token}` },
      {},
    ]) {
      const r = await h.auth.handle(get("/auth/tokens/current", headers));
      expect(r.status).toBe(401);
    }
  });

  it("refuses a bad body, an unverified user, and another user's token id", async () => {
    const h = tokenHandle();
    const ada = await signedIn(h, "ada@example.com");
    const bob = await signedIn(h, "bob@example.com");
    const pat = await signedIn(h, "pat@example.com", false);
    for (const body of [
      { name: "" },
      { name: "x", expiresInDays: 0 },
      { name: "x", expiresInDays: 3651 },
      { name: "x", expiresInDays: 1.5 },
      { name: 5 },
    ]) {
      const r = await h.auth.handle(post("/auth/tokens", body, bearer(ada.session)));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_body" });
    }
    const unverified = await h.auth.handle(
      post("/auth/tokens", { name: "x" }, bearer(pat.session)),
    );
    expect(unverified.status).toBe(403);
    expect(await unverified.json()).toEqual({ error: "email_unverified" });
    const { apiToken } = await mint(h, ada.session);
    const other = await h.auth.handle(
      post("/auth/tokens/revoke", { id: apiToken.id }, bearer(bob.session)),
    );
    expect(other.status).toBe(404);
    const mine = await h.auth.handle(
      post("/auth/tokens/revoke", { id: apiToken.id }, bearer(ada.session)),
    );
    expect(await mine.json()).toEqual({ ok: true });
    const missingOrg = await h.auth.handle(
      post("/auth/tokens", { name: "x", organizationId: "missing" }, bearer(ada.session)),
    );
    expect(missingOrg.status).toBe(404);
  });
});
