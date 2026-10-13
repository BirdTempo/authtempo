import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../src/config.js";
import { completeSocial, startSocial } from "../src/engine/social.js";
import { createRouter } from "../src/http/router.js";
import { socialRoutes } from "../src/http/routes/social.js";
import { type ModelName, schema } from "../src/schema.js";
import type { OAuth2Entry } from "../src/social/oauth2.js";
import { PROVIDER_TIMEOUT_MS, type SocialProfile } from "../src/social/provider.js";
import { BASE_URL, get, makeAuth } from "./helpers.js";
import { fakeFetch, stateRow, type TokenCall } from "./social-helpers.js";

const ACCESS = "acme-access-token-0001";
const PERSON: SocialProfile = {
  subject: "acme-7",
  email: "ada@example.com",
  emailVerified: true,
  name: "Ada",
  image: null,
};

function acme(userinfo: OAuth2Entry["userinfo"]): OAuth2Entry {
  return {
    name: "acme",
    label: "Continue with Acme",
    authorizeUrl: "https://id.acme.example/oauth/authorize",
    tokenUrl: "https://id.acme.example/oauth/token",
    clientId: "acme-id",
    clientSecret: "acme-secret",
    scope: "user email",
    authorizeParams: { prompt: "consent" },
    userinfo,
  };
}

/** One oauth2 provider. The token endpoint answers ACCESS unless `token` says otherwise. */
function acmeAuth(
  userinfo: OAuth2Entry["userinfo"],
  token: (call: TokenCall) => Response = () =>
    Response.json({ access_token: ACCESS, token_type: "bearer" }),
) {
  const { fetchFn, calls } = fakeFetch(token);
  return { ...makeAuth({ social: { oauth2: [acme(userinfo)], fetch: fetchFn } }), calls };
}

async function started(auth: { config: ResolvedConfig }, next = "/home") {
  const r = await startSocial(auth.config, { provider: "acme", next, ip: "1.1.1.1" });
  if (!r.ok) throw new Error(`start failed: ${r.code}`);
  const url = new URL(r.value.location);
  return { url, state: url.searchParams.get("state") ?? "", bindToken: r.value.bindToken };
}

function complete(
  auth: { config: ResolvedConfig },
  s: Awaited<ReturnType<typeof started>>,
  over: Partial<Parameters<typeof completeSocial>[1]> = {},
) {
  return completeSocial(auth.config, {
    provider: "acme",
    state: s.state,
    code: "code-1",
    error: null,
    bindToken: s.bindToken,
    ip: "1.1.1.1",
    userAgent: "ua",
    ...over,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("an oauth2 provider (plan 9c)", () => {
  it("redirects with state and an S256 challenge, the entry's scope and params, and no nonce", async () => {
    const auth = acmeAuth(async () => PERSON);
    const { url, state } = await started(auth);
    expect(url.origin + url.pathname).toBe("https://id.acme.example/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("acme-id");
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE_URL}/auth/social/acme/callback`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.search).toContain("scope=user%20email");
    expect(url.searchParams.has("nonce")).toBe(false);
    expect(await stateRow(auth.storage, state)).toMatchObject({
      purpose: "oauth-state",
      identifier: "acme",
      consumedAt: null,
    });
  });

  it("exchanges the code with PKCE, calls userinfo with the access token, and links by the spec's rule", async () => {
    const seen: string[] = [];
    const auth = acmeAuth(async (token) => {
      seen.push(token);
      return PERSON;
    });
    const s = await started(auth);
    const r = await complete(auth, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(seen).toEqual([ACCESS]);
    expect(r.value.next).toBe("/home");
    expect(r.value.user).toMatchObject({
      email: "ada@example.com",
      emailVerified: true,
      name: "Ada",
    });
    const row = await stateRow(auth.storage, s.state);
    expect(auth.calls[0]?.url).toBe("https://id.acme.example/oauth/token");
    expect(auth.calls[0]?.form).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: `${BASE_URL}/auth/social/acme/callback`,
      client_id: "acme-id",
      client_secret: "acme-secret",
      code_verifier: (row?.data as { verifier: string } | undefined)?.verifier,
    });
    const identities = await auth.storage.findMany("identity", [], {
      sort: { field: "provider", dir: "asc" },
    });
    expect(identities.map((i) => [i.provider, i.subject])).toEqual([
      ["acme", "acme-7"],
      ["email", "ada@example.com"],
    ]);
    expect(await auth.storage.findMany("session", [])).toHaveLength(1);
  });

  it("gives userinfo a fetch whose own signal aborts at PROVIDER_TIMEOUT_MS", async () => {
    // A fake AbortSignal.timeout on fake timers, so the test can move the clock to the limit.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException("timed out", "TimeoutError")), ms);
      return c.signal;
    });
    const urls: string[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      signals.push(init?.signal);
      if (url === "https://id.acme.example/oauth/token")
        return Response.json({ access_token: ACCESS });
      return Response.json({ id: "acme-9" });
    };
    const auth = makeAuth({
      social: {
        oauth2: [
          acme(async (token, f) => {
            const res = await f("https://api.acme.example/me", {
              headers: { authorization: `Bearer ${token}` },
            });
            const u = (await res.json()) as { id: string };
            return { ...PERSON, subject: u.id };
          }),
        ],
        fetch: fetchFn,
      },
    });
    const r = await complete(auth, await started(auth));
    expect(r.ok).toBe(true);
    expect(urls).toEqual(["https://id.acme.example/oauth/token", "https://api.acme.example/me"]);
    const [tokenSignal, userSignal] = signals;
    expect(userSignal).toBeInstanceOf(AbortSignal);
    // The user info step has its own deadline, not the one of the token exchange.
    expect(userSignal).not.toBe(tokenSignal);
    expect(PROVIDER_TIMEOUT_MS).toBe(10_000);
    vi.advanceTimersByTime(PROVIDER_TIMEOUT_MS - 1);
    expect(userSignal?.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(userSignal?.aborted).toBe(true);
  });

  it("passes the method, the headers, and the body of a userinfo fetch through and adds only the signal", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://id.acme.example/oauth/token")
        return Response.json({ access_token: ACCESS });
      inits.push(init);
      return Response.json({});
    };
    const auth = makeAuth({
      social: {
        oauth2: [
          acme(async (_token, f) => {
            await f("https://api.acme.example/me", {
              method: "POST",
              headers: { "x-a": "1" },
              body: "b",
            });
            return PERSON;
          }),
        ],
        fetch: fetchFn,
      },
    });
    expect((await complete(auth, await started(auth))).ok).toBe(true);
    expect(inits).toHaveLength(1);
    const { signal, ...rest } = inits[0] ?? {};
    expect(rest).toEqual({ method: "POST", headers: { "x-a": "1" }, body: "b" });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("answers oauth_failed when userinfo never settles, clears the binding cookie, and logs TimeoutError (Review Focus 3)", async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(20));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const auth = acmeAuth(() => {
      calls++;
      return new Promise<SocialProfile>(() => {});
    });
    const handle = createRouter(auth.config, socialRoutes(auth.config));
    const start = await handle(get("/auth/social/acme/start"));
    const bind = start.headers.get("set-cookie")?.split(";")[0] ?? "";
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const res = await handle(
      get(`/auth/social/acme/callback?code=c1&state=${encodeURIComponent(state)}`, {
        cookie: bind,
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE_URL}/?auth_error=oauth_failed`);
    expect(res.headers.getSetCookie()).toEqual([
      "tempo_session_oauth=; Path=/auth/social; Max-Age=0; HttpOnly; Secure; SameSite=None",
    ]);
    expect(timeout).toHaveBeenCalledWith(PROVIDER_TIMEOUT_MS);
    expect(error).toHaveBeenCalledWith(
      "authtempo: social user info failed",
      "acme",
      "TimeoutError",
    );
    expect(await auth.storage.findMany("user", [])).toHaveLength(0);
    expect(await auth.storage.findMany("session", [])).toHaveLength(0);
    // The state row is consumed before the exchange, so a replay runs no step again.
    const replay = await handle(
      get(`/auth/social/acme/callback?code=c1&state=${encodeURIComponent(state)}`, {
        cookie: bind,
      }),
    );
    expect(replay.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
    expect(calls).toBe(1);
    expect(auth.calls).toHaveLength(1);
  });

  it("answers oauth_failed when userinfo throws, gives no subject, or the token answer has no access token", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const a1 = acmeAuth(async () => {
      throw new Error("boom");
    });
    expect(await complete(a1, await started(a1))).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
    const a2 = acmeAuth(async () => ({ ...PERSON, subject: "" }));
    expect(await complete(a2, await started(a2))).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
    let called = 0;
    // GitHub answers a bad code with 200 and an error body (troubleshooting docs).
    const a3 = acmeAuth(
      async () => {
        called++;
        return PERSON;
      },
      () =>
        Response.json({
          error: "bad_verification_code",
          error_description: "The code passed is incorrect or expired.",
        }),
    );
    expect(await complete(a3, await started(a3))).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
    expect(called).toBe(0);
    expect(error).toHaveBeenCalledWith("authtempo: social token answer has no token", "acme");
    for (const a of [a1, a2, a3]) expect(await a.storage.findMany("user", [])).toHaveLength(0);
  });

  it("counts emailVerified only as the boolean true: a new unverified user, or email_taken_unverified and no link (Review Focus 1)", async () => {
    const unverified = acmeAuth(async () => ({ ...PERSON, emailVerified: false }));
    const r = await complete(unverified, await started(unverified));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.user.emailVerified).toBe(false);
    const ids = await unverified.storage.findMany("identity", []);
    expect(ids.map((i) => i.provider)).toEqual(["acme"]);
    // An app's userinfo that answers the string "true" does not prove the address.
    const taken = acmeAuth(async () => ({
      ...PERSON,
      emailVerified: "true" as unknown as boolean,
    }));
    const owner = await taken.seedUser("ada@example.com");
    expect(await complete(taken, await started(taken))).toMatchObject({
      ok: false,
      code: "email_taken_unverified",
    });
    expect(
      await taken.storage.findMany("identity", [{ field: "userId", op: "eq", value: owner.id }]),
    ).toEqual([]);
    expect(await taken.storage.findMany("session", [])).toHaveLength(0);
  });

  it("consumes the state once: a replayed callback answers invalid_token and calls userinfo once", async () => {
    let calls = 0;
    const auth = acmeAuth(async () => {
      calls++;
      return PERSON;
    });
    const s = await started(auth);
    expect((await complete(auth, s)).ok).toBe(true);
    expect(await complete(auth, s)).toMatchObject({ ok: false, code: "invalid_token" });
    expect(calls).toBe(1);
    expect(auth.calls).toHaveLength(1);
    expect(await auth.storage.findMany("session", [])).toHaveLength(1);
  });

  it("stores no access token in any model and logs none, also when userinfo puts it in an error", async () => {
    const logs: unknown[][] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args);
      });
    const ok = acmeAuth(async () => PERSON);
    expect((await complete(ok, await started(ok))).ok).toBe(true);
    for (const model of Object.keys(schema) as ModelName[])
      expect(JSON.stringify(await ok.storage.findMany(model, []))).not.toContain(ACCESS);
    const failing = acmeAuth(async (token) => {
      throw new Error(`user info refused ${token}`);
    });
    expect(await complete(failing, await started(failing))).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(ACCESS);
  });

  it("logs no app error name that is not a plain error class name, so a token in the name is not logged", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = acmeAuth(async (token) => {
      const e = new Error("refused");
      e.name = `Bad ${token}`;
      throw e;
    });
    expect(await complete(auth, await started(auth))).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
    expect(error).toHaveBeenCalledWith("authtempo: social user info failed", "acme", "Error");
    expect(JSON.stringify(error.mock.calls)).not.toContain(ACCESS);
  });

  it("answers oauth_failed for a subject that is empty, over 255 characters, or holds a control character, and writes no identity", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const subject of ["", "s".repeat(256), "acme\n7"]) {
      const auth = acmeAuth(async () => ({ ...PERSON, subject }));
      expect(await complete(auth, await started(auth))).toMatchObject({
        ok: false,
        code: "oauth_failed",
      });
      expect(await auth.storage.findMany("identity", [])).toEqual([]);
      expect(await auth.storage.findMany("user", [])).toEqual([]);
    }
    expect(error).toHaveBeenCalledWith("authtempo: social user info has a bad subject", "acme");
    expect(error).toHaveBeenCalledTimes(3);
    const max = acmeAuth(async () => ({ ...PERSON, subject: "s".repeat(255) }));
    expect((await complete(max, await started(max))).ok).toBe(true);
  });

  it("answers invalid_token for a callback with no binding cookie or a wrong one, and calls no token endpoint and no userinfo (final review M-1)", async () => {
    let userinfoCalls = 0;
    const auth = acmeAuth(async () => {
      userinfoCalls++;
      return PERSON;
    });
    for (const bindToken of [null, "not-the-binding-value"]) {
      const s = await started(auth);
      expect(await complete(auth, s, { bindToken })).toMatchObject({
        ok: false,
        code: "invalid_token",
      });
    }
    expect(userinfoCalls).toBe(0);
    expect(auth.calls).toEqual([]);
  });

  it("answers oauth_failed when a field of the userinfo answer throws on read (final review M-7)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = acmeAuth(
      async () =>
        ({
          subject: "acme-7",
          get email(): string {
            throw new TypeError("getter");
          },
        }) as unknown as SocialProfile,
    );
    expect(await complete(auth, await started(auth))).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
    expect(await auth.storage.findMany("identity", [])).toEqual([]);
  });

  it("drops a name or an image that breaks its bound, and keeps a valid one", async () => {
    const bad = acmeAuth(async () => ({
      ...PERSON,
      name: "x".repeat(201),
      image: `https://img.acme.example/${"a".repeat(2048)}`,
    }));
    const r1 = await complete(bad, await started(bad));
    expect(r1.ok && r1.value.user).toMatchObject({ name: null, image: null });
    const ctl = acmeAuth(async () => ({
      ...PERSON,
      name: "Ada\r\nX",
      image: "https://img.acme.example/a\n",
    }));
    const r2 = await complete(ctl, await started(ctl));
    expect(r2.ok && r2.value.user).toMatchObject({ name: null, image: null });
    const good = acmeAuth(async () => ({
      ...PERSON,
      name: "x".repeat(200),
      image: "https://img.acme.example/a.png",
    }));
    const r3 = await complete(good, await started(good));
    expect(r3.ok && r3.value.user).toMatchObject({
      name: "x".repeat(200),
      image: "https://img.acme.example/a.png",
    });
  });

  it("serves GET start and GET callback for the entry, and 404 for a name that is not configured", async () => {
    const auth = acmeAuth(async () => PERSON);
    const handle = createRouter(auth.config, socialRoutes(auth.config));
    const start = await handle(get("/auth/social/acme/start?next=%2Fhome"));
    expect(start.status).toBe(302);
    const bind = start.headers.get("set-cookie")?.split(";")[0] ?? "";
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const done = await handle(
      get(`/auth/social/acme/callback?code=c1&state=${encodeURIComponent(state)}`, {
        cookie: bind,
      }),
    );
    expect(done.headers.get("location")).toBe(`${BASE_URL}/home`);
    expect(done.headers.getSetCookie().some((c) => /^tempo_session=ts_/.test(c))).toBe(true);
    expect((await handle(get("/auth/social/other/start"))).status).toBe(404);
  });
});
