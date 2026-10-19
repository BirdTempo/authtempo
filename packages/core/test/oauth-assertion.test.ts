import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { fetchCimd } from "../src/engine/oauth-clients.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { fromBase64Url, randomBase64Url, toBase64Url } from "../src/primitives/crypto.js";
import { APP_ORIGIN, BASE_URL, makeAuth, post } from "./helpers.js";
import {
  authorized,
  type Handle,
  ISSUER,
  OTHER_RESOURCE,
  pkce,
  REDIRECT,
  RESOURCE,
  SCOPES,
  signedIn,
  tokenPost,
} from "./oauth-helpers.js";

const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** A failed assertion: the form carries it, so no Authorization header and no challenge (ruling 19). */
const REFUSED = { status: 400, body: { error: "invalid_client" }, challenge: null };
const PASSED = { status: 200, challenge: null };
const enc = new TextEncoder();

type Alg = "EdDSA" | "Ed25519" | "ES256" | "RS256" | "PS256";
const GEN: Record<Alg, unknown> = {
  EdDSA: { name: "Ed25519" },
  Ed25519: { name: "Ed25519" },
  ES256: { name: "ECDSA", namedCurve: "P-256" },
  RS256: {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  PS256: {
    name: "RSA-PSS",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
};
const SIGN: Record<Alg, unknown> = {
  EdDSA: { name: "Ed25519" },
  Ed25519: { name: "Ed25519" },
  ES256: { name: "ECDSA", hash: "SHA-256" },
  RS256: { name: "RSASSA-PKCS1-v1_5" },
  PS256: { name: "RSA-PSS", saltLength: 32 },
};

interface Key {
  alg: Alg;
  kid: string;
  /** The public JWK as WebCrypto exports it, with the kid. */
  jwk: Record<string, unknown>;
  privateKey: CryptoKey;
}

async function keyOf(alg: Alg, kid: string): Promise<Key> {
  const pair = (await crypto.subtle.generateKey(GEN[alg] as Algorithm, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
  return { alg, kid, jwk: { ...jwk, kid }, privateKey: pair.privateKey };
}

async function jws(key: Key, header: Record<string, unknown>, payload: Record<string, unknown>) {
  const input = `${toBase64Url(enc.encode(JSON.stringify(header)))}.${toBase64Url(enc.encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign(
    SIGN[key.alg] as Algorithm,
    key.privateKey,
    enc.encode(input),
  );
  return `${input}.${toBase64Url(new Uint8Array(sig))}`;
}

/** A fake `oauth.fetch` that answers from a map and counts its calls. */
function fakeFetch() {
  const answers = new Map<string, () => Response>();
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const answer = answers.get(url);
    if (!answer) throw new Error(`no fake answer for ${url}`);
    return answer();
  }) as typeof fetch;
  return { fn, answers, calls };
}

/** An OAuth config with a fake fetch and CIMD off. `fetch: null` passes no fetch. */
function setup(fetchFn: typeof fetch | null = null) {
  const base = makeAuth();
  const input: AuthConfig = {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: base.storage,
    mail: { send: async () => {} },
    clock: base.clock,
    limiter: createMemoryLimiter(base.clock),
    oauth: {
      resources: [RESOURCE, OTHER_RESOURCE],
      scopes: SCOPES,
      registration: { cimd: false, dynamic: true },
      ...(fetchFn ? { fetch: fetchFn } : {}),
    },
  };
  const h: Handle = {
    auth: createAuth(input),
    config: resolveConfig(input),
    storage: base.storage,
    clock: base.clock,
  };
  return { h, input };
}

/** A private_key_jwt client registered through the route, with `jwks` or `jwks_uri`. */
async function keyClient(
  h: Handle,
  keys: { jwks: { keys: Record<string, unknown>[] } } | { jwks_uri: string },
): Promise<string> {
  const res = await h.auth.handle(
    post("/auth/oauth/register", {
      redirect_uris: [REDIRECT],
      client_name: "Key client",
      token_endpoint_auth_method: "private_key_jwt",
      ...keys,
    }),
  );
  if (res.status !== 201) throw new Error(`register answered ${res.status}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

const nowS = (h: Handle) => Math.floor(h.clock.now().getTime() / 1000);

/** A good assertion of `clientId` under `key`, with `claims` over the defaults. A null claim is left out. */
async function assertion(
  h: Handle,
  key: Key,
  clientId: string,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {
    alg: key.alg,
    kid: key.kid,
    typ: "client-authentication+jwt",
  },
) {
  const now = nowS(h);
  const payload: Record<string, unknown> = {
    iss: clientId,
    sub: clientId,
    aud: ISSUER,
    exp: now + 60,
    iat: now,
    jti: randomBase64Url(16),
    ...claims,
  };
  for (const [k, v] of Object.entries(payload)) if (v === null) delete payload[k];
  return jws(key, header, payload);
}

interface Code {
  code: string;
  verifier: string;
}

async function codeOf(h: Handle, cookie: string, clientId: string): Promise<Code> {
  const p = await pkce();
  const { code } = await authorized(h, cookie, { clientId, challenge: p.challenge });
  return { code, verifier: p.verifier };
}

const exchange = (c: Code, token: string, extra: Record<string, string> = {}) =>
  tokenPost({
    grant_type: "authorization_code",
    code: c.code,
    code_verifier: c.verifier,
    redirect_uri: REDIRECT,
    resource: RESOURCE,
    client_assertion_type: ASSERTION_TYPE,
    client_assertion: token,
    ...extra,
  });

async function answer(res: Response) {
  const challenge = res.headers.get("www-authenticate");
  if (res.status === 200) return { status: 200, challenge };
  return { status: res.status, body: await res.json(), challenge };
}

/** One signed-in person and one client of `key` with its set inline. */
async function inline(key: Key, more: Key[] = []) {
  const { h, input } = setup();
  const s = await signedIn(h);
  const clientId = await keyClient(h, { jwks: { keys: [key.jwk, ...more.map((k) => k.jwk)] } });
  return { h, input, s, clientId };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("private_key_jwt (plan 12e Task 5, RFC 7523 with rfc7523bis-11)", () => {
  it("passes an assertion of each alg", async () => {
    for (const alg of ["EdDSA", "Ed25519", "ES256", "RS256", "PS256"] as const) {
      const key = await keyOf(alg, `k-${alg}`);
      const { h, s, clientId } = await inline(key);
      const res = await h.auth.handle(
        exchange(await codeOf(h, s.cookie, clientId), await assertion(h, key, clientId)),
      );
      expect({ alg, answer: await answer(res) }).toEqual({ alg, answer: PASSED });
      // The refresh grant and the revoke route take the same auth.
      const { refresh_token } = (await res.json()) as { refresh_token: string };
      const refreshed = await h.auth.handle(
        tokenPost({
          grant_type: "refresh_token",
          refresh_token,
          client_assertion_type: ASSERTION_TYPE,
          client_assertion: await assertion(h, key, clientId),
        }),
      );
      expect({ alg, status: refreshed.status }).toEqual({ alg, status: 200 });
      const revoked = await h.auth.handle(
        new Request(`${BASE_URL}/auth/oauth/revoke`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: refresh_token,
            client_assertion_type: ASSERTION_TYPE,
            client_assertion: await assertion(h, key, clientId),
          }).toString(),
        }),
      );
      expect({ alg, status: revoked.status }).toEqual({ alg, status: 200 });
    }
  });

  it("registers a WebCrypto Ed25519 key with alg Ed25519 and refuses an Ed448 key (RFC 9864)", async () => {
    const key = await keyOf("Ed25519", "k1");
    expect(key.jwk.alg).toBe("Ed25519");
    const { h, s, clientId } = await inline(key);
    for (const alg of ["Ed25519", "EdDSA"]) {
      const token = await assertion(h, key, clientId, {}, { alg, kid: "k1" });
      const res = await h.auth.handle(exchange(await codeOf(h, s.cookie, clientId), token));
      expect({ alg, answer: await answer(res) }).toEqual({ alg, answer: PASSED });
    }
    const ed448 = { kty: "OKP", crv: "Ed448", x: key.jwk.x, kid: "k2" };
    for (const k of [ed448, { ...ed448, alg: "Ed448" }]) {
      const res = await h.auth.handle(
        post("/auth/oauth/register", {
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "private_key_jwt",
          jwks: { keys: [k] },
        }),
      );
      expect(await res.json()).toEqual({ error: "invalid_client_metadata" });
    }
  });

  it("refuses an RSA key under 2048 bits or with a weak e at registration (RFC 7518 3.3)", async () => {
    const { h } = setup();
    const rsa = async (bits: number, e: number[]) => {
      const pair = (await crypto.subtle.generateKey(
        {
          ...(GEN.RS256 as object),
          modulusLength: bits,
          publicExponent: new Uint8Array(e),
        } as RsaHashedKeyGenParams,
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
      const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
      return { kty: "RSA", n: String(jwk.n), e: String(jwk.e), kid: "k1" };
    };
    const register = async (key: Record<string, unknown>) =>
      (
        await h.auth.handle(
          post("/auth/oauth/register", {
            redirect_uris: [REDIRECT],
            token_endpoint_auth_method: "private_key_jwt",
            jwks: { keys: [key] },
          }),
        )
      ).status;
    expect(await register(await rsa(2048, [1, 0, 1]))).toBe(201);
    const k512 = await rsa(512, [1, 0, 1]);
    const padded = toBase64Url(new Uint8Array([...new Uint8Array(192), ...fromBase64Url(k512.n)]));
    for (const [what, key] of [
      ["2047 bits", await rsa(2047, [1, 0, 1])],
      ["512 bits behind 192 zero bytes", { ...k512, n: padded }],
      ["e = 3", await rsa(2048, [3])],
    ] as const)
      expect({ what, status: await register(key) }).toEqual({ what, status: 400 });
  });

  it("refuses the token endpoint URL as aud (rfc7523bis)", async () => {
    const key = await keyOf("ES256", "k1");
    const { h, s, clientId } = await inline(key);
    const c = await codeOf(h, s.cookie, clientId);
    for (const aud of [`${ISSUER}/oauth/token`, [`${ISSUER}/oauth/token`]]) {
      const res = await h.auth.handle(exchange(c, await assertion(h, key, clientId, { aud })));
      expect({ aud, answer: await answer(res) }).toEqual({ aud, answer: REFUSED });
    }
    // The refusal spent nothing: the same code passes with a right aud.
    expect(
      await answer(await h.auth.handle(exchange(c, await assertion(h, key, clientId)))),
    ).toEqual(PASSED);
  });

  it("accepts aud as the issuer in a string or an array of one, and refuses an array of two", async () => {
    const key = await keyOf("ES256", "k1");
    const { h, s, clientId } = await inline(key);
    for (const [aud, want] of [
      [ISSUER, PASSED],
      [[ISSUER], PASSED],
      [[ISSUER, "https://other.example.com"], REFUSED],
      [[ISSUER, ISSUER], REFUSED],
      [`${ISSUER}/`, REFUSED],
      [BASE_URL, REFUSED],
      [[], REFUSED],
      [7, REFUSED],
      [null, REFUSED],
    ] as const) {
      const res = await h.auth.handle(
        exchange(await codeOf(h, s.cookie, clientId), await assertion(h, key, clientId, { aud })),
      );
      expect({ aud, answer: await answer(res) }).toEqual({ aud, answer: want });
    }
  });

  it("refuses iss or sub other than the client id", async () => {
    const key = await keyOf("ES256", "k1");
    const { h, s, clientId } = await inline(key);
    const other = await keyClient(h, { jwks: { keys: [key.jwk] } });
    const secretClient = await h.auth.handle(
      post("/auth/oauth/register", {
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    );
    const secretId = ((await secretClient.json()) as { client_id: string }).client_id;
    const c = await codeOf(h, s.cookie, clientId);
    for (const claims of [
      { iss: other },
      { sub: other },
      { iss: null },
      { sub: null },
      { iss: 7, sub: 7 },
      { iss: `cl_${"Z".repeat(43)}`, sub: `cl_${"Z".repeat(43)}` },
    ]) {
      const res = await h.auth.handle(exchange(c, await assertion(h, key, clientId, claims)));
      expect({ claims, answer: await answer(res) }).toEqual({ claims, answer: REFUSED });
    }
    // A client of another method, whose own iss and sub the key signs.
    const asSecret = await assertion(h, key, secretId);
    expect(await answer(await h.auth.handle(exchange(c, asSecret)))).toEqual(REFUSED);
    // The code of `clientId` is not spent.
    expect(
      await answer(await h.auth.handle(exchange(c, await assertion(h, key, clientId)))),
    ).toEqual(PASSED);
  });

  it("refuses a form client_id other than the assertion sub (RFC 7521 4.2)", async () => {
    const key = await keyOf("ES256", "k1");
    const { h, s, clientId } = await inline(key);
    const other = await keyClient(h, { jwks: { keys: [key.jwk] } });
    const c = await codeOf(h, s.cookie, clientId);
    const wrong = await h.auth.handle(
      exchange(c, await assertion(h, key, clientId), { client_id: other }),
    );
    expect(await answer(wrong)).toEqual(REFUSED);
    const right = await h.auth.handle(
      exchange(c, await assertion(h, key, clientId), { client_id: clientId }),
    );
    expect(await answer(right)).toEqual(PASSED);
  });

  it("refuses an exp more than 300 seconds out, a past exp, and an iat more than 300 seconds old or ahead", async () => {
    const key = await keyOf("ES256", "k1");
    const { h, s, clientId } = await inline(key);
    const now = nowS(h);
    for (const [claims, want] of [
      [{ exp: now + 330 }, PASSED],
      [{ exp: now + 331 }, REFUSED],
      [{ exp: now - 29 }, PASSED],
      [{ exp: now - 30 }, REFUSED],
      [{ iat: now - 330 }, PASSED],
      [{ iat: now - 331 }, REFUSED],
      [{ iat: now + 30 }, PASSED],
      [{ iat: now + 31 }, REFUSED],
      [{ iat: null }, PASSED],
      [{ exp: null }, REFUSED],
    ] as const) {
      const res = await h.auth.handle(
        exchange(await codeOf(h, s.cookie, clientId), await assertion(h, key, clientId, claims)),
      );
      expect({ claims, answer: await answer(res) }).toEqual({ claims, answer: want });
    }
  });

  it("refuses an nbf more than 30 seconds ahead and a time claim that is not a number (RFC 7523 3)", async () => {
    const key = await keyOf("ES256", "k1");
    const { h, s, clientId } = await inline(key);
    const now = nowS(h);
    for (const [claims, want] of [
      [{ nbf: now + 30 }, PASSED],
      [{ nbf: now + 31 }, REFUSED],
      [{ nbf: now - 100 }, PASSED],
      [{ nbf: String(now) }, REFUSED],
      [{ exp: String(now + 60) }, REFUSED],
      [{ iat: String(now) }, REFUSED],
    ] as const) {
      const res = await h.auth.handle(
        exchange(await codeOf(h, s.cookie, clientId), await assertion(h, key, clientId, claims)),
      );
      expect({ claims, answer: await answer(res) }).toEqual({ claims, answer: want });
    }
  });

  it("refuses a second use of a jti", async () => {
    const key = await keyOf("ES256", "k1");
    const { h, input, s, clientId } = await inline(key);
    const token = await assertion(h, key, clientId, { jti: "one-jti" });
    const first = await h.auth.handle(exchange(await codeOf(h, s.cookie, clientId), token));
    expect(await answer(first)).toEqual(PASSED);
    // The same assertion again, with a new code.
    const c = await codeOf(h, s.cookie, clientId);
    expect(await answer(await h.auth.handle(exchange(c, token)))).toEqual(REFUSED);
    // A new assertion with the same jti.
    const again = await assertion(h, key, clientId, { jti: "one-jti", exp: nowS(h) + 90 });
    expect(await answer(await h.auth.handle(exchange(c, again)))).toEqual(REFUSED);
    // A second core instance over the same storage refuses it too.
    const second = createAuth({ ...input, limiter: createMemoryLimiter(h.clock) });
    expect(await answer(await second.handle(exchange(c, token)))).toEqual(REFUSED);
    // The refused replays spent no code, and the same jti of another client is its own.
    expect(
      await answer(await h.auth.handle(exchange(c, await assertion(h, key, clientId)))),
    ).toEqual(PASSED);
    const other = await keyClient(h, { jwks: { keys: [key.jwk] } });
    expect(
      await answer(
        await h.auth.handle(
          exchange(
            await codeOf(h, s.cookie, other),
            await assertion(h, key, other, { jti: "one-jti" }),
          ),
        ),
      ),
    ).toEqual(PASSED);
  });

  it("keeps the jti through a sweep, also for a fractional exp at the skew edge", async () => {
    const key = await keyOf("ES256", "k1");
    for (const offset of [-29.5, -29, 1.25]) {
      const { h, s, clientId } = await inline(key);
      // 900 ms into a second: claimsHold reads the whole second, so exp N - 29.5 still passes.
      h.clock.advance(900);
      const token = await assertion(h, key, clientId, { exp: nowS(h) + offset });
      const first = await h.auth.handle(exchange(await codeOf(h, s.cookie, clientId), token));
      expect({ offset, answer: await answer(first) }).toEqual({ offset, answer: PASSED });
      h.clock.advance(50);
      await h.auth.api.sweepExpired();
      const again = await h.auth.handle(exchange(await codeOf(h, s.cookie, clientId), token));
      expect({ offset, answer: await answer(again) }).toEqual({ offset, answer: REFUSED });
    }
  });

  it("refuses a jti longer than 256 characters and a missing jti", async () => {
    const key = await keyOf("ES256", "k1");
    const { h, s, clientId } = await inline(key);
    for (const [jti, want] of [
      ["j".repeat(256), PASSED],
      ["j".repeat(257), REFUSED],
      ["", REFUSED],
      [null, REFUSED],
      [7, REFUSED],
    ] as const) {
      const res = await h.auth.handle(
        exchange(await codeOf(h, s.cookie, clientId), await assertion(h, key, clientId, { jti })),
      );
      expect({
        jti: typeof jti === "string" ? jti.length : jti,
        answer: await answer(res),
      }).toEqual({
        jti: typeof jti === "string" ? jti.length : jti,
        answer: want,
      });
    }
  });

  it("tries each key whose alg fits when the header has no kid, at most 10", async () => {
    const es = await keyOf("ES256", "k-es");
    const others = await Promise.all(Array.from({ length: 9 }, (_, i) => keyOf("ES256", `k-${i}`)));
    const { h, s, clientId } = await inline(others[0] as Key, [...others.slice(1), es]);
    // The key that signs is the tenth of the set.
    const noKid = await assertion(h, es, clientId, {}, { alg: "ES256" });
    expect(
      await answer(await h.auth.handle(exchange(await codeOf(h, s.cookie, clientId), noKid))),
    ).toEqual(PASSED);
    // A kid that names no key of the set.
    const unknown = await assertion(h, es, clientId, {}, { alg: "ES256", kid: "nope" });
    expect(
      await answer(await h.auth.handle(exchange(await codeOf(h, s.cookie, clientId), unknown))),
    ).toEqual(REFUSED);
  });

  it("reads jwks_uri with the CIMD guards, keeps the set one hour, and reads an unknown kid once per 30 seconds", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeFetch();
    const { h } = setup(fake.fn);
    const person = await signedIn(h);
    const k1 = await keyOf("ES256", "k1");
    const k2 = await keyOf("ES256", "k2");
    const url = "https://client.example.com/jwks.json";
    let set = [k1.jwk];
    fake.answers.set(url, () => Response.json({ keys: set }));
    const clientId = await keyClient(h, { jwks_uri: url });
    const run = async (key: Key) =>
      answer(
        await h.auth.handle(
          exchange(await codeOf(h, person.cookie, clientId), await assertion(h, key, clientId)),
        ),
      );
    expect(await run(k1)).toEqual(PASSED);
    expect(fake.calls).toEqual([url]);
    expect(await run(k1)).toEqual(PASSED);
    expect(fake.calls.length).toBe(1);
    // An unknown kid within 30 seconds of the last read does not read again.
    expect(await run(k2)).toEqual(REFUSED);
    expect(fake.calls.length).toBe(1);
    // After 30 seconds it reads the set again once, then waits 30 seconds more.
    h.clock.advance(30_000);
    expect(await run(k2)).toEqual(REFUSED);
    expect(fake.calls.length).toBe(2);
    expect(await run(k2)).toEqual(REFUSED);
    expect(fake.calls.length).toBe(2);
    h.clock.advance(29_000);
    expect(await run(k2)).toEqual(REFUSED);
    expect(fake.calls.length).toBe(2);
    // The client rotates in k2; after 30 seconds the read finds it.
    set = [k1.jwk, k2.jwk];
    h.clock.advance(1_000);
    expect(await run(k2)).toEqual(PASSED);
    expect(fake.calls.length).toBe(3);
    // One hour after that read, the set is read again.
    h.clock.advance(3_599_000);
    expect(await run(k1)).toEqual(PASSED);
    expect(fake.calls.length).toBe(3);
    h.clock.advance(1_000);
    expect(await run(k1)).toEqual(PASSED);
    expect(fake.calls.length).toBe(4);

    // Each guard refuses the key; a failed read is not kept.
    const guards: [string, () => Response][] = [
      [
        "https://redirect.example.com/jwks.json",
        () => new Response(null, { status: 302, headers: { location: url } }),
      ],
      [
        "https://big.example.com/jwks.json",
        () =>
          new Response(JSON.stringify({ keys: [k1.jwk], pad: "x".repeat(65_536) }), {
            headers: { "content-type": "application/json" },
          }),
      ],
      [
        "https://text.example.com/jwks.json",
        () =>
          new Response(JSON.stringify({ keys: [k1.jwk] }), {
            headers: { "content-type": "text/plain" },
          }),
      ],
      [
        "https://status.example.com/jwks.json",
        () => Response.json({ keys: [k1.jwk] }, { status: 404 }),
      ],
      [
        "https://private.example.com/jwks.json",
        () => Response.json({ keys: [{ ...k1.jwk, d: "AAAA" }] }),
      ],
    ];
    for (const [guardUrl, bad] of guards) {
      fake.answers.set(guardUrl, bad);
      const id = await keyClient(h, { jwks_uri: guardUrl });
      const before = fake.calls.length;
      const refused = await h.auth.handle(
        exchange(await codeOf(h, person.cookie, id), await assertion(h, k1, id)),
      );
      expect({ guardUrl, answer: await answer(refused) }).toEqual({ guardUrl, answer: REFUSED });
      // The failure is kept 30 seconds only: then a good set passes, with a new read.
      fake.answers.set(guardUrl, () => Response.json({ keys: [k1.jwk] }));
      h.clock.advance(30_000);
      const passed = await h.auth.handle(
        exchange(await codeOf(h, person.cookie, id), await assertion(h, k1, id)),
      );
      expect({ guardUrl, answer: await answer(passed) }).toEqual({ guardUrl, answer: PASSED });
      expect({ guardUrl, reads: fake.calls.length - before }).toEqual({ guardUrl, reads: 2 });
    }
    // No log line holds an assertion or a key set.
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toMatch(/eyJ/);
    expect(logged).not.toContain(String(k1.jwk.x));
  });

  it("keeps a set through a failed read for an unknown kid, and reads again once per 30 seconds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeFetch();
    const { h } = setup(fake.fn);
    const person = await signedIn(h);
    const k1 = await keyOf("ES256", "k1");
    const k2 = await keyOf("ES256", "k2");
    const url = "https://client.example.com/jwks.json";
    fake.answers.set(url, () => Response.json({ keys: [k1.jwk] }));
    const clientId = await keyClient(h, { jwks_uri: url });
    const run = async (key: Key) =>
      answer(
        await h.auth.handle(
          exchange(await codeOf(h, person.cookie, clientId), await assertion(h, key, clientId)),
        ),
      );
    expect(await run(k1)).toEqual(PASSED);
    expect(fake.calls.length).toBe(1);
    // The client's host goes down.
    fake.answers.set(url, () => new Response("down", { status: 503 }));
    h.clock.advance(30_000);
    expect(await run(k2)).toEqual(REFUSED);
    expect(fake.calls.length).toBe(2);
    // The failed read counts as a read: no fetch for 30 seconds.
    expect(await run(k2)).toEqual(REFUSED);
    expect(fake.calls.length).toBe(2);
    // The kept set still serves its own key, with no fetch.
    expect(await run(k1)).toEqual(PASSED);
    expect(fake.calls.length).toBe(2);
  });

  it("reads a failed jwks_uri once per 30 seconds when no set is kept", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeFetch();
    const { h } = setup(fake.fn);
    const person = await signedIn(h);
    const url = "https://down.example.com/jwks.json";
    fake.answers.set(url, () => new Response("down", { status: 503 }));
    const clientId = await keyClient(h, { jwks_uri: url });
    for (let i = 0; i < 5; i++) {
      const key = await keyOf("ES256", `k${i}`);
      const res = await h.auth.handle(
        exchange(await codeOf(h, person.cookie, clientId), await assertion(h, key, clientId)),
      );
      expect({ i, answer: await answer(res) }).toEqual({ i, answer: REFUSED });
      h.clock.advance(200);
    }
    expect(fake.calls.length).toBe(1);
    // After 30 seconds the URL is read again, and a good set passes.
    const k1 = await keyOf("ES256", "k1");
    fake.answers.set(url, () => Response.json({ keys: [k1.jwk] }));
    h.clock.advance(29_000);
    const res = await h.auth.handle(
      exchange(await codeOf(h, person.cookie, clientId), await assertion(h, k1, clientId)),
    );
    expect(await answer(res)).toEqual(PASSED);
    expect(fake.calls.length).toBe(2);
  });

  it("reads no jwks_uri that the host rule refuses at fetch time", async () => {
    const fake = fakeFetch();
    const { h, input } = setup(fake.fn);
    const person = await signedIn(h);
    const k1 = await keyOf("ES256", "k1");
    const url = "https://client.example.com/jwks.json";
    fake.answers.set(url, () => Response.json({ keys: [k1.jwk] }));
    const clientId = await keyClient(h, { jwks_uri: url });
    expect(
      await answer(
        await h.auth.handle(
          exchange(await codeOf(h, person.cookie, clientId), await assertion(h, k1, clientId)),
        ),
      ),
    ).toEqual(PASSED);
    expect(fake.calls.length).toBe(1);
    // The same storage behind a core whose own host is the host of the set:
    // validCimdUrl refuses that URL now, so no fetch runs.
    const moved = createAuth({ ...input, baseURL: "https://client.example.com" });
    const token = await jws(
      k1,
      { alg: "ES256", kid: "k1" },
      {
        iss: clientId,
        sub: clientId,
        aud: "https://client.example.com/auth",
        exp: nowS(h) + 60,
        jti: randomBase64Url(16),
      },
    );
    const res = await moved.handle(
      new Request("https://client.example.com/auth/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "oc_none",
          client_assertion_type: ASSERTION_TYPE,
          client_assertion: token,
        }).toString(),
      }),
    );
    expect(await answer(res)).toEqual(REFUSED);
    expect(fake.calls.length).toBe(1);
  });

  it("reads a key set served as application/jwk-set+json (RFC 7517 8.5)", async () => {
    const fake = fakeFetch();
    const { h } = setup(fake.fn);
    const person = await signedIn(h);
    const k1 = await keyOf("ES256", "k1");
    const url = "https://client.example.com/jwks.json";
    fake.answers.set(
      url,
      () =>
        new Response(JSON.stringify({ keys: [k1.jwk] }), {
          headers: { "content-type": "application/jwk-set+json; charset=utf-8" },
        }),
    );
    const clientId = await keyClient(h, { jwks_uri: url });
    const res = await h.auth.handle(
      exchange(await codeOf(h, person.cookie, clientId), await assertion(h, k1, clientId)),
    );
    expect(await answer(res)).toEqual(PASSED);
    // A client metadata document keeps application/json alone.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const doc = "https://client.example.com/client.json";
    const asSet = (async () =>
      new Response(JSON.stringify({ client_id: doc, redirect_uris: [REDIRECT] }), {
        headers: { "content-type": "application/jwk-set+json" },
      })) as unknown as typeof fetch;
    expect(await fetchCimd(setup(asSet).h.config, doc)).toBeNull();
  });

  it("refuses a jwks_uri client while oauth.fetch is null", async () => {
    const { h } = setup(null);
    const res = await h.auth.handle(
      post("/auth/oauth/register", {
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "private_key_jwt",
        jwks_uri: "https://client.example.com/jwks.json",
      }),
    );
    expect(await res.json()).toEqual({ error: "invalid_client_metadata" });
    // With a fetch, the same client registers.
    const { h: withFetch } = setup(fakeFetch().fn);
    const ok = await withFetch.auth.handle(
      post("/auth/oauth/register", {
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "private_key_jwt",
        jwks_uri: "https://client.example.com/jwks.json",
      }),
    );
    expect(ok.status).toBe(201);
  });

  it("accepts an assertion with no typ", async () => {
    const key = await keyOf("ES256", "k1");
    const { h, s, clientId } = await inline(key);
    for (const header of [
      { alg: "ES256", kid: "k1" },
      { alg: "ES256", kid: "k1", typ: "JWT" },
      { alg: "ES256", kid: "k1", typ: "client-authentication+jwt" },
    ]) {
      const res = await h.auth.handle(
        exchange(
          await codeOf(h, s.cookie, clientId),
          await assertion(h, key, clientId, {}, header),
        ),
      );
      expect({ header, answer: await answer(res) }).toEqual({ header, answer: PASSED });
    }
  });

  it("refuses a bad type, a bad assertion, and a changed signature", async () => {
    const key = await keyOf("ES256", "k1");
    const { h, s, clientId } = await inline(key);
    const c = await codeOf(h, s.cookie, clientId);
    const good = await assertion(h, key, clientId);
    const [head, body, sig = ""] = good.split(".");
    const changed = `${head}.${body}.${sig.slice(0, 4)}${sig[4] === "A" ? "B" : "A"}${sig.slice(5)}`;
    for (const form of [
      {
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:saml2-bearer",
        client_assertion: good,
      },
      { client_assertion_type: ASSERTION_TYPE, client_assertion: `${good}.${good}` },
      { client_assertion_type: ASSERTION_TYPE, client_assertion: "" },
      { client_assertion_type: ASSERTION_TYPE },
      { client_assertion: good },
      { client_assertion_type: ASSERTION_TYPE, client_assertion: changed },
    ]) {
      const res = await h.auth.handle(
        tokenPost({
          grant_type: "authorization_code",
          code: c.code,
          code_verifier: c.verifier,
          redirect_uri: REDIRECT,
          resource: RESOURCE,
          ...form,
        }),
      );
      expect({ form: Object.keys(form), answer: await answer(res) }).toEqual({
        form: Object.keys(form),
        answer: REFUSED,
      });
    }
    expect(await answer(await h.auth.handle(exchange(c, good)))).toEqual(PASSED);
  });
});
