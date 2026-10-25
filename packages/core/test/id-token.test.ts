import { decodeJwt, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { type AuthConfig, resolveConfig } from "../src/config.js";
import type { AnonymousLinkEvent } from "../src/engine/hooks.js";
import { hookRefusal } from "../src/engine/hooks.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { completeSocial, startSocial } from "../src/engine/social.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { JwtSeam } from "../src/seams/jwt.js";
import { APP_ORIGIN, BASE_URL, makeAuth, post, recordCredential, settled } from "./helpers.js";
import { fakeFetch } from "./social-helpers.js";
import { EMAIL, enrolled, totpAuth } from "./totp-helpers.js";

/**
 * The ID-token route (plan 12i Task 10, spec 32 item 10). Each token is
 * signed by a test key, and the key set is served through `social.fetch`
 * at the provider's JWKS URL, so core's own jose seam verifies it. No real
 * provider and no real key set is called.
 */

const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const APPLE_JWKS = "https://appleid.apple.com/auth/keys";
const GOOGLE_ISS = "https://accounts.google.com";
const APPLE_ISS = "https://appleid.apple.com";
const WEB = "web-client.apps.googleusercontent.com";
const ANDROID = "android-client.apps.googleusercontent.com";
const IOS = "ios-client.apps.googleusercontent.com";
const APPLE_WEB = "com.example.web";
const APPLE_APP = "com.example.ios";

type Alg = "RS256" | "ES256" | "PS256";
type Claims = Record<string, unknown>;

/** One key pair per alg, with its public JWK under the kid of its alg. */
async function keyRing() {
  const ring = new Map<Alg, { privateKey: CryptoKey; jwk: JWK }>();
  for (const alg of ["RS256", "ES256", "PS256"] as const) {
    const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
    ring.set(alg, {
      privateKey,
      jwk: { ...(await exportJWK(publicKey)), kid: `k-${alg}`, alg, use: "sig" },
    });
  }
  return ring;
}
const RING = await keyRing();

let n = 0;
/** A new client IP, so no per-IP limit decides a test. Core reads `cf-connecting-ip`. */
const ip = () => ({ "cf-connecting-ip": `203.0.113.${(++n % 250) + 1}` });

/** Google and Apple with the route on, a key set at each JWKS URL, and the router. */
function world(
  extra: Partial<AuthConfig> = {},
  social: Partial<NonNullable<AuthConfig["social"]>> = {},
) {
  const keys = [...RING.values()].map((k) => k.jwk);
  const f = fakeFetch((call) =>
    call.url === GOOGLE_JWKS || call.url === APPLE_JWKS
      ? Response.json({ keys })
      : new Response("not found", { status: 404 }),
  );
  const socialConfig: NonNullable<AuthConfig["social"]> = {
    google: { clientId: WEB, clientSecret: "g-secret", audiences: [ANDROID, IOS] },
    apple: {
      clientId: APPLE_WEB,
      teamId: "TEAM1",
      keyId: "KEY1",
      privateKey: "pem",
      audiences: [APPLE_APP],
    },
    fetch: f.fetchFn,
    ...social,
  };
  const auth = makeAuth({ social: socialConfig, ...extra });
  /** A second createAuth instance on the same store and clock: another isolate. */
  function isolate() {
    const config = resolveConfig({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: auth.storage,
      mail: { send: async () => {} },
      clock: auth.clock,
      social: socialConfig,
    });
    return settled(createRouter(config, coreRoutes(config)));
  }
  const handle = settled(createRouter(auth.config, coreRoutes(auth.config)));
  const nowSeconds = () => Math.floor(auth.clock.now().getTime() / 1000);
  /** A signed token. Each call has a new jti, so two calls are two tokens. */
  async function sign(claims: Claims, alg: Alg = "RS256"): Promise<string> {
    const key = RING.get(alg);
    if (!key) throw new Error(alg);
    const iat = nowSeconds();
    const token = await new SignJWT({ iat, exp: iat + 3600, jti: `j${++n}`, ...claims })
      .setProtectedHeader({ alg, kid: `k-${alg}` })
      .sign(key.privateKey);
    return recordCredential(token);
  }
  const google = (claims: Claims = {}, alg: Alg = "RS256") =>
    sign(
      {
        iss: GOOGLE_ISS,
        aud: WEB,
        sub: "g-1",
        email: "ada@example.com",
        email_verified: true,
        name: "Ada",
        ...claims,
      },
      alg,
    );
  const apple = (claims: Claims = {}, alg: Alg = "RS256") =>
    sign({ iss: APPLE_ISS, aud: APPLE_APP, sub: "a-1", email: "ada@icloud.com", ...claims }, alg);
  async function nonce(provider = "google", headers = ip()): Promise<string> {
    const res = await handle(post(`/auth/social/${provider}/id-token/nonce`, {}, headers));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nonce: string; providerNonce: string; expiresAt: string };
    expect(body.providerNonce).toBe(await sha256Hex(body.nonce));
    return recordCredential(body.nonce);
  }
  function signIn(provider: string, body: Claims, headers: Record<string, string> = ip()) {
    return handle(post(`/auth/social/${provider}/id-token`, body, headers));
  }
  return { ...auth, handle, isolate, google, apple, nonce, signIn, calls: f.calls };
}
type World = ReturnType<typeof world>;

async function code(res: Response): Promise<string | undefined> {
  return ((await res.clone().json()) as { error?: string }).error;
}

/** The value that the app gives the provider: the SHA-256 hex of the raw nonce (ruling 37 I1). */
const hashOf = (nonce: string) => sha256Hex(nonce);

/** A Google sign-in with a fresh nonce: the answer. */
async function googleIn(w: World, claims: Claims = {}) {
  const nonce = await w.nonce("google");
  return w.signIn("google", {
    idToken: await w.google({ nonce: await hashOf(nonce), ...claims }),
    nonce,
  });
}

describe("the ID-token route (plan 12i Task 10)", () => {
  it("spends the nonce once", async () => {
    const w = world();
    const nonce = await w.nonce("google");
    const first = await w.signIn("google", {
      idToken: await w.google({ nonce: await hashOf(nonce) }),
      nonce,
    });
    expect(first.status).toBe(200);
    // A second token that carries the same nonce: a new jti, so no used-token row decides it.
    const second = await w.signIn("google", {
      idToken: await w.google({ nonce: await hashOf(nonce) }),
      nonce,
    });
    expect(second.status).toBe(400);
    expect(await code(second)).toBe("invalid_token");
    // The nonce row holds the hash, never the nonce.
    const rows = await w.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "id-token-nonce" },
    ]);
    expect(rows.map((r) => r.valueHash)).toEqual([await sha256Hex(nonce)]);
  });

  it("refuses a missing, expired, or unknown nonce with requireNonce", async () => {
    const w = world();
    // No nonce in the body.
    const missing = await w.signIn("google", { idToken: await w.google() });
    expect(await code(missing)).toBe("invalid_token");
    // A nonce of 5 minutes and one second ago.
    const old = await w.nonce("google");
    w.clock.advance(5 * 60_000 + 1000);
    const expired = await w.signIn("google", {
      idToken: await w.google({ nonce: await hashOf(old) }),
      nonce: old,
    });
    expect(await code(expired)).toBe("invalid_token");
    // A nonce that core never made.
    const unknown = "A".repeat(43);
    const res = await w.signIn("google", {
      idToken: await w.google({ nonce: await hashOf(unknown) }),
      nonce: unknown,
    });
    expect(await code(res)).toBe("invalid_token");
    // A nonce of the other provider.
    const appleNonce = await w.nonce("apple");
    const other = await w.signIn("google", {
      idToken: await w.google({ nonce: await hashOf(appleNonce) }),
      nonce: appleNonce,
    });
    expect(await code(other)).toBe("invalid_token");
    // A live nonce, and a token with no nonce claim.
    const live = await w.nonce("google");
    const noClaim = await w.signIn("google", { idToken: await w.google(), nonce: live });
    expect(await code(noClaim)).toBe("invalid_token");
    expect(await w.storage.findMany("session", [])).toEqual([]);
    // With requireNonce false, a token with no nonce signs in.
    const open = world({}, { idToken: { requireNonce: false } });
    const free = await open.signIn("google", { idToken: await open.google() });
    expect(free.status).toBe(200);
  });

  it("bars a replay of one token on every isolate", async () => {
    const names: string[] = [];
    const a = world(
      { observe: { sink: { write: (b) => void names.push(...b.map((e) => e.name)) } } },
      { idToken: { requireNonce: false } },
    );
    const handleB = a.isolate();
    const token = await a.google();
    const first = await a.signIn("google", { idToken: token });
    expect(first.status).toBe(200);
    const again = await handleB(post("/auth/social/google/id-token", { idToken: token }, ip()));
    expect(await code(again)).toBe("invalid_token");
    // The same token with another text form of its signature: jose takes it, and it is still one token.
    const last = token.at(-1) ?? "";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const i = alphabet.indexOf(last);
    const twin = token.slice(0, -1) + alphabet[i ^ 1];
    const copy = await a.signIn("google", { idToken: recordCredential(twin) });
    expect(await code(copy)).toBe("invalid_token");
    expect(await a.storage.findMany("session", [])).toHaveLength(1);
    // The copy on this isolate is refused by the row, with its event.
    await a.config.observe.flush();
    expect(names.filter((x) => x === "social.id_token_replayed")).toHaveLength(1);
  });

  it("refuses a token past exp by its own clock when the seam allows a tolerance (final review B L)", async () => {
    const a = world({}, { idToken: { requireNonce: false } });
    // A seam with a clock tolerance of 2 minutes, as many JWT libraries allow.
    const base = a.config.jwt;
    (a.config as { jwt: JwtSeam }).jwt = {
      ...base,
      verifyIdToken: (input) =>
        base.verifyIdToken({ ...input, now: new Date(input.now.getTime() - 120_000) }),
    };
    const iat = Math.floor(a.clock.now().getTime() / 1000);
    const token = await a.google({ iat, exp: iat + 60 });
    expect((await a.signIn("google", { idToken: token })).status).toBe(200);
    // Past exp, inside the tolerance: the sweep deleted the used-token row at exp.
    a.clock.advance(90_000);
    await sweepExpired(a.config);
    const again = await a.signIn("google", { idToken: token });
    expect(await code(again)).toBe("invalid_token");
    expect(await a.storage.findMany("session", [])).toHaveLength(1);
  });

  it("accepts each audience of the list and refuses another", async () => {
    const w = world();
    for (const aud of [WEB, ANDROID, IOS]) {
      const res = await googleIn(w, { aud });
      expect(res.status, aud).toBe(200);
    }
    const other = await googleIn(w, { aud: "someone-else.apps.googleusercontent.com" });
    expect(await code(other)).toBe("invalid_token");
    // A list of audiences is refused, even when it holds the client id.
    const list = await googleIn(w, { aud: [WEB, "someone-else"] });
    expect(await code(list)).toBe("invalid_token");
    // An Apple token for the web Services ID and for the app pass; Google's client id does not.
    for (const aud of [APPLE_WEB, APPLE_APP]) {
      const nonce = await w.nonce("apple");
      const res = await w.signIn("apple", {
        idToken: await w.apple({ aud, nonce: await hashOf(nonce) }),
        nonce,
      });
      expect(res.status, aud).toBe(200);
    }
    const nonce = await w.nonce("apple");
    const res = await w.signIn("apple", {
      idToken: await w.apple({ aud: WEB, nonce: await hashOf(nonce) }),
      nonce,
    });
    expect(await code(res)).toBe("invalid_token");
  });

  it("takes the nonce claim as the SHA-256 hex of the posted nonce only", async () => {
    const w = world();
    for (const provider of ["google", "apple"] as const) {
      const make = provider === "google" ? w.google : w.apple;
      const hashed = await w.nonce(provider);
      const res = await w.signIn(provider, {
        idToken: await make({ nonce: await hashOf(hashed) }),
        nonce: hashed,
      });
      expect(res.status, provider).toBe(200);
      // A claim that holds the raw nonce is refused, and the nonce stays live.
      const raw = await w.nonce(provider);
      const rawRes = await w.signIn(provider, { idToken: await make({ nonce: raw }), nonce: raw });
      expect(await code(rawRes), provider).toBe("invalid_token");
      // Another value is no match.
      const bad = await w.nonce(provider);
      const badRes = await w.signIn(provider, { idToken: await make({ nonce: "x" }), nonce: bad });
      expect(await code(badRes), provider).toBe("invalid_token");
    }
  });

  it("refuses a party that holds the token text alone (probe P1)", async () => {
    const w = world();
    // The victim's app asks for a nonce, and gives providerNonce to Google.
    const nr = await w.handle(post("/auth/social/google/id-token/nonce", {}, ip()));
    const { nonce, providerNonce } = (await nr.json()) as { nonce: string; providerNonce: string };
    recordCredential(nonce);
    const token = await w.google({ nonce: providerNonce });
    // The thief reads the claim from the payload and posts it from another IP.
    const claim = decodeJwt(token).nonce;
    const stolen = await w.signIn("google", { idToken: token, nonce: claim });
    expect(await code(stolen)).toBe("invalid_token");
    // A token whose claim is the raw nonce gives the nonce away, so it is refused.
    const rawToken = await w.google({ nonce, sub: "g-raw" });
    const raw = await w.signIn("google", { idToken: rawToken, nonce });
    expect(await code(raw)).toBe("invalid_token");
    expect(await w.storage.findMany("session", [])).toEqual([]);
    // The app that holds the raw nonce signs in: the refusals spent nothing.
    const own = await w.signIn("google", { idToken: token, nonce });
    expect(own.status).toBe(200);
  });

  it("checks the token before it spends the nonce", async () => {
    const w = world();
    const nonce = await w.nonce("google");
    const live = [
      { field: "purpose", op: "eq", value: "id-token-nonce" },
      { field: "consumedAt", op: "eq", value: null },
    ] as const;
    // A party that saw the nonce posts a bad token, and a good token of another audience.
    const garbage = await w.signIn("google", { idToken: "a.b.c", nonce });
    expect(await code(garbage)).toBe("invalid_token");
    const otherAud = await w.signIn("google", {
      idToken: await w.google({ nonce: await hashOf(nonce), aud: "someone-else" }),
      nonce,
    });
    expect(await code(otherAud)).toBe("invalid_token");
    expect(await w.storage.findMany("verification", [...live])).toHaveLength(1);
    // The real sign-in with the same nonce still passes, and it spends the nonce.
    const res = await w.signIn("google", {
      idToken: await w.google({ nonce: await hashOf(nonce) }),
      nonce,
    });
    expect(res.status).toBe(200);
    expect(await w.storage.findMany("verification", [...live])).toEqual([]);
  });

  it("refuses an Apple token that marks the nonce mandatory and has none", async () => {
    // requireNonce off: only Apple's nonce_supported claim asks for the nonce.
    const w = world({}, { idToken: { requireNonce: false } });
    for (const supported of [true, "true"]) {
      const res = await w.signIn("apple", {
        idToken: await w.apple({ nonce_supported: supported }),
      });
      expect(await code(res), String(supported)).toBe("invalid_token");
    }
    expect(await w.storage.findMany("session", [])).toEqual([]);
    // With the nonce, the same claim passes; with nonce_supported false, no nonce passes.
    const nonce = await w.nonce("apple");
    const withNonce = await w.signIn("apple", {
      idToken: await w.apple({ nonce_supported: true, nonce: await hashOf(nonce) }),
      nonce,
    });
    expect(withNonce.status).toBe(200);
    const off = await w.signIn("apple", { idToken: await w.apple({ nonce_supported: false }) });
    expect(off.status).toBe(200);
  });

  it("refuses an expired token, another issuer, and an alg outside RS256 and ES256", async () => {
    const w = world();
    const iat = Math.floor(w.clock.now().getTime() / 1000);
    expect((await googleIn(w)).status).toBe(200);
    const es = await w.nonce("google");
    expect(
      (
        await w.signIn("google", {
          idToken: await w.google({ nonce: await hashOf(es), sub: "g-2" }, "ES256"),
          nonce: es,
        })
      ).status,
    ).toBe(200);
    const refused: Claims[] = [
      // Expired: exp one second ago.
      { iat: iat - 3600, exp: iat - 1 },
      // Another issuer.
      { iss: "https://evil.example" },
      // Issued in the future past the skew of 60 seconds.
      { iat: iat + 61, exp: iat + 3600 },
      // A life over one day.
      { iat, exp: iat + 86_401 },
      // No exp.
      { exp: undefined },
    ];
    for (const claims of refused) {
      const res = await googleIn(w, claims);
      expect(await code(res), JSON.stringify(claims)).toBe("invalid_token");
    }
    const ps = await w.nonce("google");
    const res = await w.signIn("google", {
      idToken: await w.google({ nonce: await hashOf(ps) }, "PS256"),
      nonce: ps,
    });
    expect(await code(res)).toBe("invalid_token");
  });

  it("takes name for Apple on a create only", async () => {
    const w = world();
    const n1 = await w.nonce("apple");
    const made = await w.signIn("apple", {
      idToken: await w.apple({ nonce: await hashOf(n1), sub: "a-new" }),
      nonce: n1,
      name: "Ada Lovelace",
    });
    expect(made.status).toBe(200);
    expect(((await made.json()) as { user: { name: string } }).user.name).toBe("Ada Lovelace");
    // A user made with no name keeps no name: the name of a later sign-in is the client's word.
    const n2 = await w.nonce("apple");
    const first = await w.signIn("apple", {
      idToken: await w.apple({
        nonce: await hashOf(n2),
        sub: "a-2",
        email: "b@icloud.com",
        email_verified: "true",
      }),
      nonce: n2,
    });
    expect(first.status).toBe(200);
    const n3 = await w.nonce("apple");
    const later = await w.signIn("apple", {
      idToken: await w.apple({
        nonce: await hashOf(n3),
        sub: "a-2",
        email: "b@icloud.com",
        email_verified: "true",
      }),
      nonce: n3,
      name: "Mallory",
    });
    expect(later.status).toBe(200);
    const user = await w.storage.findOne("user", [
      { field: "email", op: "eq", value: "b@icloud.com" },
    ]);
    expect(user?.name).toBeNull();
    // Google's name is its claim: a body name changes nothing.
    const g = await w.nonce("google");
    const res = await w.signIn("google", {
      idToken: await w.google({
        nonce: await hashOf(g),
        sub: "g-9",
        email: "c@example.com",
        name: "Cy",
      }),
      nonce: g,
      name: "Mallory",
    });
    expect(((await res.json()) as { user: { name: string } }).user.name).toBe("Cy");
  });

  it("runs the account rules of spec 8.3", async () => {
    const w = world();
    await w.seedUser("ada@example.com");
    const res = await googleIn(w, { email: "ada@example.com", email_verified: false });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("email_taken_unverified");
    expect(
      await w.storage.findMany("identity", [{ field: "provider", op: "eq", value: "google" }]),
    ).toEqual([]);
    // A verified address links to the user and signs in.
    const ok = await googleIn(w, { email: "ada@example.com" });
    expect(ok.status).toBe(200);
  });

  it("answers each refusal of the sign-in on the wire", async () => {
    const w = world();
    // A subject that is no identity key: oauth_failed, as at the callback.
    expect(await code(await googleIn(w, { sub: " " }))).toBe("oauth_failed");
    // A new user with no address: email_required.
    expect(await code(await googleIn(w, { sub: "g-none", email: undefined }))).toBe(
      "email_required",
    );
    // A body that breaks the contract.
    const bad = await w.signIn("google", { idToken: "x", extra: 1 });
    expect(await code(bad)).toBe("invalid_body");
    // A closed sign-up.
    const closed = world({ signUp: false });
    expect(await code(await googleIn(closed, { sub: "g-new" }))).toBe("sign_up_closed");
    // A before hook that refuses, and one that throws.
    const refusing = world({
      hooks: {
        user: {
          beforeCreate: () => {
            throw hookRefusal("Not now.");
          },
        },
      },
    });
    const refused = await googleIn(refusing);
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe("hook_refused");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = world({
      hooks: {
        user: {
          beforeCreate: () => {
            throw new Error("down");
          },
        },
      },
    });
    const failed = await googleIn(throwing);
    log.mockRestore();
    expect(failed.status).toBe(500);
    expect(await code(failed)).toBe("hook_failed");
    expect(await throwing.storage.findMany("user", [])).toEqual([]);
  });

  it("refuses a banned user", async () => {
    const w = world({
      organizations: {
        platformRole: "operator",
        platformOrganization: "platform-co",
        ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
      },
      operator: {
        secrets: [{ name: "support", secretHash: "0".repeat(64), scopes: ["users"] }],
        users: true,
      },
    });
    expect((await googleIn(w)).status).toBe(200);
    const user = await w.storage.findOne("user", [
      { field: "email", op: "eq", value: "ada@example.com" },
    ]);
    if (!user) throw new Error("no user");
    const banned = await operatorApi(w.config).users.ban({
      actor: { kind: "app", name: "support-tool" },
      userId: user.id,
      reason: "Abuse report 1",
      ip: null,
      userAgent: null,
    });
    if (!banned.ok) throw new Error(banned.code);
    const res = await googleIn(w);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("account_banned");
  });

  it("gates an ID-token sign-in", async () => {
    const keys = [...RING.values()].map((k) => k.jwk);
    let callbackToken = "";
    const f = fakeFetch(async (call) => {
      if (call.url === GOOGLE_JWKS) return Response.json({ keys });
      // The token endpoint of the redirect flow, for the list it answers.
      return Response.json({ id_token: callbackToken, access_token: "at", token_type: "Bearer" });
    });
    const auth = totpAuth({
      social: { google: { clientId: WEB, clientSecret: "s" }, fetch: f.fetchFn },
    });
    await enrolled(auth, EMAIL);
    const handle = settled(createRouter(auth.config, coreRoutes(auth.config)));
    const iat = Math.floor(auth.clock.now().getTime() / 1000);
    const signed = (claims: Claims) => {
      const key = RING.get("RS256");
      if (!key) throw new Error("no key");
      return new SignJWT({
        iss: GOOGLE_ISS,
        aud: WEB,
        sub: "g-gate",
        email: EMAIL,
        email_verified: true,
        iat,
        exp: iat + 3600,
        jti: `j${++n}`,
        ...claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "k-RS256" })
        .sign(key.privateKey);
    };
    const nr = await handle(post("/auth/social/google/id-token/nonce", {}, ip()));
    const { nonce } = (await nr.json()) as { nonce: string };
    const res = await handle(
      post(
        "/auth/social/google/id-token",
        { idToken: await signed({ nonce: await hashOf(nonce) }), nonce },
        ip(),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { twoFactor?: { methods: string[] }; token?: string };
    expect(body.token).toBeUndefined();
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${auth.config.cookieName}=`))).toBe(
      false,
    );
    // The same list as the challenge of the social callback (12c's list for social).
    const s = await startSocial(auth.config, { provider: "google", next: "/", ip: "1.1.1.1" });
    if (!s.ok) throw new Error(s.code);
    const url = new URL(s.value.location);
    // The redirect flow sends the raw nonce: its row holds the hash (plan 3).
    callbackToken = await signed({ nonce: url.searchParams.get("nonce") });
    const cb = await completeSocial(auth.config, {
      provider: "google",
      state: url.searchParams.get("state"),
      code: "c",
      error: null,
      bindToken: s.value.bindToken,
      ip: "1.1.1.1",
      userAgent: "ua",
    });
    if (!cb.ok || !("twoFactor" in cb.value)) throw new Error("the callback opened no challenge");
    expect(body.twoFactor?.methods).toEqual(cb.value.twoFactor.methods);
  });

  it("serves no route for a provider other than google and apple", async () => {
    const w = world({}, { github: { clientId: "h", clientSecret: "h" } });
    const res = await w.signIn("github", { idToken: "x" });
    expect(res.status).toBe(404);
    const nonce = await w.handle(post("/auth/social/github/id-token/nonce", {}, ip()));
    expect(nonce.status).toBe(404);
    // social.idToken false removes both routes of google and apple.
    const off = world({}, { idToken: false });
    expect((await off.signIn("google", { idToken: "x" })).status).toBe(404);
    expect((await off.handle(post("/auth/social/apple/id-token/nonce", {}, ip()))).status).toBe(
      404,
    );
  });

  it("limits the nonce and the sign-in by IP", async () => {
    const w = world();
    const same = ip();
    for (let i = 0; i < 60; i++) await w.nonce("google", same);
    const over = await w.handle(post("/auth/social/google/id-token/nonce", {}, same));
    expect(over.status).toBe(429);
    const other = ip();
    for (let i = 0; i < 30; i++) {
      const res = await w.signIn(
        "google",
        { idToken: "not-a-token", nonce: "A".repeat(43) },
        other,
      );
      expect(await code(res)).toBe("invalid_token");
    }
    const last = await w.signIn("google", { idToken: "not-a-token" }, other);
    expect(last.status).toBe(429);
  });

  it("sets the session cookie, the last method, and via", async () => {
    const w = world({ lastMethod: {} });
    const res = await googleIn(w);
    const body = (await res.json()) as { token: string; via: string };
    recordCredential(body.token);
    expect(body.via).toBe("social:google");
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith(`${w.config.cookieName}=${body.token}`))).toBe(true);
    expect(cookies.some((c) => c.startsWith("__Host-tempo_last_method=social:google"))).toBe(true);
  });

  it("replaces the anonymous user of the request", async () => {
    const links: AnonymousLinkEvent[] = [];
    const w = world({
      anonymous: { isolateLimiter: "allow" },
      hooks: { anonymous: { afterLink: (e) => void links.push(e) } },
    });
    const anon = await w.handle(post("/auth/anonymous/sign-in", {}, ip()));
    expect(anon.status).toBe(200);
    const { token } = (await anon.json()) as { token: string };
    recordCredential(token);
    const nonce = await w.nonce("google");
    const res = await w.signIn(
      "google",
      { idToken: await w.google({ nonce: await hashOf(nonce) }), nonce },
      { ...ip(), cookie: `${w.config.cookieName}=${token}` },
    );
    expect(res.status).toBe(200);
    expect(links).toHaveLength(1);
    expect(links[0]?.via).toBe("social");
    expect(links[0]?.proof).toBe("verified");
    expect(
      await w.storage.findOne("user", [{ field: "isAnonymous", op: "eq", value: true }]),
    ).toBeNull();
  });

  it("keeps the ID-token sign-in when the clean-up after afterLink fails", async () => {
    const events: { name: string; rowId?: unknown; errorName?: unknown }[] = [];
    let down = false;
    const w = world({
      anonymous: { isolateLimiter: "allow" },
      // The next transaction after afterLink is the end of the anonymous session.
      hooks: {
        anonymous: {
          afterLink: () => {
            down = true;
          },
        },
      },
      observe: { sink: { write: (b) => void events.push(...b) } },
    });
    const anon = await w.handle(post("/auth/anonymous/sign-in", {}, ip()));
    const { token } = (await anon.json()) as { token: string };
    recordCredential(token);
    const anonUser = await w.storage.findOne("user", [
      { field: "isAnonymous", op: "eq", value: true },
    ]);
    const transaction = w.storage.transaction.bind(w.storage);
    // A store error after the commit, such as query 51 on D1 Free (ruling 36 L2).
    w.storage.transaction = ((work) => {
      if (!down) return transaction(work);
      down = false;
      return Promise.reject(new Error("Too many API requests by single worker invocation."));
    }) as typeof w.storage.transaction;
    const nonce = await w.nonce("google");
    const res = await w.signIn(
      "google",
      { idToken: await w.google({ nonce: await hashOf(nonce) }), nonce },
      { ...ip(), cookie: `${w.config.cookieName}=${token}` },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    recordCredential(body.token);
    expect(
      res.headers.getSetCookie().some((c) => c.startsWith(`${w.config.cookieName}=${body.token}`)),
    ).toBe(true);
    await w.config.observe.flush();
    const lines = events.filter((e) => e.name === "anonymous.cleanup_failed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ rowId: anonUser?.id, errorName: "Error" });
    // The anonymous user stays for the sweep.
    expect(
      (await w.storage.findOne("user", [{ field: "id", op: "eq", value: anonUser?.id ?? "" }]))
        ?.isAnonymous,
    ).toBe(true);
  });

  it("links nothing at an ID-token sign-in once anonymous is off", async () => {
    const w = world({ anonymous: { isolateLimiter: "allow" } });
    const anon = await w.handle(post("/auth/anonymous/sign-in", {}, ip()));
    const { token } = (await anon.json()) as { token: string };
    recordCredential(token);
    // The deployment turns anonymous off; the anonymous session cookie stays in the browser.
    const ended: string[] = [];
    const off = world({
      anonymous: false,
      storage: w.storage,
      clock: w.clock,
      hooks: { session: { afterEnd: (e) => void ended.push(e.session.userId) } },
    });
    const nonce = await off.nonce("google");
    const res = await off.signIn(
      "google",
      { idToken: await off.google({ nonce: await hashOf(nonce) }), nonce },
      { ...ip(), cookie: `${w.config.cookieName}=${token}` },
    );
    expect(res.status).toBe(200);
    recordCredential(((await res.json()) as { token: string }).token);
    expect(ended).toEqual([]);
    const anonUser = await w.storage.findOne("user", [
      { field: "isAnonymous", op: "eq", value: true },
    ]);
    expect(anonUser).not.toBeNull();
    const [row] = await w.storage.findMany("session", [
      { field: "userId", op: "eq", value: anonUser?.id ?? "" },
    ]);
    // No claim: the anonymous session keeps its freshAt.
    expect(row?.freshAt).not.toBeNull();
  });

  it("refuses a bad audience list and a bad idToken option", () => {
    const google = (audiences: unknown) => () =>
      world({}, { google: { clientId: WEB, clientSecret: "s", audiences: audiences as string[] } });
    expect(google([])).toThrow(/social\.google\.audiences must be a list of 1 to 10/);
    expect(google(Array.from({ length: 11 }, (_, i) => `c${i}`))).toThrow(/1 to 10/);
    expect(google("one")).toThrow(/must be a list/);
    expect(google([""])).toThrow(/1 to 255 characters/);
    expect(google(["a\nb"])).toThrow(/no control character/);
    expect(google([ANDROID, ANDROID])).toThrow(/twice, or holds clientId/);
    expect(google([WEB])).toThrow(/twice, or holds clientId/);
    expect(google(Array.from({ length: 10 }, (_, i) => `c${i}`))).not.toThrow();
    const apple = () =>
      world(
        {},
        {
          apple: { clientId: APPLE_WEB, teamId: "T", keyId: "K", privateKey: "pem", audiences: [] },
        },
      );
    expect(apple).toThrow(/social\.apple\.audiences must be a list/);
    const idToken = (value: unknown) => () => world({}, { idToken: value as false });
    expect(idToken("on")).toThrow(/social\.idToken must be an object or false/);
    expect(idToken({ nonce: true })).toThrow(/social\.idToken\.nonce is not an option/);
    expect(idToken({ requireNonce: "yes" })).toThrow(/requireNonce must be a boolean/);
    expect(world({}, { idToken: {} }).config.social.idToken).toEqual({ requireNonce: true });
  });

  it("names no token in an answer or an event", async () => {
    const lines: string[] = [];
    const w = world({ observe: { sink: { write: (b) => void lines.push(JSON.stringify(b)) } } });
    const token = await w.google({ iss: "https://evil.example" });
    const nonce = await w.nonce("google");
    const res = await w.signIn("google", { idToken: token, nonce });
    const text = await res.text();
    await w.config.observe.flush();
    expect(text).not.toContain(token.split(".")[2]);
    expect(lines.join("\n")).not.toContain(token.split(".")[2]);
    expect(lines.join("\n")).toContain("social.id_token_rejected");
  });
});
