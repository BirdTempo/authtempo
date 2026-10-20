import { describe, expect, it } from "vitest";
import { createVerifier } from "../src/index.js";
import { FILES, ISSUER, makeServer, signedIn, withBearer } from "./harness.js";

async function apiToken(server: ReturnType<typeof makeServer>) {
  const s = await signedIn(server);
  const user = await server.storage.findOne("user", [{ field: "id", op: "eq", value: s.user.id }]);
  if (!user) throw new Error("no user");
  const t = await server.auth.api.tokens.create({ user, name: "ci" });
  if (!t.ok) throw new Error(t.code);
  return { ...s, token: t.value.token, id: t.value.apiToken.id, user };
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
      user: s.user,
      name: "spent",
      quota: { remaining: 0 },
    });
    const windowed = await server.auth.api.tokens.create({
      user: s.user,
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
      user: s.user,
      name: "quota",
      quota: { remaining: 10 },
    });
    const windowed = await server.auth.api.tokens.create({
      user: s.user,
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
