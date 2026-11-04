import { describe, expect, it } from "vitest";
import { createVerifier } from "../src/index.js";
import { FILES, ISSUER, makeServer, signedIn, withBearer } from "./harness.js";

async function apiToken(server: ReturnType<typeof makeServer>) {
  const s = await signedIn(server);
  // The token create takes the session of the sign-in (plan 12p).
  const session = await server.auth.api.getSession(s.sessionToken);
  if (!session) throw new Error("no session");
  const t = await server.auth.api.tokens.create({ session, name: "ci" });
  if (!t.ok) throw new Error(t.code);
  return { ...s, token: t.value.token, id: t.value.apiToken.id, user: session.user, session };
}

describe("an API token and a session token (plan 11d)", () => {
  it("answers the api-token caller by one call, and null at once after a revoke (cache 0)", async () => {
    const server = makeServer();
    const t = await apiToken(server);
    const v = createVerifier({
      issuer: ISSUER,
      accept: ["api-token"],
      fetch: server.fetch,
      clock: server.clock,
    });
    const r = await v.verifyRequest(withBearer(FILES, t.token));
    if (!r.ok || r.value?.kind !== "api-token") throw new Error("no api-token caller");
    expect(r.value.user.email).toBe("ada@example.com");
    expect(r.value.apiToken.name).toBe("ci");
    expect(server.count("/auth/tokens/current")).toBe(1);
    const revoked = await server.auth.api.tokens.revoke({ user: t.user, id: t.id });
    expect(revoked.ok).toBe(true);
    expect(await v.verifyRequest(withBearer(FILES, t.token))).toEqual({ ok: true, value: null });
  });

  it("keeps the answer for apiTokenSeconds when the integrator asks", async () => {
    const server = makeServer();
    const t = await apiToken(server);
    const v = createVerifier({
      issuer: ISSUER,
      accept: ["api-token"],
      cache: { apiTokenSeconds: 30 },
      fetch: server.fetch,
      clock: server.clock,
    });
    await v.verifyRequest(withBearer(FILES, t.token));
    await v.verifyRequest(withBearer(FILES, t.token));
    expect(server.count("/auth/tokens/current")).toBe(1);
    server.clock.advance(30_000);
    await v.verifyRequest(withBearer(FILES, t.token));
    expect(server.count("/auth/tokens/current")).toBe(2);
  });

  it("answers null for a spent token and a failure over the window (plan 12k)", async () => {
    const server = makeServer();
    const s = await apiToken(server);
    const spent = await server.auth.api.tokens.create({
      session: s.session,
      name: "spent",
      quota: { remaining: 0 },
    });
    const windowed = await server.auth.api.tokens.create({
      session: s.session,
      name: "windowed",
      rateLimit: { seconds: 60, max: 1 },
    });
    if (!spent.ok || !windowed.ok) throw new Error("no token");
    const v = createVerifier({
      issuer: ISSUER,
      accept: ["api-token"],
      fetch: server.fetch,
      clock: server.clock,
    });
    expect(await v.verifyRequest(withBearer(FILES, spent.value.token))).toEqual({
      ok: true,
      value: null,
    });
    const first = await v.verifyRequest(withBearer(FILES, windowed.value.token));
    expect(first.ok && first.value?.kind).toBe("api-token");
    expect(await v.verifyRequest(withBearer(FILES, windowed.value.token))).toMatchObject({
      ok: false,
      code: "rate_limited",
      status: 429,
    });
  });

  it("keeps no answer of a token with a quota or a window", async () => {
    const server = makeServer();
    const s = await apiToken(server);
    const quota = await server.auth.api.tokens.create({
      session: s.session,
      name: "quota",
      quota: { remaining: 10 },
    });
    const windowed = await server.auth.api.tokens.create({
      session: s.session,
      name: "windowed",
      rateLimit: { seconds: 60, max: 10 },
    });
    if (!quota.ok || !windowed.ok) throw new Error("no token");
    const v = createVerifier({
      issuer: ISSUER,
      accept: ["api-token"],
      cache: { apiTokenSeconds: 30 },
      fetch: server.fetch,
      clock: server.clock,
    });
    for (const token of [quota.value.token, windowed.value.token]) {
      await v.verifyRequest(withBearer(FILES, token));
      await v.verifyRequest(withBearer(FILES, token));
    }
    // Each call reached core, so core spent the quota and counted the window each time.
    expect(server.count("/auth/tokens/current")).toBe(4);
    const [row] = await server.storage.findMany("apiToken", [
      { field: "id", op: "eq", value: quota.value.apiToken.id },
    ]);
    expect(row?.remaining).toBe(8);
  });

  it("answers null with no call for a kind that accept does not list", async () => {
    const server = makeServer();
    const t = await apiToken(server);
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      fetch: server.fetch,
      clock: server.clock,
    });
    expect(await v.verifyRequest(withBearer(FILES, t.token))).toEqual({ ok: true, value: null });
    expect(await v.verifyRequest(withBearer(FILES, t.sessionToken))).toEqual({
      ok: true,
      value: null,
    });
    expect(server.count("/auth/tokens/current") + server.count("/auth/session")).toBe(0);
  });

  it("answers the session-token caller from a ts_ bearer, when accepted", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const v = createVerifier({
      issuer: ISSUER,
      accept: ["session-token"],
      fetch: server.fetch,
      clock: server.clock,
    });
    const a = await v.verifyRequest(withBearer(FILES, s.sessionToken));
    if (!a.ok || a.value?.kind !== "session-token") throw new Error("no session-token caller");
    expect(a.value.user.email).toBe("ada@example.com");
    expect(typeof a.value.session.id).toBe("string");
    expect(await v.verifyRequest(withBearer(FILES, "ts_unknown"))).toEqual({
      ok: true,
      value: null,
    });
  });

  it("never reads the session cookie: a cookie alone answers null with no call", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const v = createVerifier({
      issuer: ISSUER,
      accept: ["session-token"],
      fetch: server.fetch,
      clock: server.clock,
    });
    expect(await v.verifyRequest(new Request(FILES, { headers: { cookie: s.cookie } }))).toEqual({
      ok: true,
      value: null,
    });
    expect(server.count("/auth/session")).toBe(0);
  });

  it("answers network, not null, when the auth app does not answer", async () => {
    const server = makeServer();
    const t = await apiToken(server);
    const v = createVerifier({
      issuer: ISSUER,
      accept: ["api-token"],
      fetch: server.fetch,
      clock: server.clock,
    });
    server.outage("/tokens/current");
    expect(await v.verifyRequest(withBearer(FILES, t.token))).toEqual({
      ok: false,
      code: "network",
      status: 0,
    });
  });
});

/** The hex SHA-256 of a bearer: core's tokenHash. */
async function hashOf(bearer: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A moved key of Better Auth's form: its old prefix and 64 letters. */
const movedKey = () => `laaa_${"Ab".repeat(32)}`;

describe("an organization token and a moved key (plan 12k, review finding m6)", () => {
  /** An organization with its owner, on a server that takes `laaa_` as a moved prefix. */
  async function organizationOf(server: ReturnType<typeof makeServer>) {
    const s = await apiToken(server);
    const org = await server.auth.api.createOrganization({
      user: s.user,
      slug: "acme",
      name: "Acme",
    });
    if (!org.ok) throw new Error(org.code);
    return { ...s, organizationId: org.value.organization.id };
  }
  const movedServer = () => makeServer({ organizations: {}, tokens: { movedPrefixes: ["laaa_"] } });

  it("answers the organization-token caller of a to_ bearer by one call, when accepted", async () => {
    const server = movedServer();
    const o = await organizationOf(server);
    const t = await server.auth.api.organizationTokens.create({
      session: o.session,
      organizationId: o.organizationId,
      name: "deploy",
      permissions: {},
    });
    if (!t.ok) throw new Error(t.code);
    const v = createVerifier({
      issuer: ISSUER,
      accept: ["organization-token"],
      fetch: server.fetch,
      clock: server.clock,
    });
    const r = await v.verifyRequest(withBearer(FILES, t.value.token));
    if (!r.ok || r.value?.kind !== "organization-token") throw new Error("no organization caller");
    expect({ organization: r.value.organization.id, name: r.value.apiToken.name }).toEqual({
      organization: o.organizationId,
      name: "deploy",
    });
    expect(server.count("/auth/organizations/tokens/current")).toBe(1);
    // Not in accept: null with no call.
    const users = createVerifier({
      issuer: ISSUER,
      accept: ["api-token"],
      fetch: server.fetch,
      clock: server.clock,
    });
    expect(await users.verifyRequest(withBearer(FILES, t.value.token))).toEqual({
      ok: true,
      value: null,
    });
    expect(server.count("/auth/organizations/tokens/current")).toBe(1);
  });

  it("sends a moved key of a user to GET /tokens/current with movedPrefixes", async () => {
    const server = movedServer();
    const s = await apiToken(server);
    const key = movedKey();
    // The row form that moveBetterAuthApiKeys of the compat package writes for a user key.
    const at = server.clock.now();
    await server.storage.create("apiToken", {
      id: "moved1",
      userId: s.user.id,
      organizationId: null,
      name: "ci",
      tokenHash: await hashOf(key),
      hint: key.slice(0, 6),
      expiresAt: null,
      lastUsedAt: null,
      permissions: {},
      metadata: null,
      rateLimitSeconds: null,
      rateLimitMax: null,
      remaining: null,
      refillAmount: null,
      refillSeconds: null,
      lastRefillAt: null,
      retiredAt: null,
      createdAt: at,
      updatedAt: at,
    });
    const v = createVerifier({
      issuer: ISSUER,
      accept: ["api-token"],
      movedPrefixes: ["laaa_"],
      fetch: server.fetch,
      clock: server.clock,
    });
    const r = await v.verifyRequest(withBearer(FILES, key));
    if (!r.ok || r.value?.kind !== "api-token") throw new Error("no api-token caller");
    expect(r.value.user.id).toBe(s.user.id);
    expect(server.count("/auth/tokens/current")).toBe(1);
    // With no movedPrefixes, the old prefix is no credential: null with no call.
    const plain = createVerifier({
      issuer: ISSUER,
      accept: ["api-token"],
      fetch: server.fetch,
      clock: server.clock,
    });
    expect(await plain.verifyRequest(withBearer(FILES, key))).toEqual({ ok: true, value: null });
    expect(server.count("/auth/tokens/current")).toBe(1);
  });

  it("sends a moved key of an organization to GET /organizations/tokens/current", async () => {
    const server = movedServer();
    const o = await organizationOf(server);
    const key = movedKey();
    // The row form that moveBetterAuthApiKeys writes for an organization key.
    const at = server.clock.now();
    await server.storage.create("organizationToken", {
      id: "moved2",
      organizationId: o.organizationId,
      createdById: o.user.id,
      name: "deploy",
      tokenHash: await hashOf(key),
      hint: key.slice(0, 6),
      permissions: {},
      metadata: null,
      expiresAt: null,
      lastUsedAt: null,
      rateLimitSeconds: null,
      rateLimitMax: null,
      remaining: null,
      refillAmount: null,
      refillSeconds: null,
      lastRefillAt: null,
      retiredAt: null,
      createdAt: at,
      updatedAt: at,
    });
    const v = createVerifier({
      issuer: ISSUER,
      accept: ["organization-token"],
      movedPrefixes: ["laaa_"],
      movedKind: "organization-token",
      fetch: server.fetch,
      clock: server.clock,
    });
    const r = await v.verifyRequest(withBearer(FILES, key));
    if (!r.ok || r.value?.kind !== "organization-token") throw new Error("no organization caller");
    expect(r.value.organization.id).toBe(o.organizationId);
    expect(server.count("/auth/organizations/tokens/current")).toBe(1);
    expect(server.count("/auth/tokens/current")).toBe(0);
  });

  it("throws for a moved prefix outside core's rule and for a moved kind outside accept", () => {
    const base = { issuer: ISSUER, accept: ["api-token"] as const };
    for (const p of ["tk_", "to_", "Laaa_", "laaa"])
      expect(() => createVerifier({ ...base, movedPrefixes: [p] })).toThrow(
        `authtempo verify: the moved prefix "${p}" must follow core's tokens.movedPrefixes rule, once`,
      );
    expect(() => createVerifier({ ...base, movedPrefixes: ["laaa_", "laaa_"] })).toThrow(
      "must follow core's tokens.movedPrefixes rule, once",
    );
    expect(() =>
      createVerifier({ ...base, movedPrefixes: ["laaa_"], movedKind: "organization-token" }),
    ).toThrow("authtempo verify: movedPrefixes needs organization-token in accept");
    expect(() => createVerifier({ ...base, movedPrefixes: ["laaa_"] })).not.toThrow();
  });
});
