import { describe, expect, it } from "vitest";
import { createVerifier, UNKNOWN_KID_EVERY_MS } from "../src/index.js";
import { FILES, ISSUER, makeServer, sessionJwt, signedIn, withBearer } from "./harness.js";

async function setup() {
  const server = makeServer();
  const s = await signedIn(server);
  const v = createVerifier({
    issuer: ISSUER,
    audience: FILES,
    fetch: server.fetch,
    clock: server.clock,
  });
  const jwt = () => sessionJwt(server, s.sessionToken);
  const rotate = async () => {
    const r = await server.auth.api.jwt?.rotate();
    if (!r) throw new Error("jwtMint is off");
  };
  return { server, v, jwt, rotate };
}

describe("the key cache (plan 11d)", () => {
  it("keeps the key set for the max-age of its answer, then reads it again", async () => {
    const { server, v, jwt } = await setup();
    const token = await jwt();
    await v.verifyRequest(withBearer(FILES, token));
    server.clock.advance(299_000);
    await v.verifyRequest(withBearer(FILES, token));
    expect(server.count("/auth/jwks")).toBe(1);
    server.clock.advance(1_000);
    await v.verifyRequest(withBearer(FILES, token));
    expect(server.count("/auth/jwks")).toBe(2);
  });

  it("reads the key set again once at an unknown kid, then not for 30 seconds (Review Focus 1)", async () => {
    const { server, v, jwt, rotate } = await setup();
    await v.verifyRequest(withBearer(FILES, await jwt()));
    server.clock.advance(60_000);
    await rotate();
    const second = await jwt();
    expect((await v.verifyRequest(withBearer(FILES, second))).ok).toBe(true);
    const r = await v.verifyRequest(withBearer(FILES, second));
    expect(r.ok && r.value?.kind).toBe("session-jwt");
    expect(server.count("/auth/jwks")).toBe(2);
    await rotate();
    const third = await jwt();
    expect(await v.verifyRequest(withBearer(FILES, third))).toEqual({ ok: true, value: null });
    expect(server.count("/auth/jwks")).toBe(2);
    server.clock.advance(UNKNOWN_KID_EVERY_MS);
    const late = await v.verifyRequest(withBearer(FILES, third));
    expect(late.ok && late.value?.kind).toBe("session-jwt");
    expect(server.count("/auth/jwks")).toBe(3);
  });

  it("verifies a token of a retired key while core lists the key, inside its 24 hours", async () => {
    const { server, v, jwt, rotate } = await setup();
    const old = await jwt();
    await rotate();
    server.clock.advance(301_000);
    const r = await v.verifyRequest(withBearer(FILES, old));
    expect(r.ok && r.value?.kind).toBe("session-jwt");
    // After 24 hours core's set lacks the key; the token expired long before.
    server.clock.advance(86_400_000);
    expect(await v.verifyRequest(withBearer(FILES, old))).toEqual({ ok: true, value: null });
    const keys = (await (await server.auth.handle(new Request(`${ISSUER}/jwks`))).json()) as {
      keys: { kid: string }[];
    };
    expect(keys.keys).toHaveLength(1);
  });

  it("answers network, not null, when the key set does not answer (Review Focus 2)", async () => {
    const { server, v, jwt } = await setup();
    const token = await jwt();
    server.outage("/jwks");
    expect(await v.verifyRequest(withBearer(FILES, token))).toEqual({
      ok: false,
      code: "network",
      status: 0,
    });
    server.outage(null);
    expect((await v.verifyRequest(withBearer(FILES, token))).ok).toBe(true);
  });

  it("answers unexpected for a key set that is not JSON, with the status", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const token = await sessionJwt(server, s.sessionToken);
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      clock: server.clock,
      fetch: (async () => new Response("<html>", { status: 502 })) as typeof fetch,
    });
    expect(await v.verifyRequest(withBearer(FILES, token))).toEqual({
      ok: false,
      code: "unexpected",
      status: 502,
    });
  });

  it("reads the key set once for a burst of verifies at the start", async () => {
    const { server, v, jwt } = await setup();
    const token = await jwt();
    await Promise.all(Array.from({ length: 10 }, () => v.verifyRequest(withBearer(FILES, token))));
    expect(server.count("/auth/jwks")).toBe(1);
  });
});
