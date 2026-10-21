import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../src/config.js";
import { completeSocial, startSocial } from "../src/engine/social.js";
import { createRouter } from "../src/http/router.js";
import { socialRoutes } from "../src/http/routes/social.js";
import type { JwtSeam, VerifyIdTokenInput } from "../src/seams/jwt.js";
import { discover, discoveryUrl, type OidcEntry } from "../src/social/oidc.js";
import { PROVIDER_TIMEOUT_MS } from "../src/social/provider.js";
import { BASE_URL, DEFAULT_OBSERVE, get, makeAuth } from "./helpers.js";
import { type FakeIdToken, fakeFetch, fakeJwt } from "./social-helpers.js";

const ISSUER = "https://login.acme.example/tenant-1/v2.0";
const DOC_URL = `${ISSUER}/.well-known/openid-configuration`;
const DOC = {
  issuer: ISSUER,
  authorization_endpoint: "https://login.acme.example/tenant-1/oauth2/v2.0/authorize",
  token_endpoint: "https://login.acme.example/tenant-1/oauth2/v2.0/token",
  jwks_uri: "https://login.acme.example/tenant-1/discovery/v2.0/keys",
};

function entry(over: Partial<OidcEntry> = {}): OidcEntry {
  return {
    name: "entra",
    label: "Continue with Microsoft",
    issuer: ISSUER,
    clientId: "entra-id",
    clientSecret: "entra-secret",
    ...over,
  };
}

/** The discovery URL answers `doc()`; any other URL is the token endpoint. */
function oidcAuth(e: OidcEntry, doc: () => Response, jwt: JwtSeam = fakeJwt({})) {
  const f = fakeFetch((call) =>
    call.url === discoveryUrl(e.issuer)
      ? doc()
      : Response.json({ id_token: "entra-idtok", access_token: "at" }),
  );
  return { ...makeAuth({ social: { oidc: [e], fetch: f.fetchFn }, jwt }), calls: f.calls };
}

async function started(auth: { config: ResolvedConfig }, provider = "entra") {
  const r = await startSocial(auth.config, { provider, next: "/home", ip: "1.1.1.1" });
  if (!r.ok) throw new Error(`start failed: ${r.code}`);
  const url = new URL(r.value.location);
  return {
    url,
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
    bindToken: r.value.bindToken,
  };
}

function complete(
  auth: { config: ResolvedConfig },
  s: Awaited<ReturnType<typeof started>>,
  provider = "entra",
) {
  return completeSocial(auth.config, {
    provider,
    state: s.state,
    code: "code-1",
    error: null,
    bindToken: s.bindToken,
    ip: "1.1.1.1",
    userAgent: "ua",
  });
}

/** A jwt seam that records every verify input and answers from `tokens`. */
function recordingJwt(tokens: Record<string, FakeIdToken>) {
  const seen: VerifyIdTokenInput[] = [];
  const inner = fakeJwt(tokens);
  const jwt: JwtSeam = {
    ...inner,
    verifyIdToken: (input) => {
      seen.push(input);
      return inner.verifyIdToken(input);
    },
  };
  return { jwt, seen };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an oidc entry with discovery (plan 9c)", () => {
  it("reads the discovery document on the first start only and sends a nonce", async () => {
    const auth = oidcAuth(entry(), () => Response.json(DOC));
    const a = await started(auth);
    await started(auth);
    expect(auth.calls.map((c) => c.url)).toEqual([DOC_URL]);
    expect(auth.calls[0]?.headers.accept).toBe("application/json");
    expect(a.url.origin + a.url.pathname).toBe(DOC.authorization_endpoint);
    expect(a.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.url.search).toContain("scope=openid%20email%20profile");
  });

  it("exchanges at the discovered token endpoint and verifies against the discovered JWKS and the configured issuer", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const { jwt, seen } = recordingJwt(tokens);
    const auth = oidcAuth(entry(), () => Response.json(DOC), jwt);
    const s = await started(auth);
    tokens["entra-idtok"] = {
      audience: "entra-id",
      issuer: ISSUER,
      claims: { sub: "oid-1", email: "ada@example.com", email_verified: true, nonce: s.nonce },
    };
    const r = await complete(auth, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.user).toMatchObject({ email: "ada@example.com", emailVerified: true });
    expect(auth.calls.map((c) => c.url)).toEqual([DOC_URL, DOC.token_endpoint]);
    expect(seen[0]).toMatchObject({
      jwksUrl: DOC.jwks_uri,
      issuer: [ISSUER],
      audience: "entra-id",
    });
  });

  it("refuses a document whose issuer differs, writes no state row, logs it, and reads again on the next start (Review Focus 4)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let issuer = "https://login.acme.example/other-tenant/v2.0";
    const auth = oidcAuth(entry(), () => Response.json({ ...DOC, issuer }));
    expect(await startSocial(auth.config, { provider: "entra", ip: "1.1.1.1" })).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
    expect(await auth.storage.findMany("verification", [])).toEqual([]);
    expect(error).toHaveBeenCalledWith("authtempo: oidc discovery issuer mismatch", "entra");
    // A trailing slash is another issuer: `iss` is compared as a string.
    issuer = `${ISSUER}/`;
    expect(await startSocial(auth.config, { provider: "entra", ip: "1.1.1.1" })).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
    const handle = createRouter(auth.config, socialRoutes(auth.config));
    const res = await handle(get("/auth/social/entra/start"));
    expect(res.headers.get("location")).toBe(`${BASE_URL}/?auth_error=oauth_failed`);
    issuer = ISSUER;
    expect((await startSocial(auth.config, { provider: "entra", ip: "1.1.1.1" })).ok).toBe(true);
    expect(auth.calls.map((c) => c.url)).toEqual([DOC_URL, DOC_URL, DOC_URL, DOC_URL]);
  });

  it("answers oauth_failed on every other discovery failure and keeps none of them", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const answers: Array<() => Response> = [
      () => new Response("down", { status: 503 }),
      () => {
        throw new TypeError("network");
      },
      () => new Response("not json", { status: 200 }),
      () => Response.json({ ...DOC, jwks_uri: undefined }),
      () => Response.json({ ...DOC, token_endpoint: "http://login.acme.example/token" }),
      () => Response.json([DOC]),
    ];
    for (const answer of answers) {
      const auth = oidcAuth(entry(), answer);
      expect(await startSocial(auth.config, { provider: "entra", ip: "1.1.1.1" })).toMatchObject({
        ok: false,
        code: "oauth_failed",
      });
      expect(await startSocial(auth.config, { provider: "entra", ip: "1.1.1.1" })).toMatchObject({
        ok: false,
        code: "oauth_failed",
      });
      expect(auth.calls.map((c) => c.url)).toEqual([DOC_URL, DOC_URL]);
    }
    expect(error.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([
        "authtempo: oidc discovery answered",
        "authtempo: oidc discovery request failed",
        "authtempo: oidc discovery is not JSON",
        "authtempo: oidc discovery lacks an endpoint",
      ]),
    );
  });

  it("reads the document only after the start limit: a limited start makes no read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = oidcAuth(entry(), () => new Response("down", { status: 503 }));
    for (let i = 0; i < 30; i++)
      await startSocial(auth.config, { provider: "entra", ip: "9.9.9.9" });
    expect(await startSocial(auth.config, { provider: "entra", ip: "9.9.9.9" })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    expect(auth.calls).toHaveLength(30);
  });

  it("uses explicit endpoints and never reads the document", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const { jwt, seen } = recordingJwt(tokens);
    const endpoints = {
      authorizeUrl: DOC.authorization_endpoint,
      tokenUrl: DOC.token_endpoint,
      jwksUrl: DOC.jwks_uri,
    };
    const auth = oidcAuth(
      entry({ endpoints }),
      () => {
        throw new Error("no discovery read is allowed");
      },
      jwt,
    );
    expect(auth.config.social.providers[0]?.kind).toBe("oidc");
    const s = await started(auth);
    tokens["entra-idtok"] = {
      audience: "entra-id",
      issuer: ISSUER,
      claims: { sub: "oid-2", email: "bo@example.com", email_verified: false, nonce: s.nonce },
    };
    const r = await complete(auth, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.user.emailVerified).toBe(false);
    expect(auth.calls.map((c) => c.url)).toEqual([DOC.token_endpoint]);
    expect(seen[0]?.jwksUrl).toBe(DOC.jwks_uri);
  });
});

describe("the profile bound for an oidc entry (final review I-2)", () => {
  /** Runs one full flow whose ID token carries `claims`. */
  async function run(claims: Record<string, unknown>) {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tokens: Record<string, FakeIdToken> = {};
    const auth = oidcAuth(entry(), () => Response.json(DOC), fakeJwt(tokens));
    const s = await started(auth);
    tokens["entra-idtok"] = {
      audience: "entra-id",
      issuer: ISSUER,
      claims: {
        sub: "oid-1",
        email: "ada@example.com",
        email_verified: true,
        nonce: s.nonce,
        ...claims,
      },
    };
    return { auth, result: await complete(auth, s) };
  }

  it("answers oauth_failed for a subject over 255 characters, with a control character, or of spaces only, and writes no identity", async () => {
    for (const sub of ["s".repeat(256), "oid\n1", "   "]) {
      const { auth, result } = await run({ sub });
      expect(result).toMatchObject({ ok: false, code: "oauth_failed" });
      expect(await auth.storage.findMany("identity", [])).toEqual([]);
      expect(await auth.storage.findMany("user", [])).toEqual([]);
    }
    expect((await run({ sub: "s".repeat(255) })).result.ok).toBe(true);
    // The subject is an identity key: core refuses a padded one, it does not trim it.
    const { auth, result } = await run({ sub: " oid-9 " });
    expect(result.ok).toBe(true);
    expect(
      (await auth.storage.findMany("identity", [])).find((i) => i.provider === "entra")?.subject,
    ).toBe(" oid-9 ");
  });

  it("drops a name with a control character and an image that is too long, has a control character, or is not https", async () => {
    for (const claims of [
      { name: "Ada\nX", picture: "https://img.acme.example/a.png" },
      { name: "Ada", picture: `https://img.acme.example/${"a".repeat(2048)}` },
      { name: "Ada", picture: "https://img.acme.example/a\n" },
      { name: "Ada", picture: "javascript:alert(1)" },
    ]) {
      const { result } = await run(claims);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.user.name).toBe(claims.name === "Ada" ? "Ada" : null);
      expect(result.value.user.image).toBe(
        claims.picture === "https://img.acme.example/a.png" ? claims.picture : null,
      );
    }
  });
});

describe("discovery across instances (final review, Task 2 parked Minor)", () => {
  it("reads the document on the instance that runs the callback, and the callback still completes", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const a = oidcAuth(entry(), () => Response.json(DOC), fakeJwt(tokens));
    const s = await started(a);
    // A second instance with the same storage and no discovery cache.
    const f = fakeFetch((call) =>
      call.url === DOC_URL ? Response.json(DOC) : Response.json({ id_token: "entra-idtok" }),
    );
    const b = makeAuth({
      social: { oidc: [entry()], fetch: f.fetchFn },
      jwt: fakeJwt(tokens),
      storage: a.storage,
    });
    tokens["entra-idtok"] = {
      audience: "entra-id",
      issuer: ISSUER,
      claims: { sub: "oid-1", email: "ada@example.com", email_verified: true, nonce: s.nonce },
    };
    expect((await complete(b, s)).ok).toBe(true);
    expect(f.calls.map((c) => c.url)).toEqual([DOC_URL, DOC.token_endpoint]);
  });

  it("answers oauth_failed when the read fails there, spends the state, and clears the binding cookie", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = oidcAuth(entry(), () => Response.json(DOC));
    const start = await createRouter(
      a.config,
      socialRoutes(a.config),
    )(get("/auth/social/entra/start"));
    const bind = start.headers.get("set-cookie")?.split(";")[0] ?? "";
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const f = fakeFetch(() => new Response("down", { status: 503 }));
    const b = makeAuth({
      social: { oidc: [entry()], fetch: f.fetchFn },
      storage: a.storage,
    });
    const handle = createRouter(b.config, socialRoutes(b.config));
    const url = `/auth/social/entra/callback?code=c1&state=${encodeURIComponent(state)}`;
    const done = await handle(get(url, { cookie: bind }));
    expect(done.headers.get("location")).toBe(`${BASE_URL}/?auth_error=oauth_failed`);
    expect(done.headers.getSetCookie().some((c) => /_oauth=; .*Max-Age=0/.test(c))).toBe(true);
    expect(f.calls.map((c) => c.url)).toEqual([DOC_URL]);
    const again = await handle(get(url, { cookie: bind }));
    expect(again.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
    expect(f.calls).toHaveLength(1);
  });
});

describe("discover", () => {
  it("drops one trailing slash of the issuer for the URL and compares iss as configured", async () => {
    expect(discoveryUrl("https://tenant.acme.example/")).toBe(
      "https://tenant.acme.example/.well-known/openid-configuration",
    );
    expect(discoveryUrl(ISSUER)).toBe(DOC_URL);
    const doc = { ...DOC, issuer: "https://tenant.acme.example/" };
    const f = fakeFetch(() => Response.json(doc));
    expect(await discover(DEFAULT_OBSERVE, "t", "https://tenant.acme.example/", f.fetchFn)).toEqual(
      {
        authorizeUrl: DOC.authorization_endpoint,
        tokenUrl: DOC.token_endpoint,
        jwksUrl: DOC.jwks_uri,
      },
    );
  });

  it("reads with the 10 s timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const f = fakeFetch(() => Response.json(DOC));
    await discover(DEFAULT_OBSERVE, "entra", ISSUER, f.fetchFn);
    expect(timeout).toHaveBeenCalledWith(PROVIDER_TIMEOUT_MS);
  });
});
