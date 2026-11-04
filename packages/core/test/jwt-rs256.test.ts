import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import { publicKeySet, signToken, verifyLocal } from "../src/engine/jwt.js";
import { sha256Hex, toBase64Url } from "../src/primitives/crypto.js";
import { decodeJws } from "../src/primitives/jwk.js";
import { BASE_URL, get, makeAuth, sessionFor } from "./helpers.js";
import { codeFor, exchange, ISSUER, oauthHandle, RESOURCE, signedIn } from "./oauth-helpers.js";

const DAY = 86_400_000;
const OPERATOR_SECRET = "operator-secret-0123456789abcdef-0123456789";
const RS256 = { jwtMint: { alg: "RS256" as const } };

const headerOf = (token: string) => decodeJws(token)?.header;
const kidOf = (token: string) => decodeJws(token)?.header.kid;

describe("jwtMint.alg RS256 (plan 12e, owner decision 1)", () => {
  it("signs every token kind with RS256 when jwtMint.alg is RS256", async () => {
    const h = oauthHandle(RS256);
    const c = await codeFor(h, "openid mcp:read", { nonce: "n-1" });
    const res = await h.auth.handle(get("/auth/token", { cookie: c.cookie }));
    expect(res.status).toBe(200);
    const { token: sessionJwt } = (await res.json()) as { token: string };
    const done = await h.auth.handle(exchange(c.code, c.clientId, c.verifier));
    expect(done.status).toBe(200);
    const t = (await done.json()) as { access_token: string; id_token: string };
    const keys = createLocalJWKSet(await publicKeySet(h.config));
    const currentDate = h.clock.now();
    for (const [kind, token] of [
      ["session JWT", sessionJwt],
      ["access token", t.access_token],
      ["ID token", t.id_token],
    ] as const) {
      expect({ kind, alg: headerOf(token)?.alg }).toEqual({ kind, alg: "RS256" });
      const { protectedHeader } = await jwtVerify(token, keys, { issuer: ISSUER, currentDate });
      expect({ kind, alg: protectedHeader.alg }).toEqual({ kind, alg: "RS256" });
    }
    // OIDC Core 3.1.3.6: under RS256 the at_hash is the left half of SHA-256 of the access token.
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t.access_token)),
    );
    const atHash = toBase64Url(digest.slice(0, 16));
    expect(atHash).toHaveLength(22);
    expect(decodeJws(t.id_token)?.payload.at_hash).toBe(atHash);
    // The access token still routes by its JWS shape, as kind oauth (plan 12e deviation 2).
    const bearer = { authorization: `Bearer ${t.access_token}` };
    expect(await h.auth.caller(get("/mcp", bearer))).toMatchObject({
      kind: "oauth",
      resource: RESOURCE,
    });
  });

  it("retires an EdDSA key at the first RS256 signature", async () => {
    const auth = makeAuth();
    const old = await signToken(auth.config, "JWT", { sub: "u" });
    expect(headerOf(old)?.alg).toBe("EdDSA");
    const rs = makeAuth({ ...RS256, storage: auth.storage, clock: auth.clock });
    const next = await signToken(rs.config, "JWT", { sub: "u" });
    expect(headerOf(next)?.alg).toBe("RS256");
    const set = await publicKeySet(rs.config);
    expect(set.keys.map((k) => [k.kid, k.alg])).toEqual([
      [kidOf(next), "RS256"],
      [kidOf(old), "EdDSA"],
    ]);
    expect(await verifyLocal(rs.config, old)).not.toBeNull();
    auth.clock.advance(DAY - 1);
    expect(await verifyLocal(rs.config, old)).not.toBeNull();
    auth.clock.advance(1);
    expect(await verifyLocal(rs.config, old)).toBeNull();
    expect(await verifyLocal(rs.config, next)).not.toBeNull();
  });

  it("rotates an RS256 key by api.jwt.rotate, rotateEvery, and the operator route", async () => {
    const h = oauthHandle({
      jwtMint: { alg: "RS256", rotateEvery: 1 },
      operator: { secretHash: await sha256Hex(OPERATOR_SECRET) },
    });
    const kids = async () => (await publicKeySet(h.config)).keys.map((k) => [k.kid, k.kty]);
    const sign = () => signToken(h.config, "JWT", { sub: "u" });
    const first = kidOf(await sign());
    // 1. api.jwt.rotate.
    const byApi = await h.auth.api.jwt?.rotate();
    if (!byApi) throw new Error("jwtMint is off");
    expect(await kids()).toEqual([
      [byApi.kid, "RSA"],
      [first, "RSA"],
    ]);
    // 2. The operator route. One second later, so no two keys retire at the same instant.
    h.clock.advance(1000);
    const res = await h.auth.handle(
      new Request(`${BASE_URL}/auth/operator/keys/rotate`, {
        method: "POST",
        headers: {
          authorization: `Operator ${OPERATOR_SECRET}`,
          "cf-connecting-ip": "203.0.113.7",
        },
      }),
    );
    expect(res.status).toBe(200);
    const byRoute = (await res.json()) as { kid: string };
    expect(await kids()).toEqual([
      [byRoute.kid, "RSA"],
      [byApi.kid, "RSA"],
      [first, "RSA"],
    ]);
    // 3. rotateEvery: one day later the next signature rotates, and the other keys age out.
    h.clock.advance(DAY);
    const byTimer = kidOf(await sign());
    expect(byTimer).not.toBe(byRoute.kid);
    expect(await kids()).toEqual([
      [byTimer, "RSA"],
      [byRoute.kid, "RSA"],
    ]);
    h.clock.advance(DAY);
    expect(await kids()).toEqual([[byTimer, "RSA"]]);
  });

  it("keeps a tk_ API token as an opaque token under RS256", async () => {
    const h = oauthHandle(RS256);
    const s = await signedIn(h);
    const created = await h.auth.api.tokens.create({
      session: await sessionFor(h.config, s.user),
      name: "ci",
    });
    if (!created.ok) throw new Error(created.code);
    expect(created.value.token.startsWith("tk_")).toBe(true);
    expect(created.value.token).not.toContain(".");
    const caller = await h.auth.caller(
      get("/auth/anything", { authorization: `Bearer ${created.value.token}` }),
    );
    expect(caller).toMatchObject({ kind: "token", user: { id: s.user.id } });
  });

  it("lists RS256 alone in the discovery alg list", async () => {
    const h = oauthHandle(RS256);
    for (const path of [
      "/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server",
    ]) {
      const res = await h.auth.wellKnown(new Request(`${BASE_URL}${path}`));
      const body = (await res.json()) as Record<string, unknown>;
      expect({ path, algs: body.id_token_signing_alg_values_supported }).toEqual({
        path,
        algs: ["RS256"],
      });
    }
  });

  it("refuses an alg outside the three", () => {
    for (const alg of ["RS512", "PS256", "HS256", "none"]) {
      // `as never`: the type refuses each value; the run-time check is the subject.
      const run = () => makeAuth({ jwtMint: { alg: alg as never } });
      expect(run).toThrow(ConfigError);
      expect(run).toThrow("jwtMint.alg must be EdDSA, ES256, or RS256");
    }
    for (const alg of ["EdDSA", "ES256", "RS256"] as const)
      expect(makeAuth({ jwtMint: { alg } }).config.jwtMint?.alg).toBe(alg);
  });
});
