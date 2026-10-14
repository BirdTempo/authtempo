import { describe, expect, it } from "vitest";
import { createVerifier, type VerifierOptions } from "../src/index.js";
import { FILES, ISSUER, MCP, makeServer, sessionJwt, signedIn, withBearer } from "./harness.js";

function verifierOf(server: ReturnType<typeof makeServer>, extra: Partial<VerifierOptions> = {}) {
  return createVerifier({
    issuer: ISSUER,
    audience: FILES,
    fetch: server.fetch,
    clock: server.clock,
    ...extra,
  });
}

describe("a session JWT (plan 11d)", () => {
  it("answers the caller of a session JWT that core minted, offline after the key set", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    const v = verifierOf(server);
    const r = await v.verifyRequest(withBearer(`${FILES}/doc`, jwt));
    if (!r.ok || r.value?.kind !== "session-jwt") throw new Error("no session-jwt caller");
    expect(r.value).toMatchObject({
      userId: s.user.id,
      email: "ada@example.com",
      emailVerified: true,
      name: null,
      organizationId: null,
    });
    expect(typeof r.value.sessionId).toBe("string");
    expect(r.value.claims.iss).toBe(ISSUER);
    expect(server.count("/auth/jwks")).toBe(1);
    await v.verifyRequest(withBearer(`${FILES}/doc`, jwt));
    expect(server.count("/auth/jwks")).toBe(1);
    expect(server.count("/auth/session")).toBe(0);
  });

  it("answers null for a changed signature, another issuer, another audience, and an expired token", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    const v = verifierOf(server);
    const changed = `${jwt.slice(0, -2)}${jwt.endsWith("AA") ? "BB" : "AA"}`;
    expect(await v.verifyRequest(withBearer(FILES, changed))).toEqual({ ok: true, value: null });
    const otherAudience = verifierOf(server, { audience: "https://other.example.com" });
    expect(await otherAudience.verifyRequest(withBearer(FILES, jwt))).toEqual({
      ok: true,
      value: null,
    });
    // A verifier of another issuer that reads the same key set: the signature holds, iss does not.
    const otherIssuer = createVerifier({
      issuer: "https://api.example.com/other",
      audience: FILES,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        server.fetch(
          new Request(input, init).url.replace("/other/", "/auth/"),
          init,
        )) as typeof fetch,
      clock: server.clock,
    });
    expect(await otherIssuer.verifyRequest(withBearer(FILES, jwt))).toEqual({
      ok: true,
      value: null,
    });
    server.clock.advance(15 * 60_000 + 1);
    expect(await v.verifyRequest(withBearer(FILES, jwt))).toEqual({ ok: true, value: null });
  });

  it("answers null for a session JWT where only access tokens are accepted, with no read", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    const v = createVerifier({
      issuer: ISSUER,
      resources: [MCP],
      accept: ["oauth"],
      fetch: server.fetch,
      clock: server.clock,
    });
    expect(await v.verifyRequest(withBearer(MCP, jwt))).toEqual({ ok: true, value: null });
    expect(server.count("/auth/jwks")).toBe(0);
  });

  it("asks the live route with checkSessionEnd, and answers null after the sign-out", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    const v = verifierOf(server, { checkSessionEnd: true });
    expect((await v.verifyRequest(withBearer(FILES, jwt))).ok).toBe(true);
    expect(server.count("/auth/token/live")).toBe(1);
    const out = await server.auth.handle(
      new Request(`${ISSUER}/sign-out`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(out.status).toBe(200);
    expect(await v.verifyRequest(withBearer(FILES, jwt))).toEqual({ ok: true, value: null });
    // Without the option, the JWT stays a bearer for its life.
    const offline = verifierOf(server);
    expect((await offline.verifyRequest(withBearer(FILES, jwt))).ok).toBe(true);
  });

  it("passes the 429 of the live route through as a failure", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    const v = verifierOf(server, { checkSessionEnd: true });
    for (let i = 0; i < 120; i++) await v.verifyRequest(withBearer(FILES, jwt));
    expect(await v.verifyRequest(withBearer(FILES, jwt))).toEqual({
      ok: false,
      code: "rate_limited",
      status: 429,
    });
  });

  it("refuses a wrong config at construction", () => {
    expect(() => createVerifier({ issuer: "nope", audience: FILES })).toThrow(/issuer/);
    expect(() => createVerifier({ issuer: ISSUER })).toThrow(/audience/);
    expect(() => createVerifier({ issuer: ISSUER, accept: ["oauth"] })).toThrow(/resources/);
    expect(() => createVerifier({ issuer: ISSUER, audience: FILES, accept: [] })).toThrow(/accept/);
    expect(() =>
      createVerifier({
        issuer: ISSUER,
        audience: MCP,
        resources: [MCP],
        accept: ["session-jwt", "oauth"],
      }),
    ).toThrow(/both an audience and a resource/);
    expect(() =>
      createVerifier({ issuer: ISSUER, audience: FILES, cache: { apiTokenSeconds: 61 } }),
    ).toThrow(/apiTokenSeconds/);
    expect(() => createVerifier({ issuer: ISSUER, audience: FILES, timeoutMs: 99 })).toThrow(
      /timeoutMs/,
    );
    expect(() => createVerifier({ issuer: ISSUER, audience: [""] })).toThrow(/audience/);
  });

  it("refuses a resource that core's resource rule refuses, at construction and not per request", () => {
    for (const bad of [
      "mcp",
      "https://api.example.com/mcp?x=1",
      "ftp://api.example.com/mcp",
      "https://u:p@api.example.com/mcp",
    ])
      expect(() => createVerifier({ issuer: ISSUER, resources: [bad], accept: ["oauth"] })).toThrow(
        /resource/,
      );
    expect(() =>
      createVerifier({ issuer: ISSUER, resources: [`${MCP}#a`], accept: ["oauth"] }),
    ).toThrow(/resource/);
  });
});
