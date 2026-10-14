import { createAuth } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { createVerifier, type Verifier } from "../src/index.js";
import {
  accessToken,
  BASE,
  expOf,
  FILES,
  ISSUER,
  MCP,
  makeServer,
  SECRET,
  type Server,
  sessionJwt,
  signedIn,
  withBearer,
} from "./harness.js";

/**
 * The verifier's claim rule is a copy of the engine's rule (`verifySessionJwt`
 * and `resolveAccessToken` in core's `engine/jwt.ts` and
 * `engine/oauth-token.ts`). The two copies must stay equal.
 * This file asks both copies about the same tokens, and a real core instance mints each token.
 * A token that the engine accepts must verify. A token that the engine refuses must answer null.
 */

const OTHER = "https://other.example.com";

/** A second core instance on the same storage and secret, so it holds the same keys. */
function twin(server: Server, extra: { audience?: string[]; basePath?: string }) {
  return createAuth({
    baseURL: BASE,
    ...(extra.basePath !== undefined ? { basePath: extra.basePath } : {}),
    secret: SECRET,
    trustedOrigins: [],
    storage: server.storage,
    mail: { send: async () => {} },
    clock: server.clock,
    jwtMint: { audience: extra.audience ?? [FILES] },
    oauth: { resources: [MCP], registration: { cimd: false } },
  });
}

async function sessionAnswers(
  engine: ReturnType<typeof createAuth>,
  verifier: Verifier,
  token: string,
): Promise<{ engine: boolean; verifier: boolean }> {
  const claims = await engine.api.jwt?.verify(token);
  const r = await verifier.verifyRequest(withBearer(`${FILES}/doc`, token));
  if (!r.ok) throw new Error(`the verifier failed: ${r.code}`);
  return { engine: claims !== null && claims !== undefined, verifier: r.value !== null };
}

describe("the session JWT rule equals the engine's rule (plan 11d, Task 1 review)", () => {
  it("accepts what the engine accepts, up to the last second before exp, and refuses at exp", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      fetch: server.fetch,
      clock: server.clock,
    });
    expect(await sessionAnswers(server.auth, v, jwt)).toEqual({ engine: true, verifier: true });
    // The same claims: the caller's claims are the engine's claims.
    const r = await v.verifyRequest(withBearer(FILES, jwt));
    expect(r.ok && r.value?.kind === "session-jwt" && r.value.claims).toEqual(
      await server.auth.api.jwt?.verify(jwt),
    );
    const exp = expOf(jwt);
    server.clock.set(exp * 1000 - 1);
    expect(await sessionAnswers(server.auth, v, jwt)).toEqual({ engine: true, verifier: true });
    // A strict exp with no clock skew in both copies.
    server.clock.set(exp * 1000);
    expect(await sessionAnswers(server.auth, v, jwt)).toEqual({ engine: false, verifier: false });
  });

  it("refuses a changed signature, another audience, another issuer, and an access token, as the engine does", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      fetch: server.fetch,
      clock: server.clock,
    });
    const changed = `${jwt.slice(0, -2)}${jwt.endsWith("AA") ? "BB" : "AA"}`;
    expect(await sessionAnswers(server.auth, v, changed)).toEqual({
      engine: false,
      verifier: false,
    });

    // Another audience: the twin mints for OTHER with the same key.
    const other = twin(server, { audience: [OTHER] });
    const foreign = await other.api.jwt?.mint({ userId: s.user.id, sessionId: jwtSid(jwt) });
    if (!foreign?.ok) throw new Error("the twin did not mint");
    expect(await sessionAnswers(server.auth, v, foreign.value.token)).toEqual({
      engine: false,
      verifier: false,
    });
    const vOther = createVerifier({
      issuer: ISSUER,
      audience: OTHER,
      fetch: server.fetch,
      clock: server.clock,
    });
    expect(await sessionAnswers(other, vOther, foreign.value.token)).toEqual({
      engine: true,
      verifier: true,
    });

    // Another issuer: the twin at /other holds the same key, and refuses the token of /auth.
    const otherIssuer = twin(server, { basePath: "/other" });
    const vIssuer = createVerifier({
      issuer: `${BASE}/other`,
      audience: FILES,
      clock: server.clock,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        server.fetch(
          new Request(input, init).url.replace("/other/", "/auth/"),
          init,
        )) as typeof fetch,
    });
    expect(await sessionAnswers(otherIssuer, vIssuer, jwt)).toEqual({
      engine: false,
      verifier: false,
    });

    // An access token has typ at+jwt: both copies refuse it as a session JWT.
    const at = await accessToken(server, s.cookie);
    expect(await sessionAnswers(server.auth, v, at)).toEqual({ engine: false, verifier: false });
  });
});

function jwtSid(token: string): string {
  const part = token.split(".")[1] ?? "";
  return (JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { sid: string }).sid;
}

describe("the access token rule equals the engine's rule (plan 11d, Task 1 review)", () => {
  async function oauthAnswers(server: Server, v: Verifier, url: string, token: string) {
    const caller = await server.auth.caller(withBearer(url, token));
    const r = await v.verifyRequest(withBearer(url, token));
    if (!r.ok) throw new Error(`the verifier failed: ${r.code}`);
    return {
      engine: caller?.kind === "oauth",
      verifier: r.value?.kind === "oauth",
    };
  }

  it("accepts under the resource, refuses beside it, and refuses at exp, as auth.caller does", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const at = await accessToken(server, s.cookie);
    const v = createVerifier({
      issuer: ISSUER,
      resources: [MCP],
      accept: ["oauth"],
      fetch: server.fetch,
      clock: server.clock,
    });
    expect(await oauthAnswers(server, v, `${MCP}/tools`, at)).toEqual({
      engine: true,
      verifier: true,
    });
    expect(await oauthAnswers(server, v, `${BASE}/mcpx`, at)).toEqual({
      engine: false,
      verifier: false,
    });
    expect(await oauthAnswers(server, v, `${OTHER}/mcp`, at)).toEqual({
      engine: false,
      verifier: false,
    });
    const r = await v.verifyRequest(withBearer(`${MCP}/tools`, at));
    const c = await server.auth.caller(withBearer(`${MCP}/tools`, at));
    if (!r.ok || r.value?.kind !== "oauth" || c?.kind !== "oauth")
      throw new Error("no oauth caller");
    expect({
      userId: r.value.userId,
      clientId: r.value.clientId,
      scopes: r.value.scopes,
      resource: r.value.resource,
      tokenId: r.value.tokenId,
      expiresAt: r.value.expiresAt,
    }).toEqual({
      userId: c.user.id,
      clientId: c.clientId,
      scopes: c.scopes,
      resource: c.resource,
      tokenId: c.tokenId,
      expiresAt: c.expiresAt,
    });
    const exp = expOf(at);
    server.clock.set(exp * 1000 - 1);
    expect(await oauthAnswers(server, v, `${MCP}/tools`, at)).toEqual({
      engine: true,
      verifier: true,
    });
    server.clock.set(exp * 1000);
    expect(await oauthAnswers(server, v, `${MCP}/tools`, at)).toEqual({
      engine: false,
      verifier: false,
    });
  });

  it("refuses a session JWT at the resource, as auth.caller does", async () => {
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
    expect(await oauthAnswers(server, v, `${MCP}/tools`, jwt)).toEqual({
      engine: false,
      verifier: false,
    });
  });
});
