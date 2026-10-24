import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { routeKeyOf } from "../src/http/route-key.js";
import { ROUTES } from "../src/http/route-list.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { BASE_URL, get, makeAuth, post } from "./helpers.js";
import { observed } from "./observe-helpers.js";
import { fakeFetch } from "./social-helpers.js";
import { verifiedSession } from "./totp-helpers.js";

// The per-provider redirect override (plan 12i Task 12, spec 32 item 11).
// `redirectURI` is a same-origin path under basePath. The router serves it
// as that provider's callback, and the engine sends it as redirect_uri.

const OVERRIDE = `${BASE_URL}/auth/oauth/github`;
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB = { clientId: "gh-id", clientSecret: "gh-secret" };
const APPLE = { clientId: "com.example.web", teamId: "T", keyId: "K", privateKey: "pem" };
const BIND = "__Secure-tempo_session_oauth";

/** GitHub's token, user, and emails answers (shapes of social-github.test.ts). */
function githubFetch() {
  return fakeFetch((call) => {
    if (call.url === TOKEN_URL)
      return Response.json({ access_token: "gho_x", scope: "read:user", token_type: "bearer" });
    if (call.url === "https://api.github.com/user")
      return Response.json({ login: "ada", id: 7, name: "Ada", email: null, avatar_url: null });
    if (call.url === "https://api.github.com/user/emails")
      return Response.json([
        { email: "ada@example.com", primary: true, verified: true, visibility: null },
      ]);
    return new Response("not found", { status: 404 });
  });
}

function world(social: NonNullable<AuthConfig["social"]> = {}) {
  const f = githubFetch();
  const auth = makeAuth({
    password: {},
    social: { github: { ...GITHUB, redirectURI: OVERRIDE }, fetch: f.fetchFn, ...social },
  });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  return { auth, handle, calls: f.calls };
}

/** The binding cookie of a start: its pair for the next request, and its whole Set-Cookie. */
function binding(res: Response): { pair: string; set: string } {
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${BIND}=`)) ?? "";
  return { pair: set.split(";")[0] ?? "", set };
}

async function start(w: ReturnType<typeof world>) {
  const res = await w.handle(get("/auth/social/github/start?next=/home"));
  expect(res.status).toBe(302);
  const url = new URL(res.headers.get("location") ?? "");
  return { url, state: url.searchParams.get("state") ?? "", ...binding(res) };
}

describe("the redirect override (plan 12i Task 12)", () => {
  it("serves the override path as the callback", async () => {
    const w = world();
    const s = await start(w);
    const res = await w.handle(
      get(`/auth/oauth/github?code=c&state=${encodeURIComponent(s.state)}`, { cookie: s.pair }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://api.example.com/home");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-tempo_session="))).toBe(
      true,
    );
    // A POST to the override is no route: the alias has the provider's callback method.
    const posted = await w.handle(post("/auth/oauth/github", {}));
    expect(posted.status).toBe(404);
  });

  it("sends the override as redirect_uri at the start and the exchange", async () => {
    const w = world({ linkedin: { clientId: "l", clientSecret: "l" } });
    const s = await start(w);
    expect(s.url.searchParams.get("redirect_uri")).toBe(OVERRIDE);
    await w.handle(
      get(`/auth/oauth/github?code=c&state=${encodeURIComponent(s.state)}`, { cookie: s.pair }),
    );
    const token = w.calls.find((c) => c.url === TOKEN_URL);
    expect(token?.form.redirect_uri).toBe(OVERRIDE);
    // A provider with no override keeps the default callback.
    const other = await w.handle(get("/auth/social/linkedin/start"));
    expect(new URL(other.headers.get("location") ?? "").searchParams.get("redirect_uri")).toBe(
      `${BASE_URL}/auth/social/linkedin/callback`,
    );
  });

  it("sets the binding cookie on the override path", async () => {
    const w = world({ linkedin: { clientId: "l", clientSecret: "l" } });
    const s = await start(w);
    expect(s.set).toContain("; Path=/auth/oauth/github;");
    const done = await w.handle(
      get(`/auth/oauth/github?code=c&state=${encodeURIComponent(s.state)}`, { cookie: s.pair }),
    );
    expect(binding(done).set).toBe(
      `${BIND}=; Path=/auth/oauth/github; Max-Age=0; HttpOnly; Secure; SameSite=None`,
    );
    // A refused callback clears it on the same path.
    const again = await start(w);
    const denied = await w.handle(
      get(`/auth/oauth/github?error=access_denied&state=${encodeURIComponent(again.state)}`, {
        cookie: again.pair,
      }),
    );
    expect(binding(denied).set).toContain("; Path=/auth/oauth/github;");
    // The link start of a signed-in user sets it there too.
    const me = await verifiedSession(w.auth, "bob@example.com");
    const link = await w.handle(
      post("/auth/social/github/link", {}, { cookie: `__Host-tempo_session=${me.token}` }),
    );
    expect(binding(link).set).toContain("; Path=/auth/oauth/github;");
    // A provider with no override keeps <basePath>/social.
    const other = binding(await w.handle(get("/auth/social/linkedin/start")));
    expect(other.set).toContain("; Path=/auth/social;");
  });

  it("refuses another origin, a path outside basePath, a query, a ROUTES path, and a path of two providers", () => {
    const refused = (redirectURI: string, extra: NonNullable<AuthConfig["social"]> = {}) =>
      expect(() => makeAuth({ social: { github: { ...GITHUB, redirectURI }, ...extra } })).toThrow(
        /redirectURI/,
      );
    refused("https://evil.example/auth/oauth/github");
    refused("https://api.example.com:8443/auth/oauth/github");
    refused("http://api.example.com/auth/oauth/github");
    refused(`${BASE_URL}/oauth/github`);
    refused(`${BASE_URL}/authx/github`);
    refused(`${BASE_URL}/auth`);
    refused(`${BASE_URL}/auth/oauth/github?x=1`);
    refused(`${BASE_URL}/auth/oauth/github?`);
    refused(`${BASE_URL}/auth/oauth/github#top`);
    refused(`${BASE_URL}/auth/oauth/../session`);
    refused("not a url");
    // A ";" or "," ends the Path attribute of the binding cookie: the rest
    // would be an attribute of its own, such as a Domain (review M1).
    refused(`${BASE_URL}/auth/cb;Domain=example.com`);
    refused(`${BASE_URL}/auth/cb,x`);
    // A ROUTES path, literal or through a parameter segment.
    refused(`${BASE_URL}/auth/session`);
    refused(`${BASE_URL}/auth/social/github/callback`);
    refused(`${BASE_URL}/auth/social/linkedin/start`);
    // One path for two providers.
    refused(OVERRIDE, { linkedin: { clientId: "l", clientSecret: "l", redirectURI: OVERRIDE } });
    // The same rules hold for a list entry.
    expect(() =>
      makeAuth({
        social: {
          oauth2: [
            {
              name: "chat",
              label: "Chat",
              authorizeUrl: "https://chat.example/authorize",
              tokenUrl: "https://chat.example/token",
              clientId: "c",
              clientSecret: "s",
              scope: "email",
              userinfo: async () => ({
                subject: "1",
                email: null,
                emailVerified: false,
                name: null,
                image: null,
              }),
              redirectURI: `${BASE_URL}/auth/session`,
            },
          ],
        },
      }),
    ).toThrow(/social\.oauth2\[0\]\.redirectURI/);
    // A good one passes.
    expect(() =>
      makeAuth({ social: { github: { ...GITHUB, redirectURI: OVERRIDE } } }),
    ).not.toThrow();
  });

  it("names the provider in the failure event of an alias", async () => {
    // The path of this alias does not hold the provider name (review M2).
    const o = observed({
      social: { github: { ...GITHUB, redirectURI: `${BASE_URL}/auth/cb/gh` } },
    });
    const res = await o.auth.handle(get("/auth/cb/gh?error=access_denied&state=x"));
    expect(res.status).toBe(302);
    const failed = (await o.events()).filter((e) => e.name === "sign_in");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ method: "social", provider: "github", outcome: "failure" });
  });

  it("the route-list test serves each alias of the config and no other", () => {
    const { auth } = world({
      apple: { ...APPLE, redirectURI: `${BASE_URL}/auth/oauth/apple` },
      linkedin: { clientId: "l", clientSecret: "l" },
    });
    const routes = coreRoutes(auth.config);
    const aliases = routes.filter((r) => r.aliasOf !== undefined);
    expect(aliases.map((r) => `${r.method} ${r.path} ${r.aliasOf} ${r.key}`).sort()).toEqual([
      "GET /oauth/github /social/github/callback GET /social/:provider/callback",
      "POST /oauth/apple /social/apple/callback POST /social/apple/callback",
    ]);
    // Apple's alias takes the cross-site form post, as its callback does.
    expect(aliases.find((r) => r.method === "POST")?.allowCrossSiteForm).toBe(true);
    // Every other route is an entry of ROUTES.
    const listed = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    for (const r of routes.filter((x) => x.aliasOf === undefined))
      expect(listed.has(routeKeyOf(r.method, r.path))).toBe(true);
    // No override, no alias.
    const plain = makeAuth({ social: { github: GITHUB } });
    expect(coreRoutes(plain.config).filter((r) => r.aliasOf !== undefined)).toEqual([]);
  });
});
