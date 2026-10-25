import { describe, expect, it } from "vitest";
import { type AuthConfig, resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { isOperatorSecret } from "../src/operator-secret.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth } from "./helpers.js";

const SECRET = "operator-secret-0123456789abcdef-0123456789";
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** A POST to the operator route from one IP, with an Authorization header when `auth` is set. */
function rotate(auth: string | null, ip = "203.0.113.7", headers: Record<string, string> = {}) {
  return new Request(`${BASE_URL}/auth/operator/keys/rotate`, {
    method: "POST",
    headers: {
      "cf-connecting-ip": ip,
      ...(auth === null ? {} : { authorization: auth }),
      ...headers,
    },
  });
}

/** One storage, clock, and limiter for the engine view and the routes. */
async function operatorHandle(extra: Partial<AuthConfig> = {}) {
  const base = makeAuth();
  const auth = createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: base.storage,
    mail: { send: async () => {} },
    clock: base.clock,
    limiter: base.config.limiter,
    operator: { secretHash: await sha256Hex(SECRET) },
    ...extra,
  });
  return { ...base, auth };
}

type KeySet = { keys: { kid: string }[] };
const kids = async (h: Awaited<ReturnType<typeof operatorHandle>>) =>
  ((await (await h.auth.handle(get("/auth/jwks"))).json()) as KeySet).keys.map((k) => k.kid);

describe("the operator route (plan 11c)", () => {
  it("answers 404 when the config has no operator block, or operator: false", async () => {
    const off = await operatorHandle({ operator: false });
    expect((await off.auth.handle(rotate(`Operator ${SECRET}`))).status).toBe(404);
    const base = makeAuth();
    const absent = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: base.storage,
      mail: { send: async () => {} },
    });
    expect((await absent.handle(rotate(`Operator ${SECRET}`))).status).toBe(404);
  });

  it("answers 401 to no header, another scheme, a short secret, and a wrong secret, and keeps the key", async () => {
    const h = await operatorHandle();
    const before = await kids(h);
    // Four calls, under the limit of five per IP per hour.
    for (const header of [null, `Bearer ${SECRET}`, "Operator short", `Operator ${SECRET}x`]) {
      const res = await h.auth.handle(rotate(header));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(await kids(h)).toEqual(before);
  });

  it("takes a secret of 32 to 512 visible ASCII characters: 32 and 512 pass, 31 and 513 fail", async () => {
    expect(isOperatorSecret("x".repeat(32))).toBe(true);
    expect(isOperatorSecret("x".repeat(512))).toBe(true);
    expect(isOperatorSecret("x".repeat(31))).toBe(false);
    expect(isOperatorSecret("x".repeat(513))).toBe(false);
    expect(isOperatorSecret(`${"x".repeat(32)} `)).toBe(false);
    expect(isOperatorSecret("é".repeat(32))).toBe(false);
    // The route holds the same rule: each length gets its own deployment, under the limit of five.
    for (const [secret, status] of [
      ["a".repeat(32), 200],
      ["b".repeat(512), 200],
      ["c".repeat(31), 401],
      ["d".repeat(513), 401],
    ] as const) {
      const h = await operatorHandle({ operator: { secretHash: await sha256Hex(secret) } });
      expect((await h.auth.handle(rotate(`Operator ${secret}`))).status, `${secret.length}`).toBe(
        status,
      );
    }
  });

  it("makes a new signing key for the right secret: the JWKS lists it first, and the old key stays 24 hours", async () => {
    const h = await operatorHandle();
    const before = await kids(h);
    const res = await h.auth.handle(rotate(`Operator ${SECRET}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { kid } = (await res.json()) as { kid: string };
    expect(kid).not.toBe(before[0]);
    expect(await kids(h)).toEqual([kid, before[0]]);
    h.clock.advance(DAY);
    expect(await kids(h)).toEqual([kid]);
  });

  it("makes one new key for two calls at once: both answer the same kid, and the JWKS lists two keys", async () => {
    const h = await operatorHandle();
    const before = await kids(h);
    const [a, b] = await Promise.all([
      h.auth.handle(rotate(`Operator ${SECRET}`)),
      h.auth.handle(rotate(`Operator ${SECRET}`)),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const [ka, kb] = [
      ((await a.json()) as { kid: string }).kid,
      ((await b.json()) as { kid: string }).kid,
    ];
    expect(ka).toBe(kb);
    expect(await kids(h)).toEqual([ka, before[0]]);
  });

  it("takes the scheme in any case (RFC 9110 section 11.1)", async () => {
    const h = await operatorHandle();
    expect((await h.auth.handle(rotate(`operator ${SECRET}`))).status).toBe(200);
  });

  it("answers 429 at the sixth call from one IP in an hour, right or wrong, and counts per IP", async () => {
    const h = await operatorHandle();
    for (let i = 0; i < 5; i++)
      expect(
        (await h.auth.handle(rotate("Operator wrong-wrong-wrong-wrong-wrong-wrong"))).status,
      ).toBe(401);
    expect((await h.auth.handle(rotate(`Operator ${SECRET}`))).status).toBe(429);
    expect((await h.auth.handle(rotate(`Operator ${SECRET}`, "203.0.113.8"))).status).toBe(200);
    h.clock.advance(HOUR);
    expect((await h.auth.handle(rotate(`Operator ${SECRET}`))).status).toBe(200);
  });

  it("refuses a browser post from an untrusted origin before the secret check", async () => {
    const h = await operatorHandle();
    const res = await h.auth.handle(
      rotate(`Operator ${SECRET}`, "203.0.113.7", { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
  });
});

describe("operator config (plan 11c)", () => {
  const base = {
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
  };
  const HASH = "a".repeat(64);

  it("resolves to null when absent or false, and keeps the hash", () => {
    expect(resolveConfig(base).operator).toBeNull();
    expect(resolveConfig({ ...base, operator: false }).operator).toBeNull();
    // Plan 12f (ruling 17): the hash is one secret named "default" with the scopes keys and secrets.
    expect(resolveConfig({ ...base, operator: { secretHash: HASH } }).operator).toEqual({
      secrets: [{ name: "default", secretHash: HASH, scopes: ["keys", "secrets"] }],
      users: false,
      impersonation: null,
      // Plan 12f2 Task 3: the invitation life, 72 hours by default.
      invite: { ttlHours: 72 },
    });
  });

  it("refuses a bad hash, another key, and a value that is not an object", () => {
    const HEX =
      "operator.secretHash must be the SHA-256 of the secret as 64 lowercase hex characters";
    const bad: [unknown, Partial<AuthConfig>, string][] = [
      [{ secretHash: "A".repeat(64) }, {}, HEX],
      [{ secretHash: "a".repeat(63) }, {}, HEX],
      [{ secretHash: 64 }, {}, HEX],
      [{}, {}, HEX],
      [
        { secretHash: HASH, secret: "x" },
        {},
        "operator.secret is not an option; core has secretHash",
      ],
      [true, {}, "operator must be an object or false"],
    ];
    for (const [operator, extra, message] of bad)
      expect(() => resolveConfig({ ...base, ...extra, operator: operator as never })).toThrowError(
        message,
      );
  });
});
