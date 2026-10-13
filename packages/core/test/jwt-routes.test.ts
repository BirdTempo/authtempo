import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { createSession } from "../src/engine/sessions.js";
import { decodeJws } from "../src/primitives/jwk.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth } from "./helpers.js";

/** One storage, clock, and limiter for the engine view and the routes. */
function jwtHandle(extra: Partial<AuthConfig> = {}) {
  const base = makeAuth();
  const auth = createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: base.storage,
    mail: { send: async () => {} },
    clock: base.clock,
    limiter: base.config.limiter,
    ...extra,
  });
  return { ...base, auth };
}

async function signedIn(h: ReturnType<typeof jwtHandle>) {
  const user = await h.seedUser("ada@example.com");
  const { token, session } = await createSession(h.config, {
    userId: user.id,
    ip: null,
    userAgent: null,
  });
  return { user, token, session };
}

type KeySet = { keys: { kid: string; alg: string; use: string; d?: string }[] };

describe("the JWT routes (plan 9g)", () => {
  it("GET /jwks answers the public key set with public caching, and the same kid on a second read", async () => {
    const h = jwtHandle();
    const res = await h.auth.handle(get("/auth/jwks"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = (await res.json()) as KeySet;
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ alg: "EdDSA", use: "sig" });
    expect(body.keys[0]?.d).toBeUndefined();
    const again = (await (await h.auth.handle(get("/auth/jwks"))).json()) as KeySet;
    expect(again.keys[0]?.kid).toBe(body.keys[0]?.kid);
  });

  it("GET /token answers a JWT for a cookie and for a ts_ bearer, whose sid is the session", async () => {
    const h = jwtHandle();
    const s = await signedIn(h);
    for (const headers of [
      { cookie: `tempo_session=${s.token}` },
      { authorization: `Bearer ${s.token}` },
    ]) {
      const res = await h.auth.handle(get("/auth/token", headers));
      expect(res.status).toBe(200);
      const { token } = (await res.json()) as { token: string };
      expect(decodeJws(token)?.payload).toMatchObject({
        sub: s.user.id,
        sid: s.session.id,
        iss: `${BASE_URL}/auth`,
      });
      expect((await h.auth.api.jwt?.verify(token))?.sub).toBe(s.user.id);
    }
  });

  it("GET /token answers 401 with no session, with a tk_ bearer, and with a JWT bearer", async () => {
    const h = jwtHandle();
    const s = await signedIn(h);
    const tk = await h.auth.api.tokens.create({ user: s.user, name: "ci" });
    if (!tk.ok) throw new Error(tk.code);
    const jwt = await h.auth.api.jwt?.mint({ userId: s.user.id, sessionId: s.session.id });
    if (!jwt?.ok) throw new Error("no mint");
    for (const headers of [
      {},
      { authorization: `Bearer ${tk.value.token}` },
      { authorization: `Bearer ${jwt.value.token}` },
    ])
      expect((await h.auth.handle(get("/auth/token", headers))).status).toBe(401);
  });

  it("rotate through api.jwt: the JWKS lists the new key first and the old one after it", async () => {
    const h = jwtHandle();
    const first = ((await (await h.auth.handle(get("/auth/jwks"))).json()) as KeySet).keys[0]?.kid;
    const rotated = await h.auth.api.jwt?.rotate();
    const after = ((await (await h.auth.handle(get("/auth/jwks"))).json()) as KeySet).keys.map(
      (k) => k.kid,
    );
    expect(after).toEqual([rotated?.kid, first]);
    expect((await h.auth.api.jwt?.jwks())?.keys.map((k) => k.kid)).toEqual(after);
  });

  it("answers 404 on /jwks and /token with jwtMint: false, and api.jwt is absent", async () => {
    const h = jwtHandle({ jwtMint: false });
    for (const path of ["/auth/jwks", "/auth/token"])
      expect({ path, status: (await h.auth.handle(get(path))).status }).toEqual({
        path,
        status: 404,
      });
    expect(h.auth.api.jwt).toBeUndefined();
    expect(jwtHandle().auth.api.jwt).toBeDefined();
  });
});
