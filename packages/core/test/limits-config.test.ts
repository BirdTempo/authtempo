import { describe, expect, it } from "vitest";
import { ConfigError, resolveConfig } from "../src/config.js";
import { configKeyPaths } from "../src/config-paths.js";
import { requestEmailOtp } from "../src/engine/email-otp.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { LIMIT_FAMILIES, limit, spendLimit } from "../src/limiter/limit.js";
import { LIMITS_FROM_SETTINGS, type LimitsConfig } from "../src/limiter/limits-config.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import type { LimiterPort, LimitWindow } from "../src/limiter/port.js";
import type { AuthEvent } from "../src/observe/port.js";
import { get, makeAuth, post } from "./helpers.js";
import { observed } from "./observe-helpers.js";

const ADDRESS = "a@example.com";
const IP = { "cf-connecting-ip": "203.0.113.9" };

/** A limiter port that keeps each call, over a real memory limiter. */
function recording(clock: { now(): Date }) {
  const inner = createMemoryLimiter(clock);
  const calls: { key: string; window: LimitWindow }[] = [];
  const port: LimiterPort = {
    allow(key, window) {
      calls.push({ key, window });
      return inner.allow(key, window);
    },
  };
  return { port, calls };
}

/** An auth with `limits` and a recording limiter on one clock. */
function withLimits(limits: LimitsConfig | undefined, more: Parameters<typeof makeAuth>[0] = {}) {
  const base = makeAuth();
  const { port, calls } = recording(base.clock);
  const auth = makeAuth({
    limiter: port,
    clock: base.clock,
    ...(limits === undefined ? {} : { limits }),
    ...more,
  });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  // `makeAuth` returns a clock of its own. The config and the limiter use the clock of `base`.
  return { ...auth, clock: base.clock, calls, handle };
}

const base = () => {
  const { storage } = makeAuth();
  return {
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: ["https://app.example.com"],
    storage,
    mail: { send: async () => {} },
  };
};
const refusal = (limits: unknown) => {
  try {
    resolveConfig({ ...base(), limits: limits as LimitsConfig });
  } catch (e) {
    return e instanceof ConfigError ? e.message : `not a ConfigError: ${String(e)}`;
  }
  return "no refusal";
};

describe("the config of limits", () => {
  it("is off when absent: no window changes, and a request with no client IP shares a count", () => {
    const { limits } = resolveConfig(base());
    expect(limits.noClientIp).toBe("shared");
    expect([...limits.windows]).toEqual([]);
    expect(resolveConfig({ ...base(), limits: {} }).limits.noClientIp).toBe("shared");
  });

  it("keeps each window that the config names", () => {
    const { limits } = resolveConfig({
      ...base(),
      limits: { windows: { "otp:email": { max: 5 }, "magic-link:ip": { max: 40, seconds: 600 } } },
    });
    expect([...limits.windows]).toEqual([
      ["otp:email", { max: 5 }],
      ["magic-link:ip", { max: 40, seconds: 600 }],
    ]);
  });

  it("refuses a setting, a family, or a number that it does not know", () => {
    expect(refusal("x")).toBe("limits must be an object");
    expect(refusal({ window: {} })).toBe(
      "limits.window is not a setting; the settings are noClientIp and windows",
    );
    expect(refusal({ noClientIp: "skip" })).toBe('limits.noClientIp must be "shared" or "refuse"');
    expect(refusal({ windows: [] })).toBe("limits.windows must be an object");
    expect(refusal({ windows: { "otp:mail": { max: 5 } } })).toBe(
      'limits.windows["otp:mail"] names no limit family; the limits page lists each family',
    );
    expect(refusal({ windows: { "otp:email": 5 } })).toBe(
      'limits.windows["otp:email"] must be an object with max',
    );
    expect(refusal({ windows: { "otp:email": { max: 5, window: 60 } } })).toBe(
      'limits.windows["otp:email"].window is not a setting; the settings are max and seconds',
    );
    for (const max of [0, -1, 1.5, 100_001, "5", null, undefined, Number.NaN])
      expect([max, refusal({ windows: { "otp:email": { max } } })]).toEqual([
        max,
        'limits.windows["otp:email"].max must be a whole number from 1 to 100000',
      ]);
    for (const seconds of [0, 0.5, 86_401, "60", null])
      expect([seconds, refusal({ windows: { "otp:email": { max: 5, seconds } } })]).toEqual([
        seconds,
        'limits.windows["otp:email"].seconds must be a whole number from 1 to 86400',
      ]);
    // The two ends of each range pass.
    expect(refusal({ windows: { "otp:email": { max: 1, seconds: 1 } } })).toBe("no refusal");
    expect(refusal({ windows: { "otp:email": { max: 100_000, seconds: 86_400 } } })).toBe(
      "no refusal",
    );
  });

  it("refuses each family whose window comes from another setting, and names that setting", () => {
    const families = Object.keys(LIMITS_FROM_SETTINGS);
    expect(families.sort()).toEqual([
      "anonymous:all-day",
      "oauth-device-poll:code",
      "passkey-sign-up:all-day",
      "phone-otp:all-day",
      "token-use:tk",
      "token-use:to",
    ]);
    for (const [family, setting] of Object.entries(LIMITS_FROM_SETTINGS))
      expect(refusal({ windows: { [family]: { max: 5 } } })).toBe(
        `limits.windows["${family}"] takes its window from ${setting}; change that setting`,
      );
    // Each family is one of the list of core.
    const all: readonly string[] = LIMIT_FAMILIES;
    for (const family of families) expect(all).toContain(family);
  });

  it("lists the block in the key paths of the operator info, with no value", () => {
    expect(
      configKeyPaths({ ...base(), limits: { noClientIp: "refuse", windows: {} } }).filter((p) =>
        p.startsWith("limits"),
      ),
    ).toEqual(["limits", "limits.noClientIp", "limits.windows"]);
  });
});

describe("a window of limits.windows", () => {
  /** Code requests of one address, each from its own IP, so `otp:ip` never answers first. */
  async function requests(auth: ReturnType<typeof withLimits>, n: number) {
    const codes: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await requestEmailOtp(auth.config, { email: ADDRESS, ip: `10.0.0.${i}` });
      codes.push(r.ok ? "ok" : r.code);
    }
    return codes;
  }

  it("keeps the default of 3 code requests for each address with no override", async () => {
    const auth = withLimits(undefined);
    await auth.seedUser(ADDRESS);
    expect(await requests(auth, 4)).toEqual(["ok", "ok", "ok", "rate_limited"]);
    expect(auth.calls.find((c) => c.key === `otp:email:${ADDRESS}`)?.window).toEqual({
      seconds: 900,
      max: 3,
    });
  });

  it("lets 5 code requests pass with max 5, and refuses the sixth", async () => {
    const auth = withLimits({ windows: { "otp:email": { max: 5 } } });
    await auth.seedUser(ADDRESS);
    expect(await requests(auth, 6)).toEqual(["ok", "ok", "ok", "ok", "ok", "rate_limited"]);
    // The length of the window stays the default: `seconds` is absent.
    expect(auth.calls.find((c) => c.key === `otp:email:${ADDRESS}`)?.window).toEqual({
      seconds: 900,
      max: 5,
    });
    // Another family keeps its own window.
    expect(auth.calls.find((c) => c.key.startsWith("otp:ip:"))?.window).toEqual({
      seconds: 900,
      max: 20,
    });
    expect(auth.mail).toHaveLength(5);
  });

  it("tightens a limit, and ends the window after its own seconds", async () => {
    const auth = withLimits({ windows: { "otp:email": { max: 1, seconds: 60 } } });
    await auth.seedUser(ADDRESS);
    expect(await requests(auth, 2)).toEqual(["ok", "rate_limited"]);
    // 59 s: the window of 60 s holds. The default of 900 s would hold for 14 minutes more.
    auth.clock.advance(59_000);
    expect(await requests(auth, 1)).toEqual(["rate_limited"]);
    auth.clock.advance(2_000);
    expect(await requests(auth, 1)).toEqual(["ok"]);
  });

  it("emits limit.hit for a refusal of a changed window", async () => {
    const o = observed({ limits: { windows: { "magic-link:email": { max: 1 } } } });
    const request = () => o.auth.handle(post("/auth/magic-link/request", { email: ADDRESS }, IP));
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
    const hits = (await o.events()).filter((e: AuthEvent) => e.name === "limit.hit");
    expect(hits).toMatchObject([{ name: "limit.hit", family: "magic-link:email" }]);
  });

  it("spends the changed window, so each later call of that key answers false", async () => {
    const auth = withLimits({ windows: { "sso-large-read:user": { max: 7, seconds: 120 } } });
    const w = { seconds: 3600, max: 2 };
    await spendLimit(auth.config, "sso-large-read:user", "u1", w);
    // max + 1 calls fill the window of the config, not the window of the call.
    expect(auth.calls.map((c) => c.window)).toEqual(Array(8).fill({ seconds: 120, max: 7 }));
    expect(await limit(auth.config, "sso-large-read:user", "u1", w)).toBe(false);
    // A key of another subject is free.
    expect(await limit(auth.config, "sso-large-read:user", "u2", w)).toBe(true);
  });
});

describe("limits.noClientIp", () => {
  const ask = (headers: Record<string, string> = {}) =>
    post("/auth/magic-link/request", { email: ADDRESS }, headers);

  it("shares the count `unknown` by default: one caller with no IP spends it for each other", async () => {
    const auth = withLimits(undefined);
    expect((await auth.handle(ask())).status).toBe(200);
    expect(auth.calls.map((c) => c.key)).toContain("magic-link:ip:unknown");
  });

  it("answers 403 client_ip_missing with refuse, before any route, limit, or write", async () => {
    const auth = withLimits({ noClientIp: "refuse" });
    const requests = [
      ask(),
      get("/auth/session"),
      get("/auth/no-such-route"),
      new Request("https://api.example.com/auth/magic-link/request", {
        method: "OPTIONS",
        headers: { origin: "https://app.example.com", "access-control-request-method": "POST" },
      }),
    ];
    for (const request of requests) {
      const res = await auth.handle(request);
      expect([request.method, new URL(request.url).pathname, res.status]).toEqual([
        request.method,
        new URL(request.url).pathname,
        403,
      ]);
      expect(await res.json()).toEqual({ error: "client_ip_missing" });
    }
    expect(auth.calls).toEqual([]);
    expect(auth.mail).toEqual([]);
    expect(await auth.storage.findMany("verification", [])).toEqual([]);
  });

  it("serves a request with a client IP as before, and counts it on the key of that IP", async () => {
    const auth = withLimits({ noClientIp: "refuse" });
    expect((await auth.handle(ask(IP))).status).toBe(200);
    expect(auth.calls.map((c) => c.key)).toContain("magic-link:ip:203.0.113.9");
    expect(auth.calls.map((c) => c.key).filter((k) => k.endsWith(":unknown"))).toEqual([]);
    expect(auth.mail).toHaveLength(1);
  });

  it("serves a text of a custom clientIp: only a null is no client IP", async () => {
    const auth = withLimits({ noClientIp: "refuse" }, { clientIp: () => "unknown" });
    expect((await auth.handle(ask())).status).toBe(200);
    expect(auth.calls.map((c) => c.key)).toContain("magic-link:ip:text:unknown");
  });

  it("keeps the 500 of a clientIp that throws", async () => {
    const auth = withLimits(
      { noClientIp: "refuse" },
      {
        clientIp: () => {
          throw new Error("the header parse failed");
        },
      },
    );
    const res = await auth.handle(ask());
    expect([res.status, await res.json()]).toEqual([500, { error: "internal" }]);
  });

  it("puts the code on the request event", async () => {
    const o = observed({ limits: { noClientIp: "refuse" } });
    expect((await o.auth.handle(ask())).status).toBe(403);
    const request = (await o.events()).filter((e: AuthEvent) => e.name === "request");
    expect(request).toMatchObject([{ status: 403, code: "client_ip_missing" }]);
  });

  it("throws at an in-process call with ip null, and names what to pass", async () => {
    const auth = withLimits({ noClientIp: "refuse" });
    await auth.seedUser(ADDRESS);
    await expect(requestEmailOtp(auth.config, { email: ADDRESS, ip: null })).rejects.toThrow(
      'authtempo: limits.noClientIp is "refuse", and a call counted otp:ip with no client IP. Pass the client IP of the person as ip. For a call with no person, pass a fixed text that names the caller.',
    );
    expect(auth.calls).toEqual([]);
    expect(auth.mail).toEqual([]);
    // An IP passes, and so does a fixed text.
    expect((await requestEmailOtp(auth.config, { email: ADDRESS, ip: "10.0.0.1" })).ok).toBe(true);
    expect((await requestEmailOtp(auth.config, { email: ADDRESS, ip: "admin-tool" })).ok).toBe(
      true,
    );
    expect(auth.calls.map((c) => c.key)).toContain("otp:ip:text:admin-tool");
  });

  it("takes the subject `unknown` of a family that is not per IP", async () => {
    const auth = withLimits({ noClientIp: "refuse" });
    const w = { seconds: 60, max: 1 };
    // A user id or an address can be this text. The rule reads the family too.
    expect(await limit(auth.config, "magic-link:email", "unknown", w)).toBe(true);
    await expect(limit(auth.config, "magic-link:ip", "unknown", w)).rejects.toThrow(
      "magic-link:ip with no client IP",
    );
    // Each per-IP family refuses the shared key.
    for (const family of LIMIT_FAMILIES.filter((f) => f.endsWith(":ip")))
      await expect(limit(auth.config, family, "unknown", w)).rejects.toThrow(
        `${family} with no client IP`,
      );
  });
});
