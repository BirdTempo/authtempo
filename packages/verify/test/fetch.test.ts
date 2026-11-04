import { describe, expect, it } from "vitest";
import { createVerifier } from "../src/index.js";
import { publicKeyOf } from "../src/jwks.js";
import {
  accessToken,
  FILES,
  ISSUER,
  MCP,
  makeServer,
  sessionJwt,
  signedIn,
  withBearer,
} from "./harness.js";

/** A fetch that answers the key set through `edit`, and every other path from core. */
function editedKeys(
  server: ReturnType<typeof makeServer>,
  edit: (keys: Record<string, unknown>[]) => unknown[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await server.fetch(input, init);
    if (!new URL(new Request(input, init).url).pathname.endsWith("/jwks")) return res;
    const body = (await res.json()) as { keys: Record<string, unknown>[] };
    return Response.json({ keys: edit(body.keys) }, { headers: res.headers });
  }) as typeof fetch;
}

describe("each fetched key is checked at run time (plan 11d, Task 1 review)", () => {
  it("drops a key whose use is not sig, so a token that it signed answers null", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      clock: server.clock,
      fetch: editedKeys(server, (keys) => keys.map((k) => ({ ...k, use: "enc" }))),
    });
    expect(await v.verifyRequest(withBearer(FILES, jwt))).toEqual({ ok: true, value: null });
  });

  it("takes a key with no use as a signing key (ruling 2 of plan 12e)", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      clock: server.clock,
      fetch: editedKeys(server, (keys) => keys.map(({ use: _use, ...k }) => k)),
    });
    const r = await v.verifyRequest(withBearer(FILES, jwt));
    expect(r.ok && r.value?.kind).toBe("session-jwt");
  });

  it("drops a key whose kid is empty (ruling 2 of plan 12e)", async () => {
    const key = { kty: "OKP", crv: "Ed25519", x: "AAAA", kid: "k1", alg: "EdDSA", use: "sig" };
    expect(publicKeyOf(key)).toEqual(key);
    expect(publicKeyOf({ ...key, kid: "" })).toBeNull();
  });

  it("drops the true key when its kty or crv does not match its alg, so its token answers null", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    for (const change of [{ kty: "EC" }, { crv: "X25519" }, { crv: "P-256" }, { alg: "ES256" }]) {
      const v = createVerifier({
        issuer: ISSUER,
        audience: FILES,
        clock: server.clock,
        fetch: editedKeys(server, (keys) => keys.map((k) => ({ ...k, ...change }))),
      });
      expect(await v.verifyRequest(withBearer(FILES, jwt))).toEqual({ ok: true, value: null });
    }
  });

  it("drops a key of another kty, crv, or alg, and keeps the true key beside it", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    const bad = [
      { kty: "RSA", kid: "r1", alg: "RS256", n: "AQAB", e: "AQAB", use: "sig" },
      { kty: "OKP", crv: "P-256", kid: "m1", alg: "EdDSA", x: "AA", use: "sig" },
      { kty: "EC", crv: "P-256", kid: "m2", alg: "EdDSA", x: "AA", y: "AA", use: "sig" },
      { kty: "EC", crv: "P-256", kid: "m3", alg: "ES256", x: "AA", use: "sig" },
      { kty: "OKP", crv: "Ed25519", kid: "m4", alg: "none", x: "AA", use: "sig" },
      "not a key",
      null,
    ];
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      clock: server.clock,
      fetch: editedKeys(server, (keys) => [...bad, ...keys]),
    });
    const r = await v.verifyRequest(withBearer(FILES, jwt));
    expect(r.ok && r.value?.kind).toBe("session-jwt");
  });
});

describe("the verifier follows no redirect and owns its timeout (plan 11d)", () => {
  it("sends redirect manual and a signal on each of its four calls", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    // The token create takes the session of the sign-in (plan 12p).
    const session = await server.auth.api.getSession(s.sessionToken);
    if (!session) throw new Error("no session");
    const t = await server.auth.api.tokens.create({ session, name: "ci" });
    if (!t.ok) throw new Error(t.code);
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      accept: ["session-jwt", "api-token", "session-token"],
      checkSessionEnd: true,
      fetch: server.fetch,
      clock: server.clock,
    });
    expect((await v.verifyRequest(withBearer(FILES, jwt))).ok).toBe(true);
    expect((await v.verifyRequest(withBearer(FILES, t.value.token))).ok).toBe(true);
    expect((await v.verifyRequest(withBearer(FILES, s.sessionToken))).ok).toBe(true);
    // The key set, the live route, the API token, and the session: four calls.
    expect(server.inits).toHaveLength(4);
    for (const init of server.inits) {
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("answers unexpected with the status for a key set that redirects, and fetches no location", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    const seen: string[] = [];
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      clock: server.clock,
      fetch: (async (input: RequestInfo | URL) => {
        seen.push(new Request(input).url);
        return new Response(JSON.stringify({ keys: [] }), {
          status: 302,
          headers: { location: "http://169.254.169.254/latest" },
        });
      }) as typeof fetch,
    });
    expect(await v.verifyRequest(withBearer(FILES, jwt))).toEqual({
      ok: false,
      code: "unexpected",
      status: 302,
    });
    expect(seen).toEqual([`${ISSUER}/jwks`]);
  });

  it("answers unexpected, never a caller, for a call to the auth app that redirects", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const v = createVerifier({
      issuer: ISSUER,
      accept: ["session-token"],
      clock: server.clock,
      // A body that would pass as a session if the verifier read it.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const real = await server.fetch(input, init);
        return new Response(await real.text(), {
          status: 307,
          headers: { location: "https://elsewhere.example.com/" },
        });
      }) as typeof fetch,
    });
    expect(await v.verifyRequest(withBearer(FILES, s.sessionToken))).toEqual({
      ok: false,
      code: "unexpected",
      status: 307,
    });
  });

  it("answers unexpected, not null, for a redirect whose body names a known error code", async () => {
    const v = createVerifier({
      issuer: ISSUER,
      accept: ["api-token"],
      fetch: (async () =>
        Response.json(
          { error: "unauthorized" },
          { status: 302, headers: { location: "https://elsewhere.example.com/" } },
        )) as typeof fetch,
    });
    expect(await v.verifyRequest(withBearer(FILES, "tk_any"))).toEqual({
      ok: false,
      code: "unexpected",
      status: 302,
    });
  });

  it("answers network for an opaque redirect, the answer of a browser-like runtime", async () => {
    const opaque = { type: "opaqueredirect", status: 0, ok: false } as unknown as Response;
    const v = createVerifier({
      issuer: ISSUER,
      accept: ["api-token"],
      fetch: (async () => opaque) as typeof fetch,
    });
    expect(await v.verifyRequest(withBearer(FILES, "tk_any"))).toEqual({
      ok: false,
      code: "network",
      status: 0,
    });
  });

  it("answers network when the auth app does not answer within timeoutMs", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const at = await accessToken(server, s.cookie);
    const v = createVerifier({
      issuer: ISSUER,
      resources: [MCP],
      accept: ["oauth"],
      timeoutMs: 100,
      clock: server.clock,
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })) as typeof fetch,
    });
    const started = Date.now();
    expect(await v.verifyRequest(withBearer(`${MCP}/x`, at))).toEqual({
      ok: false,
      code: "network",
      status: 0,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
