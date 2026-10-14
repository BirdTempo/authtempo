import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { createJoseJwtSeam } from "../src/seams/jwt.js";
import { ProviderRedirectError, providerFetch } from "../src/social/provider-fetch.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { TEST_SECRET } from "../src/testing/soft-authenticator.js";
import { fakeJwt, GOOGLE } from "./social-helpers.js";

interface Seen {
  url: string;
  redirect: RequestRedirect | undefined;
}

/** A fetch that records the URL and `init.redirect` of each call, and answers by URL. */
function recording(answer: (url: string) => Response) {
  const seen: Seen[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, redirect: init?.redirect });
    return answer(url);
  };
  return { fetchFn, seen };
}

/** What a provider endpoint answers when it steers the server to an internal address. */
const steer = () =>
  new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } });

function authWith(social: Record<string, unknown>) {
  return createAuth({
    baseURL: "https://api.example.com",
    secret: TEST_SECRET,
    trustedOrigins: [],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
    jwt: fakeJwt({}),
    social: social as never,
  });
}

/** One start and one callback of `provider`, with the code `c`. */
async function flow(auth: ReturnType<typeof authWith>, provider: string) {
  const started = await auth.api.startSocial({ provider, ip: null });
  if (!started.ok) return started;
  return auth.api.completeSocial({
    provider,
    state: new URL(started.value.location).searchParams.get("state"),
    code: "c",
    error: null,
    bindToken: started.value.bindToken,
    ip: null,
    userAgent: null,
  });
}

const token = () => Response.json({ access_token: "at", token_type: "Bearer" });

describe("providerFetch (plan 12b)", () => {
  it("sets redirect manual over the caller's init, and refuses each 3xx", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const r = recording(() => new Response(null, { status }));
      await expect(
        providerFetch(r.fetchFn)("https://p.example/x", { redirect: "follow" }),
      ).rejects.toBeInstanceOf(ProviderRedirectError);
      expect(r.seen).toEqual([{ url: "https://p.example/x", redirect: "manual" }]);
    }
    const ok = recording(() => Response.json({ a: 1 }));
    expect((await providerFetch(ok.fetchFn)("https://p.example/x")).status).toBe(200);
  });

  it("refuses an opaqueredirect answer, the status 0 of a browser-like runtime", async () => {
    const r = recording(() => {
      const res = new Response(null, { status: 200 });
      Object.defineProperty(res, "type", { value: "opaqueredirect" });
      Object.defineProperty(res, "status", { value: 0 });
      return res;
    });
    const err = await providerFetch(r.fetchFn)("https://p.example/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRedirectError);
    expect((err as ProviderRedirectError).status).toBe(0);
  });
});

describe("every provider call carries redirect manual and fails on a redirect (plan 12b)", () => {
  it("the token exchange", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = recording(steer);
    const result = await flow(authWith({ google: GOOGLE, fetch: r.fetchFn }), "google");
    expect(result).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(r.seen).toEqual([{ url: "https://oauth2.googleapis.com/token", redirect: "manual" }]);
    expect(log.mock.calls.some((c) => c.includes("ProviderRedirectError"))).toBe(true);
    log.mockRestore();
  });

  it("the GitHub user call", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = recording((url) => (url.endsWith("/access_token") ? token() : steer()));
    const result = await flow(
      authWith({ github: { clientId: "g", clientSecret: "s" }, fetch: r.fetchFn }),
      "github",
    );
    expect(result).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(r.seen.map((s) => s.redirect)).toEqual(["manual", "manual"]);
    expect(r.seen[1]?.url).toBe("https://api.github.com/user");
    expect(log.mock.calls.some((c) => c.includes("ProviderRedirectError"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("the GitHub emails call", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = recording((url) =>
      url.endsWith("/access_token")
        ? token()
        : url.endsWith("/user")
          ? Response.json({ id: 1, login: "ada", email: null, name: null, avatar_url: null })
          : steer(),
    );
    const result = await flow(
      authWith({ github: { clientId: "g", clientSecret: "s" }, fetch: r.fetchFn }),
      "github",
    );
    expect(result).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(r.seen.map((s) => [s.url, s.redirect])).toEqual([
      ["https://github.com/login/oauth/access_token", "manual"],
      ["https://api.github.com/user", "manual"],
      ["https://api.github.com/user/emails", "manual"],
    ]);
    expect(log.mock.calls.some((c) => c.includes("ProviderRedirectError"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("the LinkedIn user info call", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = recording((url) => (url.includes("/accessToken") ? token() : steer()));
    const result = await flow(
      authWith({ linkedin: { clientId: "l", clientSecret: "s" }, fetch: r.fetchFn }),
      "linkedin",
    );
    expect(result).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(r.seen[1]).toEqual({ url: "https://api.linkedin.com/v2/userinfo", redirect: "manual" });
    expect(log.mock.calls.some((c) => c.includes("ProviderRedirectError"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("an app's userinfo, also when the app asks to follow", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = recording((url) => (url.endsWith("/token") ? token() : steer()));
    const result = await flow(
      authWith({
        oauth2: [
          {
            name: "acme",
            label: "Acme",
            authorizeUrl: "https://acme.example/authorize",
            tokenUrl: "https://acme.example/token",
            clientId: "a",
            clientSecret: "s",
            scope: "profile",
            userinfo: async (accessToken: string, f: typeof fetch) => {
              const res = await f("https://acme.example/me", {
                redirect: "follow",
                headers: { authorization: `Bearer ${accessToken}` },
              });
              return (await res.json()) as never;
            },
          },
        ],
        fetch: r.fetchFn,
      }),
      "acme",
    );
    expect(result).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(r.seen[1]).toEqual({ url: "https://acme.example/me", redirect: "manual" });
    expect(log.mock.calls.some((c) => c.includes("ProviderRedirectError"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("the OIDC discovery read", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = recording(steer);
    const auth = authWith({
      oidc: [
        {
          name: "corp",
          label: "Corp",
          issuer: "https://idp.example",
          clientId: "c",
          clientSecret: "s",
        },
      ],
      fetch: r.fetchFn,
    });
    expect(await auth.api.startSocial({ provider: "corp", ip: null })).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
    expect(r.seen).toEqual([
      { url: "https://idp.example/.well-known/openid-configuration", redirect: "manual" },
    ]);
    expect(log.mock.calls.some((c) => c.includes("ProviderRedirectError"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("the JWKS read: jose sets manual itself, and the config's fetch sets it too", async () => {
    // A structurally valid JWS with a kid, so jose asks the key set for the key.
    const part = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const jws = `${part({ alg: "RS256", kid: "k1" })}.${part({ sub: "s" })}.AAAA`;
    const input = {
      token: jws,
      jwksUrl: "https://idp.example/jwks",
      issuer: "https://idp.example",
      audience: "c",
      now: new Date("2026-10-14T00:00:00.000Z"),
    };
    // The pin: jose 6.2.12 with a plain fetch. A jose upgrade that drops the setting fails here.
    const plain = recording(steer);
    await expect(createJoseJwtSeam(plain.fetchFn).verifyIdToken(input)).rejects.toThrow();
    expect(plain.seen).toEqual([{ url: "https://idp.example/jwks", redirect: "manual" }]);
    // Through the config: the seam that core builds takes the wrapped fetch.
    // jose sets manual on its own, so only the error type shows our wrapper.
    const wrapped = recording(steer);
    const config = resolveConfig({
      baseURL: "https://api.example.com",
      secret: TEST_SECRET,
      trustedOrigins: [],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      social: { fetch: wrapped.fetchFn },
    });
    await expect(config.jwt.verifyIdToken(input)).rejects.toBeInstanceOf(ProviderRedirectError);
    expect(wrapped.seen).toEqual([{ url: "https://idp.example/jwks", redirect: "manual" }]);
  });
});
