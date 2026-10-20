import { describe, expect, it } from "vitest";
import { type AuthConfig, ConfigError } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { CORE_PREFIXES } from "../src/primitives/credentials.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { APP_ORIGIN, BASE_URL, makeAuth } from "./helpers.js";

// Plan 12k Task 7: the per-token window, the quota, the moved prefixes, and
// `authenticate` (spec 29 items 12, 13, and 16; rulings 3, 4, and 12 of 12k).

/**
 * One core instance on a memory storage, a memory limiter, and a clock that
 * the test moves. `reads` logs each findOne by its model.
 */
function useHandle(over: Partial<AuthConfig> = {}) {
  const base = makeAuth();
  const reads: string[] = [];
  const storage: StorageAdapter = {
    ...base.storage,
    findOne(model, where) {
      reads.push(model);
      return base.storage.findOne(model, where);
    },
  };
  const auth = createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage,
    mail: { send: async () => {} },
    clock: base.clock,
    limiter: base.config.limiter,
    ...over,
  });
  return { ...base, auth, reads };
}
type Handle = ReturnType<typeof useHandle>;

function mustOk<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

const request = (token: string, path = "/app") =>
  new Request(`${BASE_URL}${path}`, { headers: { authorization: `Bearer ${token}` } });

/** The code of `authenticate`, or "ok". */
async function code(h: Handle, token: string): Promise<string> {
  const r = await h.auth.authenticate(request(token));
  return r.ok ? "ok" : r.code;
}

async function remaining(h: Handle): Promise<(number | null)[]> {
  return (await h.storage.findMany("apiToken", [])).map((r) => r.remaining);
}

describe("the per-token window (plan 12k Task 7)", () => {
  it("keys the window by the token, not by the user", async () => {
    const h = useHandle();
    const ada = await h.seedUser("ada@example.com");
    const window = { seconds: 60, max: 1 };
    const one = mustOk(
      await h.auth.api.tokens.create({ user: ada, name: "one", rateLimit: window }),
    );
    const two = mustOk(
      await h.auth.api.tokens.create({ user: ada, name: "two", rateLimit: window }),
    );
    expect(one.apiToken.rateLimit).toEqual(window);
    expect([await code(h, one.token), await code(h, two.token)]).toEqual(["ok", "ok"]);
    expect([await code(h, one.token), await code(h, two.token)]).toEqual([
      "rate_limited",
      "rate_limited",
    ]);
    // The window ends, and each token acts once more.
    h.clock.advance(60_000);
    expect([await code(h, one.token), await code(h, two.token)]).toEqual(["ok", "ok"]);
  });

  it("answers 429 from authenticate and from /tokens/current, and null from caller, over the window", async () => {
    const h = useHandle();
    const ada = await h.seedUser("ada@example.com");
    const { token } = mustOk(
      await h.auth.api.tokens.create({ user: ada, name: "ci", rateLimit: { seconds: 60, max: 1 } }),
    );
    expect(await h.auth.caller(request(token))).toMatchObject({ kind: "token" });
    expect(await h.auth.authenticate(request(token))).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    expect(await h.auth.caller(request(token))).toBeNull();
    const res = await h.auth.handle(request(token, "/auth/tokens/current"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("starts a new count when the window changes", async () => {
    const h = useHandle();
    const ada = await h.seedUser("ada@example.com");
    const made = mustOk(
      await h.auth.api.tokens.create({ user: ada, name: "ci", rateLimit: { seconds: 60, max: 1 } }),
    );
    expect(await code(h, made.token)).toBe("ok");
    expect(await code(h, made.token)).toBe("rate_limited");
    const changed = mustOk(
      await h.auth.api.tokens.update({
        user: ada,
        id: made.apiToken.id,
        rateLimit: { seconds: 60, max: 2 },
      }),
    );
    expect(changed.rateLimit).toEqual({ seconds: 60, max: 2 });
    // The limiter keeps the window in its key, so the new window counts from zero.
    expect(await code(h, made.token)).toBe("ok");
    expect(await code(h, made.token)).toBe("ok");
    expect(await code(h, made.token)).toBe("rate_limited");
  });

  it("fills a new token with tokens.defaultRateLimit", async () => {
    const h = useHandle({ tokens: { defaultRateLimit: { seconds: 30, max: 1 } } });
    const ada = await h.seedUser("ada@example.com");
    const filled = mustOk(await h.auth.api.tokens.create({ user: ada, name: "a" }));
    const own = mustOk(
      await h.auth.api.tokens.create({ user: ada, name: "b", rateLimit: { seconds: 60, max: 5 } }),
    );
    expect(filled.apiToken.rateLimit).toEqual({ seconds: 30, max: 1 });
    expect(own.apiToken.rateLimit).toEqual({ seconds: 60, max: 5 });
    expect(await code(h, filled.token)).toBe("ok");
    expect(await code(h, filled.token)).toBe("rate_limited");
  });

  it("spends nothing on a call refused by the window", async () => {
    const h = useHandle();
    const ada = await h.seedUser("ada@example.com");
    const { token } = mustOk(
      await h.auth.api.tokens.create({
        user: ada,
        name: "ci",
        rateLimit: { seconds: 60, max: 1 },
        quota: { remaining: 5 },
      }),
    );
    expect(await code(h, token)).toBe("ok");
    expect(await remaining(h)).toEqual([4]);
    expect(await code(h, token)).toBe("rate_limited");
    expect(await code(h, token)).toBe("rate_limited");
    expect(await remaining(h)).toEqual([4]);
  });
});

describe("the quota (plan 12k Task 7)", () => {
  it("spends one call per resolve and answers token_exhausted at zero", async () => {
    const h = useHandle();
    const ada = await h.seedUser("ada@example.com");
    const { token } = mustOk(
      await h.auth.api.tokens.create({ user: ada, name: "ci", quota: { remaining: 2 } }),
    );
    const first = mustOk(await h.auth.authenticate(request(token)));
    expect(first.kind === "token" && first.apiToken.remaining).toBe(1);
    expect(await code(h, token)).toBe("ok");
    expect(await remaining(h)).toEqual([0]);
    expect(await code(h, token)).toBe("token_exhausted");
    expect(await h.auth.caller(request(token))).toBeNull();
    const res = await h.auth.handle(request(token, "/auth/tokens/current"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "token_exhausted" });
    // No spend takes the count below zero.
    expect(await remaining(h)).toEqual([0]);
  });

  it("refills to refillAmount when the interval passed", async () => {
    const h = useHandle();
    const ada = await h.seedUser("ada@example.com");
    const { token } = mustOk(
      await h.auth.api.tokens.create({
        user: ada,
        name: "ci",
        quota: { remaining: 1, refillAmount: 5, refillSeconds: 60 },
      }),
    );
    expect(await code(h, token)).toBe("ok");
    expect(await code(h, token)).toBe("token_exhausted");
    h.clock.advance(59_000);
    expect(await code(h, token)).toBe("token_exhausted");
    h.clock.advance(1_000);
    // The refill sets the count to refillAmount; this call spends one of it.
    expect(await code(h, token)).toBe("ok");
    const [row] = await h.storage.findMany("apiToken", []);
    expect(row).toMatchObject({ remaining: 4, lastRefillAt: h.clock.now() });
    // The next refill counts from lastRefillAt, not from createdAt.
    h.clock.advance(30_000);
    expect(await code(h, token)).toBe("ok");
    expect(await remaining(h)).toEqual([3]);
  });

  it("spends once per request through caller and authenticate", async () => {
    const h = useHandle();
    const ada = await h.seedUser("ada@example.com");
    const { token } = mustOk(
      await h.auth.api.tokens.create({ user: ada, name: "ci", quota: { remaining: 5 } }),
    );
    const one = request(token);
    expect(await h.auth.caller(one)).toMatchObject({ kind: "token" });
    expect(await h.auth.caller(one)).toMatchObject({ kind: "token" });
    expect(await h.auth.authenticate(one)).toMatchObject({ ok: true });
    expect(await remaining(h)).toEqual([4]);
    // Another request spends again.
    expect(await code(h, token)).toBe("ok");
    expect(await remaining(h)).toEqual([3]);
  });

  it("tries again while another call spends first, and answers conflict after 20 lost tries", async () => {
    const h = useHandle();
    const ada = await h.seedUser("ada@example.com");
    const { token } = mustOk(
      await h.auth.api.tokens.create({ user: ada, name: "ci", quota: { remaining: 100 } }),
    );
    // Before each spend of this instance, another instance on the same storage spends first.
    let rivals = 0;
    const rival = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: h.storage,
      mail: { send: async () => {} },
      clock: h.clock,
    });
    const storage: StorageAdapter = {
      ...h.storage,
      async update(model, where, data) {
        if (model === "apiToken" && "remaining" in data) {
          rivals++;
          expect(await code({ ...h, auth: rival }, token)).toBe("ok");
        }
        return h.storage.update(model, where, data);
      },
    };
    const loser = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage,
      mail: { send: async () => {} },
      clock: h.clock,
    });
    const res = await loser.handle(request(token, "/auth/tokens/current"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict" });
    // Each lost try saw a new count, so the spend tried 20 times and spent nothing for itself.
    expect(rivals).toBe(20);
    expect(await remaining(h)).toEqual([80]);
  });

  it("spends after rival spends that end before the bound", async () => {
    const h = useHandle();
    const ada = await h.seedUser("ada@example.com");
    const { token } = mustOk(
      await h.auth.api.tokens.create({ user: ada, name: "ci", quota: { remaining: 100 } }),
    );
    const rival = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: h.storage,
      mail: { send: async () => {} },
      clock: h.clock,
    });
    // The rival spends before each of the first 19 tries, so the 20th try wins.
    let tries = 0;
    const storage: StorageAdapter = {
      ...h.storage,
      async update(model, where, data) {
        if (model === "apiToken" && "remaining" in data && ++tries < 20)
          expect(await code({ ...h, auth: rival }, token)).toBe("ok");
        return h.storage.update(model, where, data);
      },
    };
    const winner = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage,
      mail: { send: async () => {} },
      clock: h.clock,
    });
    const r = mustOk(await winner.authenticate(request(token)));
    expect(r.kind === "token" && r.apiToken.remaining).toBe(80);
    expect(tries).toBe(20);
    expect(await remaining(h)).toEqual([80]);
  });

  it("answers conflict at once when a try loses and the row shows no other spend", async () => {
    const h = useHandle();
    const ada = await h.seedUser("ada@example.com");
    const { token } = mustOk(
      await h.auth.api.tokens.create({ user: ada, name: "ci", quota: { remaining: 10 } }),
    );
    // An adapter whose compare of the count never matches: each spend writes zero rows.
    let spends = 0;
    const storage: StorageAdapter = {
      ...h.storage,
      async update(model, where, data) {
        if (model === "apiToken" && "remaining" in data) {
          spends++;
          return 0;
        }
        return h.storage.update(model, where, data);
      },
    };
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage,
      mail: { send: async () => {} },
      clock: h.clock,
    });
    expect(await auth.authenticate(request(token))).toMatchObject({ ok: false, code: "conflict" });
    expect(spends).toBe(1);
    expect(await remaining(h)).toEqual([10]);
  });

  it("answers conflict to a quota update when spends ran between its read and its write", async () => {
    const h = useHandle();
    const ada = await h.seedUser("ada@example.com");
    const made = mustOk(
      await h.auth.api.tokens.create({ user: ada, name: "ci", quota: { remaining: 10 } }),
    );
    // The first use stamps lastUsedAt; spends within the hour then write the count only.
    expect(await code(h, made.token)).toBe("ok");
    h.clock.advance(60_000);
    let hook: (() => Promise<void>) | null = async () => {
      for (let i = 0; i < 7; i++) expect(await code(h, made.token)).toBe("ok");
    };
    const storage: StorageAdapter = {
      ...h.storage,
      async findOne(model, where) {
        const row = await h.storage.findOne(model, where);
        const run = hook;
        // The update reads the row by id and user id; a resolve reads it by its hash.
        if (model === "apiToken" && where.some((w) => w.field === "userId") && run) {
          hook = null;
          await run();
        }
        return row;
      },
    };
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage,
      mail: { send: async () => {} },
      clock: h.clock,
    });
    expect(
      await auth.api.tokens.update({ user: ada, id: made.apiToken.id, quota: { remaining: 5 } }),
    ).toMatchObject({ ok: false, code: "conflict" });
    // The row keeps the spent count: the update would give back three calls that nobody sold.
    expect(await remaining(h)).toEqual([2]);
  });

  it("lowers the quota and drops the refill in process, and refuses a raise", async () => {
    const h = useHandle();
    const ada = await h.seedUser("ada@example.com");
    const made = mustOk(
      await h.auth.api.tokens.create({
        user: ada,
        name: "ci",
        quota: { remaining: 10, refillAmount: 10, refillSeconds: 60 },
      }),
    );
    const id = made.apiToken.id;
    for (const quota of [
      null,
      { remaining: 11, refillAmount: 10, refillSeconds: 60 },
      { remaining: 5, refillAmount: 20, refillSeconds: 60 },
      { remaining: 5, refillAmount: 10, refillSeconds: 30 },
    ])
      expect(await h.auth.api.tokens.update({ user: ada, id, quota })).toMatchObject({
        ok: false,
        code: "invalid_body",
      });
    expect(
      mustOk(
        await h.auth.api.tokens.update({
          user: ada,
          id,
          quota: { remaining: 5, refillAmount: 10, refillSeconds: 60 },
        }),
      ).remaining,
    ).toBe(5);
    expect(
      mustOk(await h.auth.api.tokens.update({ user: ada, id, quota: { remaining: 3 } })),
    ).toMatchObject({
      remaining: 3,
    });
    const [row] = await h.storage.findMany("apiToken", []);
    expect(row).toMatchObject({ remaining: 3, refillAmount: null, refillSeconds: null });
    // A refill may not come back once it is gone.
    expect(
      await h.auth.api.tokens.update({
        user: ada,
        id,
        quota: { remaining: 3, refillAmount: 1, refillSeconds: 60 },
      }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
  });
});

describe("the moved prefixes (plan 12k Task 7, rulings 4 and 12)", () => {
  it("answers token_retired for a moved prefix with no row, and reads nothing for a malformed one", async () => {
    const h = useHandle({ tokens: { movedPrefixes: ["laaa_"] } });
    const old = `laaa_${"A".repeat(32)}`;
    expect(await h.auth.authenticate(request(old))).toMatchObject({
      ok: false,
      code: "token_retired",
    });
    expect(await h.auth.caller(request(old))).toBeNull();
    const res = await h.auth.handle(request(old, "/auth/tokens/current"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "token_retired" });
    h.reads.length = 0;
    for (const bad of ["laaa_", "laaa_a.b", `laaa_${"a".repeat(257)}`])
      expect(await h.auth.authenticate(request(bad))).toMatchObject({
        ok: false,
        code: "unauthorized",
      });
    expect(h.reads).toEqual([]);
  });

  it("refuses a moved prefix that a core credential uses or that has a bad form", () => {
    const make = (movedPrefixes: string[]) => () =>
      createAuth({
        baseURL: BASE_URL,
        secret: "0123456789abcdef0123456789abcdef",
        trustedOrigins: [],
        storage: makeAuth().storage,
        mail: { send: async () => {} },
        tokens: { movedPrefixes },
      });
    for (const p of [
      "tk_",
      "ts_",
      "to_",
      "inv_",
      "Laaa_",
      "laaa",
      "1aaa_",
      "a_b_",
      "abcdefghijklmnopq_",
    ])
      expect(make([p]), p).toThrow(ConfigError);
    expect(make(["laaa_", "laaa_"])).toThrow(ConfigError);
    expect(make(["laaa_", "mst_"])).not.toThrow();
  });

  it("lists in CORE_PREFIXES the prefix of every randomToken call of core", async () => {
    // Core's typecheck has no Node types; the specifier in a constant keeps node:fs out of it.
    const FS = "node:fs";
    const fs: {
      readdirSync(dir: URL, o: { recursive: true }): string[];
      readFileSync(file: URL, encoding: "utf8"): string;
    } = await import(/* @vite-ignore */ FS);
    const src = new URL("../src/", import.meta.url);
    const files = fs.readdirSync(src, { recursive: true }).filter((f) => f.endsWith(".ts"));
    const texts = files.map((f) => fs.readFileSync(new URL(f, src), "utf8"));
    const values = new Map<string, string>();
    for (const t of texts)
      for (const m of t.matchAll(/const ([A-Z_]+) = "([^"]+)";/g))
        values.set(m[1] as string, m[2] as string);
    const used = new Set<string>();
    for (const t of texts)
      for (const m of t.matchAll(/randomToken\(([A-Z_]+)\)/g)) {
        const value = values.get(m[1] as string);
        expect(value, m[1]).toBeDefined();
        used.add(value as string);
      }
    // Count what ran: 20 calls give 19 prefixes (two calls use CLIENT_ID_PREFIX).
    expect(used.size).toBe(19);
    for (const p of used) expect(CORE_PREFIXES, p).toContain(p);
  });
});

describe("the bounds of the window and the quota (plan 12k Task 7, ruling 9)", () => {
  const badQuotas = [
    { remaining: -1 },
    { remaining: 1.5 },
    { remaining: Number.NaN },
    { remaining: 2147483648 },
    { remaining: 1, refillAmount: 2147483648, refillSeconds: 60 },
    { remaining: 1, refillAmount: 1, refillSeconds: 0 },
    { remaining: 1, refillAmount: 1 },
    { remaining: 1, refillSeconds: 60 },
  ];
  const badWindows = [
    { seconds: 0, max: 1 },
    { seconds: 86401, max: 1 },
    { seconds: 60, max: 100001 },
    { seconds: 1.5, max: 1 },
  ];
  const topQuota = { remaining: 2147483647, refillAmount: 2147483647, refillSeconds: 2147483647 };
  const topWindow = { seconds: 86400, max: 100000 };

  it("refuses each value out of bounds at the create, and takes the largest", async () => {
    const h = useHandle();
    const ada = await h.seedUser("ada@example.com");
    for (const quota of badQuotas)
      expect(
        await h.auth.api.tokens.create({ user: ada, name: "ci", quota }),
        JSON.stringify(quota),
      ).toMatchObject({ ok: false, code: "invalid_body" });
    for (const rateLimit of badWindows)
      expect(
        await h.auth.api.tokens.create({ user: ada, name: "ci", rateLimit }),
        JSON.stringify(rateLimit),
      ).toMatchObject({ ok: false, code: "invalid_body" });
    expect(await h.storage.findMany("apiToken", [])).toEqual([]);
    const made = mustOk(
      await h.auth.api.tokens.create({
        user: ada,
        name: "ci",
        quota: topQuota,
        rateLimit: topWindow,
      }),
    );
    expect(made.apiToken).toMatchObject({ remaining: 2147483647, rateLimit: topWindow });
  });

  it("refuses each value out of bounds at the update, and takes the largest", async () => {
    const h = useHandle();
    const ada = await h.seedUser("ada@example.com");
    // A token with no window and no quota takes any valid one, so only the bounds refuse.
    const { apiToken } = mustOk(await h.auth.api.tokens.create({ user: ada, name: "ci" }));
    const id = apiToken.id;
    for (const quota of badQuotas)
      expect(
        await h.auth.api.tokens.update({ user: ada, id, quota }),
        JSON.stringify(quota),
      ).toMatchObject({ ok: false, code: "invalid_body" });
    for (const rateLimit of badWindows)
      expect(
        await h.auth.api.tokens.update({ user: ada, id, rateLimit }),
        JSON.stringify(rateLimit),
      ).toMatchObject({ ok: false, code: "invalid_body" });
    const [row] = await h.storage.findMany("apiToken", []);
    expect(row).toMatchObject({ remaining: null, rateLimitSeconds: null, rateLimitMax: null });
    expect(
      mustOk(
        await h.auth.api.tokens.update({ user: ada, id, quota: topQuota, rateLimit: topWindow }),
      ),
    ).toMatchObject({ remaining: 2147483647, rateLimit: topWindow });
  });

  it("refuses each window out of bounds in tokens.defaultRateLimit, and takes the largest", () => {
    for (const defaultRateLimit of badWindows)
      expect(
        () => useHandle({ tokens: { defaultRateLimit } }),
        JSON.stringify(defaultRateLimit),
      ).toThrow(ConfigError);
    expect(() => useHandle({ tokens: { defaultRateLimit: topWindow } })).not.toThrow();
  });
});
