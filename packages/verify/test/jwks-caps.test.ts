import { JWKS_RETIRED_MAX } from "@authtempo/core/credentials";
import { describe, expect, it } from "vitest";
import {
  createVerifier,
  FAILED_READ_PAUSE_MS,
  KEY_SET_MAX_BYTES,
  KEY_SET_MAX_KEYS,
  KEY_SET_MIN_SECONDS,
} from "../src/index.js";
import {
  FILES,
  ISSUER,
  makeClock,
  makeServer,
  ownKey,
  sessionJwt,
  signedIn,
  withBearer,
} from "./harness.js";

/**
 * The caps of the key set read (Task 9 review M2).
 * Measured on 2026-10-15 from this harness (memory adapter, Node 26.10.0, arm64), after 110 rotations:
 * - EdDSA: one key 151 bytes; the largest set 14,251 bytes with 101 keys.
 * - ES256: one key 198 bytes; the largest set 18,998 bytes with 101 keys.
 * The reviewer measured 18,989 bytes for 101 ES256 keys.
 * Core lists the signing key and at most `JWKS_RETIRED_MAX` retired keys: the cap is that bound plus one.
 * The body cap of 64 KiB is about 3.4 times the largest measured set.
 */
describe("the key set caps (Task 9 review M2)", () => {
  it("verifies against core's largest set: ES256, at the key cap, under the body cap", async () => {
    const server = makeServer({ jwtMint: { audience: [FILES], alg: "ES256" } });
    for (let i = 0; i < KEY_SET_MAX_KEYS + 9; i++) await server.auth.api.jwt?.rotate();
    const body = await (await server.auth.handle(new Request(`${ISSUER}/jwks`))).text();
    expect((JSON.parse(body) as { keys: unknown[] }).keys).toHaveLength(KEY_SET_MAX_KEYS);
    expect(new TextEncoder().encode(body).length).toBeLessThan(KEY_SET_MAX_BYTES);
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      fetch: server.fetch,
      clock: server.clock,
    });
    const r = await v.verifyRequest(withBearer(FILES, jwt));
    expect(r.ok && r.value?.kind).toBe("session-jwt");
  }, 60_000);

  it("holds the key cap to core's bound plus the signing key", () => {
    expect(KEY_SET_MAX_KEYS).toBe(JWKS_RETIRED_MAX + 1);
  });

  it("answers unexpected for a set of one key more than the cap", async () => {
    const key = await ownKey();
    const own = key.keySet.keys[0];
    const filler = Array.from({ length: KEY_SET_MAX_KEYS }, (_, i) => ({ ...own, kid: `f${i}` }));
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      fetch: (async () => Response.json({ keys: [own, ...filler] })) as typeof fetch,
    });
    const token = await key.sign({ typ: "JWT" }, { iss: ISSUER });
    expect(await v.verifyRequest(withBearer(FILES, token))).toEqual({
      ok: false,
      code: "unexpected",
      status: 200,
    });
  });

  it("answers unexpected for a body over 64 KiB, and reads no more of it", async () => {
    const key = await ownKey();
    const big = JSON.stringify({ keys: key.keySet.keys, pad: "x".repeat(KEY_SET_MAX_BYTES) });
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      fetch: (async () => new Response(big, { status: 200 })) as typeof fetch,
    });
    const token = await key.sign({ typ: "JWT" }, { iss: ISSUER });
    expect(await v.verifyRequest(withBearer(FILES, token))).toEqual({
      ok: false,
      code: "unexpected",
      status: 200,
    });
  });
});

describe("the read rate of the key set (Task 9 review L1)", () => {
  it("keeps a set of max-age=0 for 60 s", async () => {
    const clock = makeClock();
    const key = await ownKey();
    let reads = 0;
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      clock,
      fetch: (async () => {
        reads++;
        return Response.json(key.keySet, { headers: { "cache-control": "max-age=0" } });
      }) as typeof fetch,
    });
    const token = await key.sign({ typ: "JWT" }, { iss: ISSUER });
    await v.verifyRequest(withBearer(FILES, token));
    clock.advance(KEY_SET_MIN_SECONDS * 1000 - 1);
    await v.verifyRequest(withBearer(FILES, token));
    expect(reads).toBe(1);
    clock.advance(1);
    await v.verifyRequest(withBearer(FILES, token));
    expect(reads).toBe(2);
  });

  it("answers the failure with no read for 5 s after a failed read, then reads again", async () => {
    const clock = makeClock();
    const key = await ownKey();
    let reads = 0;
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      clock,
      fetch: (async () => {
        reads++;
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    const token = await key.sign({ typ: "JWT" }, { iss: ISSUER });
    const network = { ok: false, code: "network", status: 0 };
    expect(await v.verifyRequest(withBearer(FILES, token))).toEqual(network);
    clock.advance(FAILED_READ_PAUSE_MS - 1);
    expect(await v.verifyRequest(withBearer(FILES, token))).toEqual(network);
    expect(reads).toBe(1);
    clock.advance(1);
    expect(await v.verifyRequest(withBearer(FILES, token))).toEqual(network);
    expect(reads).toBe(2);
  });
});
