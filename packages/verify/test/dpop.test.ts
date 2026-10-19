import { describe, expect, it } from "vitest";
import {
  createVerifier,
  type DpopOptions,
  memoryReplayStore,
  type ReplayStore,
} from "../src/index.js";
import {
  accessToken,
  boundToken,
  claimsOf,
  dpopKey,
  FILES,
  ISSUER,
  MCP,
  makeClock,
  makeServer,
  type Server,
  sessionJwt,
  signedIn,
  withBearer,
  withDpop,
} from "./harness.js";

/**
 * DPoP at a resource server (plan 12e Task 10, RFC 9449 read 2026-10-20).
 * Each token comes from a real core instance, bound to a key that the test
 * generates; each proof comes from the shared helper.
 */

const METADATA =
  'resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"';
const TOOLS = `${MCP}/tools`;

function verifierOf(server: Server, dpop: DpopOptions = {}) {
  return createVerifier({
    issuer: ISSUER,
    resources: [MCP],
    accept: ["oauth"],
    fetch: server.fetch,
    clock: server.clock,
    dpop,
  });
}

/** A bound token, its key, and a fresh proof of that key for a GET of `TOOLS`. */
async function bound(server: Server) {
  const s = await signedIn(server);
  const key = await dpopKey();
  const token = await boundToken(server, s.cookie, key);
  const proof = () => key.proof(server, { htm: "GET", htu: TOOLS, accessToken: token });
  return { s, key, token, proof };
}

describe("DPoP in the verifier (plan 12e Task 10)", () => {
  it("passes a DPoP request offline", async () => {
    const server = makeServer();
    const { s, token, proof } = await bound(server);
    const jkt = (claimsOf(token).cnf as { jkt: string }).jkt;
    expect(jkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const v = verifierOf(server);
    const request = withDpop(TOOLS, token, await proof());
    const r = await v.verifyRequest(request);
    if (!r.ok || r.value?.kind !== "oauth") throw new Error("no oauth caller");
    expect(r.value).toMatchObject({ userId: s.user.id, resource: MCP, dpopJkt: jkt });
    // Offline: the one call is the read of the key set.
    expect(server.inits).toHaveLength(1);
    expect(server.count("/auth/jwks")).toBe(1);
    // A second check of the same request answers the same: the proof was spent once.
    expect(await v.verifyRequest(request)).toEqual(r);
  });

  it("refuses a bound token as a Bearer and writes both challenges", async () => {
    const server = makeServer();
    const { token } = await bound(server);
    const v = verifierOf(server, { algs: ["ES256", "EdDSA"] });
    const request = withBearer(TOOLS, token);
    expect(await v.verifyRequest(request)).toEqual({ ok: true, value: null });
    // RFC 9449 section 7.2: the scheme of the request carries the error.
    const res = v.unauthorized({ resource: MCP, scope: "mcp:tools", request });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", ${METADATA}, scope="mcp:tools", DPoP algs="ES256 EdDSA", ${METADATA}, scope="mcp:tools"`,
    );
    // No credential: no error in either challenge (Figure 17 of the RFC).
    expect(v.unauthorized({ resource: MCP }).headers.get("www-authenticate")).toBe(
      `Bearer ${METADATA}, DPoP algs="ES256 EdDSA", ${METADATA}`,
    );
  });

  it("answers invalid_dpop_proof in the DPoP challenge for a bad proof", async () => {
    const server = makeServer();
    const { key, token, proof } = await bound(server);
    const other = await dpopKey();
    const v = verifierOf(server);
    const proofChallenge = `Bearer ${METADATA}, DPoP error="invalid_dpop_proof", algs="EdDSA Ed25519 ES256 RS256 PS256", ${METADATA}`;
    const bad = [
      // Another key: the thumbprint is not the cnf.jkt of the token.
      withDpop(
        TOOLS,
        token,
        await other.proof(server, { htm: "GET", htu: TOOLS, accessToken: token }),
      ),
      // Another URL, no ath, and another method.
      withDpop(
        TOOLS,
        token,
        await key.proof(server, { htm: "GET", htu: `${MCP}/x`, accessToken: token }),
      ),
      withDpop(TOOLS, token, await key.proof(server, { htm: "GET", htu: TOOLS })),
      withDpop(TOOLS, token, await proof(), "POST"),
      // No DPoP header.
      new Request(TOOLS, { headers: { authorization: `DPoP ${token}` } }),
    ];
    for (const request of bad) {
      expect(await v.verifyRequest(request)).toEqual({ ok: true, value: null });
      expect(v.unauthorized({ resource: MCP, request }).headers.get("www-authenticate")).toBe(
        proofChallenge,
      );
    }
    // A token that is not bound fails as a token, not as a proof.
    const s = await signedIn(server, "bob@example.com");
    const plain = await accessToken(server, s.cookie);
    const request = withDpop(
      TOOLS,
      plain,
      await key.proof(server, { htm: "GET", htu: TOOLS, accessToken: plain }),
    );
    expect(await v.verifyRequest(request)).toEqual({ ok: true, value: null });
    expect(v.unauthorized({ resource: MCP, request }).headers.get("www-authenticate")).toBe(
      `Bearer ${METADATA}, DPoP error="invalid_token", algs="EdDSA Ed25519 ES256 RS256 PS256", ${METADATA}`,
    );
    // A verifier with no dpop option reads no DPoP scheme. It answers the plain challenge
    // with no error code (RFC 6750 section 3.1), as for any method it does not support.
    const bearerOnly = createVerifier({
      issuer: ISSUER,
      resources: [MCP],
      accept: ["oauth"],
      fetch: server.fetch,
      clock: server.clock,
    });
    const good = withDpop(TOOLS, token, await proof());
    expect(await bearerOnly.verifyRequest(good)).toEqual({ ok: true, value: null });
    expect(
      bearerOnly.unauthorized({ resource: MCP, request: good }).headers.get("www-authenticate"),
    ).toBe(`Bearer ${METADATA}`);
  });

  it("sees a replay inside one isolate with the default store, and across two verifiers with a shared store", async () => {
    const server = makeServer();
    const { token, proof } = await bound(server);
    // The default store: one proof, two requests on one verifier.
    const v = verifierOf(server);
    const once = await proof();
    const first = await v.verifyRequest(withDpop(TOOLS, token, once));
    expect(first.ok && first.value?.kind).toBe("oauth");
    const replay = withDpop(TOOLS, token, once);
    expect(await v.verifyRequest(replay)).toEqual({ ok: true, value: null });
    expect(v.unauthorized({ resource: MCP, request: replay }).headers.get("www-authenticate")).toBe(
      `Bearer ${METADATA}, DPoP error="invalid_dpop_proof", algs="EdDSA Ed25519 ES256 RS256 PS256", ${METADATA}`,
    );
    // The limit that the docs state: a second isolate has its own default store.
    const isolate = verifierOf(server);
    const elsewhere = await isolate.verifyRequest(withDpop(TOOLS, token, once));
    expect(elsewhere.ok && elsewhere.value?.kind).toBe("oauth");
    // A shared store sees the replay on a second verifier.
    const replayStore = memoryReplayStore();
    const a = verifierOf(server, { replay: replayStore });
    const b = verifierOf(server, { replay: replayStore });
    const shared = await proof();
    const onA = await a.verifyRequest(withDpop(TOOLS, token, shared));
    expect(onA.ok && onA.value?.kind).toBe("oauth");
    expect(await b.verifyRequest(withDpop(TOOLS, token, shared))).toEqual({
      ok: true,
      value: null,
    });
    // A store that does not answer is a failure, never a pass and never null.
    const down: ReplayStore = {
      seen: async () => {
        throw new Error("the store does not answer");
      },
    };
    const c = verifierOf(server, { replay: down });
    expect(await c.verifyRequest(withDpop(TOOLS, token, await proof()))).toEqual({
      ok: false,
      code: "network",
      status: 0,
    });
  });

  it("keeps at most 10,000 keys in the default store", async () => {
    const store = memoryReplayStore();
    for (let i = 0; i <= 10_000; i++) expect(await store.seen(`k${i}`, 60)).toBe(false);
    // The newest key is kept, and the oldest of the 10,001 is gone.
    expect(await store.seen("k10000", 60)).toBe(true);
    expect(await store.seen("k0", 60)).toBe(false);
    // A key lives for its ttl only.
    const clock = makeClock();
    const timed = memoryReplayStore(10, clock);
    expect(await timed.seen("a", 2)).toBe(false);
    clock.advance(1999);
    expect(await timed.seen("a", 2)).toBe(true);
    clock.advance(1);
    expect(await timed.seen("a", 2)).toBe(false);
  });

  it("refuses an access token with no proof when dpop.required is true", async () => {
    const server = makeServer();
    const { token, proof } = await bound(server);
    const s = await signedIn(server, "bob@example.com");
    const plain = await accessToken(server, s.cookie);
    const v = verifierOf(server, { required: true });
    expect(await v.verifyRequest(withBearer(TOOLS, plain))).toEqual({ ok: true, value: null });
    const r = await v.verifyRequest(withDpop(TOOLS, token, await proof()));
    expect(r.ok && r.value?.kind).toBe("oauth");
    // Without required, the same Bearer token passes.
    const optional = await verifierOf(server).verifyRequest(withBearer(TOOLS, plain));
    expect(optional.ok && optional.value?.kind).toBe("oauth");
  });

  it("takes a proof only in an alg of dpop.algs (RFC 9449 section 4.3 item 5)", async () => {
    const server = makeServer();
    const { token, proof } = await bound(server);
    // The helper key is ES256, so a server of EdDSA alone refuses its proof.
    const eddsa = verifierOf(server, { algs: ["EdDSA"] });
    const request = withDpop(TOOLS, token, await proof());
    expect(await eddsa.verifyRequest(request)).toEqual({ ok: true, value: null });
    expect(eddsa.unauthorized({ request }).headers.get("www-authenticate")).toBe(
      'Bearer, DPoP error="invalid_dpop_proof", algs="EdDSA"',
    );
    const es256 = await verifierOf(server, { algs: ["ES256"] }).verifyRequest(
      withDpop(TOOLS, token, await proof()),
    );
    expect(es256.ok && es256.value?.kind).toBe("oauth");
  });

  it("refuses a proof whose iat is outside dpop.windowSeconds (RFC 9449 section 11.1)", async () => {
    const server = makeServer();
    const { key, token } = await bound(server);
    const old = () =>
      key.proof(server, {
        htm: "GET",
        htu: TOOLS,
        accessToken: token,
        iat: Math.floor(server.clock.now().getTime() / 1000) - 30,
      });
    const short = verifierOf(server, { windowSeconds: 10 });
    expect(await short.verifyRequest(withDpop(TOOLS, token, await old()))).toEqual({
      ok: true,
      value: null,
    });
    // The default window of 60 s takes the same age.
    const wide = await verifierOf(server).verifyRequest(withDpop(TOOLS, token, await old()));
    expect(wide.ok && wide.value?.kind).toBe("oauth");
  });

  it("keeps a spent proof in the store for the whole window", async () => {
    const server = makeServer();
    const { token, proof } = await bound(server);
    const v = verifierOf(server);
    const once = await proof();
    const first = await v.verifyRequest(withDpop(TOOLS, token, once));
    expect(first.ok && first.value?.kind).toBe("oauth");
    // 59 s on, the iat check still passes, so only the store refuses the replay.
    server.clock.advance(59_000);
    expect(await v.verifyRequest(withDpop(TOOLS, token, once))).toEqual({ ok: true, value: null });
  });

  it("reads no session JWT under the DPoP scheme", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    const key = await dpopKey();
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      resources: [MCP],
      accept: ["session-jwt", "oauth"],
      fetch: server.fetch,
      clock: server.clock,
      dpop: {},
    });
    const url = `${FILES}/doc`;
    const proof = await key.proof(server, { htm: "GET", htu: url, accessToken: jwt });
    expect(await v.verifyRequest(withDpop(url, jwt, proof))).toEqual({ ok: true, value: null });
    // The same token as a Bearer passes: the DPoP scheme is for an access token only.
    const bearer = await v.verifyRequest(withBearer(url, jwt));
    expect(bearer.ok && bearer.value?.kind).toBe("session-jwt");
  });

  it("refuses a wrong dpop option at construction", () => {
    const server = makeServer();
    for (const dpop of [
      { algs: [] },
      { algs: ["HS256"] },
      { algs: ["ES256", "ES256"] },
      { windowSeconds: 9 },
      { windowSeconds: 301 },
      { windowSeconds: 60.5 },
    ] as DpopOptions[])
      expect(() => verifierOf(server, dpop), JSON.stringify(dpop)).toThrow(/dpop/);
    expect(() =>
      createVerifier({ issuer: ISSUER, audience: "https://files.example.com", dpop: {} }),
    ).toThrow(/dpop and introspect need oauth/);
    expect(() => memoryReplayStore(0)).toThrow(/max/);
  });
});
