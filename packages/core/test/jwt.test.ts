import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  mintSessionJwt,
  publicKeySet,
  rotateKey,
  signToken,
  verifyLocal,
  verifySessionJwt,
} from "../src/engine/jwt.js";
import { createSession } from "../src/engine/sessions.js";
import { decodeJws } from "../src/primitives/jwk.js";
import { makeAuth } from "./helpers.js";

type Auth = ReturnType<typeof makeAuth>;
const ISSUER = "https://api.example.com/auth";
const DAY = 86_400_000;

async function sessionOf(auth: Auth, email = "ada@example.com", org: string | null = null) {
  const user = await auth.seedUser(email);
  const { session } = await createSession(auth.config, {
    userId: user.id,
    ip: null,
    userAgent: null,
    activeOrganizationId: org,
  });
  return { user, session };
}

async function minted(auth: Auth, input: { userId: string; sessionId: string }) {
  const r = await mintSessionJwt(auth.config, input);
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

const header = (token: string) => decodeJws(token)?.header;

/** A second engine view on the same storage and clock, with other options. */
const sameStore = (auth: Auth, extra: Parameters<typeof makeAuth>[0]) =>
  makeAuth({ storage: auth.storage, clock: auth.clock, limiter: auth.config.limiter, ...extra });

describe("the signing key (plan 9g)", () => {
  it("writes one signing key at the first JWKS read, and two first reads at once leave one row", async () => {
    const auth = makeAuth();
    expect(await auth.storage.findMany("jwk", [])).toEqual([]);
    const [a, b] = await Promise.all([publicKeySet(auth.config), publicKeySet(auth.config)]);
    const rows = await auth.storage.findMany("jwk", []);
    expect(rows).toHaveLength(1);
    expect(a.keys.map((k) => k.kid)).toEqual([rows[0]?.id]);
    expect(b.keys.map((k) => k.kid)).toEqual([rows[0]?.id]);
    expect(a.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });
    expect(rows[0]).toMatchObject({ slot: "signing", retiredAt: null });
    expect(rows[0]?.publicJwk).not.toHaveProperty("d");
  });

  it("rotate retires the old key: it verifies for 24 hours, signs nothing, and then fails (Review Focus 4)", async () => {
    const auth = makeAuth();
    const { user, session } = await sessionOf(auth);
    const old = await minted(auth, { userId: user.id, sessionId: session.id });
    const oldKid = header(old.token)?.kid;
    const { kid } = await rotateKey(auth.config);
    expect(kid).not.toBe(oldKid);
    const fresh = await minted(auth, { userId: user.id, sessionId: session.id });
    expect(header(fresh.token)?.kid).toBe(kid);
    expect((await publicKeySet(auth.config)).keys.map((k) => k.kid)).toEqual([kid, oldKid]);
    expect(await verifySessionJwt(auth.config, old.token)).not.toBeNull();
    auth.clock.advance(DAY - 1);
    expect(await verifyLocal(auth.config, old.token)).not.toBeNull();
    auth.clock.advance(1);
    expect(await verifyLocal(auth.config, old.token)).toBeNull();
    expect((await publicKeySet(auth.config)).keys.map((k) => k.kid)).toEqual([kid]);
    expect(await verifyLocal(auth.config, fresh.token)).not.toBeNull();
  });

  it("retires an EdDSA key when the config moves to ES256, and the old token still verifies", async () => {
    // No log line: the alg check retires the key, not the fallback for a key that does not open.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = makeAuth();
    const { user, session } = await sessionOf(auth);
    const ed = await minted(auth, { userId: user.id, sessionId: session.id });
    const es = sameStore(auth, { jwtMint: { alg: "ES256" } });
    const r = await mintSessionJwt(es.config, { userId: user.id, sessionId: session.id });
    if (!r.ok) throw new Error(r.code);
    expect(header(r.value.token)?.alg).toBe("ES256");
    expect((await publicKeySet(es.config)).keys.map((k) => k.alg)).toEqual(["ES256", "EdDSA"]);
    expect(await verifySessionJwt(es.config, ed.token)).not.toBeNull();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("retires a key sealed under another app secret at the next signature, with one log line, and signs with a new key", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = makeAuth();
    const { user, session } = await sessionOf(auth);
    const before = await minted(auth, { userId: user.id, sessionId: session.id });
    const moved = sameStore(auth, { secret: "another secret of 32 characters!" });
    const r = await mintSessionJwt(moved.config, { userId: user.id, sessionId: session.id });
    if (!r.ok) throw new Error(r.code);
    expect(header(r.value.token)?.kid).not.toBe(header(before.token)?.kid);
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});

describe("the session JWT (plan 9g)", () => {
  it("mints the session and user claims for 15 minutes by the injected clock, and jose verifies it against the JWKS", async () => {
    const auth = makeAuth();
    const { user, session } = await sessionOf(auth);
    const now = auth.clock.now();
    const t = await minted(auth, { userId: user.id, sessionId: session.id });
    const iat = Math.floor(now.getTime() / 1000);
    expect(t.expiresAt).toEqual(new Date((iat + 900) * 1000));
    expect(await verifySessionJwt(auth.config, t.token)).toEqual({
      iss: ISSUER,
      sub: user.id,
      aud: "https://api.example.com",
      iat,
      exp: iat + 900,
      sid: session.id,
      email: "ada@example.com",
      email_verified: true,
      name: null,
      org: null,
    });
    expect(header(t.token)).toEqual({ alg: "EdDSA", kid: expect.any(String), typ: "JWT" });
    const { payload } = await jwtVerify(
      t.token,
      createLocalJWKSet(await publicKeySet(auth.config)),
      {
        issuer: ISSUER,
        audience: "https://api.example.com",
        currentDate: now,
      },
    );
    expect(payload.sub).toBe(user.id);
  });

  it("carries the active organization as org", async () => {
    const auth = makeAuth();
    const { user, session } = await sessionOf(auth, "ada@example.com", "org-1");
    const t = await minted(auth, { userId: user.id, sessionId: session.id });
    expect((await verifySessionJwt(auth.config, t.token))?.org).toBe("org-1");
  });

  it("adds the app's claims and lets them set no reserved name", async () => {
    const seen: string[] = [];
    const auth = makeAuth({
      jwtMint: {
        claims: (user, session) => {
          seen.push(`${user.id}:${session.id}`);
          return {
            role: "admin",
            sub: "evil",
            iss: "evil",
            org: "evil",
            email: "evil@example.com",
            exp: 1,
            nbf: 1,
            jti: "evil",
          };
        },
      },
    });
    const { user, session } = await sessionOf(auth);
    const t = await minted(auth, { userId: user.id, sessionId: session.id });
    const claims = await verifySessionJwt(auth.config, t.token);
    expect(claims).toMatchObject({
      role: "admin",
      sub: user.id,
      iss: ISSUER,
      org: null,
      email: "ada@example.com",
    });
    expect(claims?.exp).toBeGreaterThan(1);
    expect(claims?.nbf).toBeUndefined();
    expect(claims?.jti).toBeUndefined();
    expect(seen).toEqual([`${user.id}:${session.id}`]);
  });

  it("answers hook_failed with one log line when claims throws or answers no object, and writes no key", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = [
      () => {
        throw new Error("boom");
      },
      () => [1] as unknown as Record<string, unknown>,
    ];
    for (const claims of bad) {
      const auth = makeAuth({ jwtMint: { claims } });
      const { user, session } = await sessionOf(auth);
      expect(await mintSessionJwt(auth.config, { userId: user.id, sessionId: session.id })).toEqual(
        {
          ok: false,
          code: "hook_failed",
          status: 500,
        },
      );
      expect(await auth.storage.findMany("jwk", [])).toEqual([]);
    }
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it("answers unauthorized for an unknown session, another user's session, and an expired session", async () => {
    const auth = makeAuth();
    const ada = await sessionOf(auth);
    const bea = await sessionOf(auth, "bea@example.com");
    const no = { ok: false, code: "unauthorized", status: 401 };
    expect(await mintSessionJwt(auth.config, { userId: ada.user.id, sessionId: "nope" })).toEqual(
      no,
    );
    expect(
      await mintSessionJwt(auth.config, { userId: ada.user.id, sessionId: bea.session.id }),
    ).toEqual(no);
    auth.clock.advance(31 * DAY);
    expect(
      await mintSessionJwt(auth.config, { userId: ada.user.id, sessionId: ada.session.id }),
    ).toEqual(no);
  });

  it("verify answers null after exp, for another audience, on another instance, and for another typ", async () => {
    const auth = makeAuth();
    const { user, session } = await sessionOf(auth);
    const t = await minted(auth, { userId: user.id, sessionId: session.id });
    const other = sameStore(auth, { jwtMint: { audience: "https://other.example.com" } });
    expect(await verifySessionJwt(other.config, t.token)).toBeNull();
    expect(await verifySessionJwt(makeAuth().config, t.token)).toBeNull();
    const asAccess = await signToken(auth.config, "at+jwt", {
      iss: ISSUER,
      sub: user.id,
      aud: "https://api.example.com",
      iat: 0,
      exp: 4_000_000_000,
      sid: session.id,
    });
    expect(await verifySessionJwt(auth.config, asAccess)).toBeNull();
    auth.clock.advance(15 * 60_000);
    expect(await verifySessionJwt(auth.config, t.token)).toBeNull();
  });
});
