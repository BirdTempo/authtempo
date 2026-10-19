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

/** A core instance that signs every token with RS256 (plan 12e, owner decision 1). */
const rsServer = () => makeServer({ jwtMint: { alg: "RS256", audience: [FILES] } });

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

describe("RS256 keys in the verifier (plan 12e)", () => {
  it("verifies an RS256 session JWT and access token offline", async () => {
    const server = rsServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    const at = await accessToken(server, s.cookie, "openid");
    const keys = (await (await server.fetch(`${ISSUER}/jwks`)).json()) as {
      keys: Record<string, unknown>[];
    };
    expect(keys.keys.map((k) => [k.kty, k.alg])).toEqual([["RSA", "RS256"]]);
    expect(publicKeyOf(keys.keys[0])).toEqual(keys.keys[0]);
    const before = server.count("/auth/jwks");
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      resources: [MCP],
      accept: ["session-jwt", "oauth"],
      fetch: server.fetch,
      clock: server.clock,
    });
    const bySession = await v.verifyRequest(withBearer(`${FILES}/doc`, jwt));
    expect(bySession.ok && bySession.value?.kind).toBe("session-jwt");
    const byOauth = await v.verifyRequest(withBearer(`${MCP}/tools/list`, at));
    expect(byOauth.ok && byOauth.value?.kind).toBe("oauth");
    // Offline: one key set read, and no call to a session or live route.
    expect(server.count("/auth/jwks") - before).toBe(1);
    expect(server.count("/auth/session")).toBe(0);
    expect(server.count("/auth/token/live")).toBe(0);
  });

  it("refuses an RSA key with a private member in the key set", async () => {
    const server = rsServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    for (const member of ["d", "p", "q", "dp", "dq", "qi"]) {
      const v = createVerifier({
        issuer: ISSUER,
        audience: FILES,
        clock: server.clock,
        fetch: editedKeys(server, (keys) => keys.map((k) => ({ ...k, [member]: "AQAB" }))),
      });
      expect({ member, answer: await v.verifyRequest(withBearer(FILES, jwt)) }).toEqual({
        member,
        answer: { ok: true, value: null },
      });
    }
    // The same key with no private member verifies: the member is the cause.
    const v = createVerifier({
      issuer: ISSUER,
      audience: FILES,
      clock: server.clock,
      fetch: editedKeys(server, (keys) => keys),
    });
    const r = await v.verifyRequest(withBearer(FILES, jwt));
    expect(r.ok && r.value?.kind).toBe("session-jwt");
  });
});
