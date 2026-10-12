import { afterEach, describe, expect, it, vi } from "vitest";
import { completeSocial, startSocial } from "../src/engine/social.js";
import { githubProvider, githubUserinfo } from "../src/social/github.js";
import { makeAuth } from "./helpers.js";
import { fakeFetch } from "./social-helpers.js";

/**
 * Shapes from GitHub's REST docs, "users" and "emails", API version
 * 2022-11-28, read 2026-10-12. The docs give the schema and no example:
 * `id` is an int64, `name` and `email` may be null, and each email entry has
 * `email`, `primary`, `verified`, and `visibility`. The values are ours.
 */
const USER = {
  login: "octo-ada",
  id: 583231,
  name: "Ada Octo",
  email: null,
  avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
};
const EMAILS = [
  { email: "ada@example.com", primary: true, verified: true, visibility: "private" },
  { email: "old@example.com", primary: false, verified: true, visibility: null },
];
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const ACCESS = "gho_16C7e42F292c6912E7710c838347Ae178B4a";

/** GitHub's three URLs. `user` and `emails` answer per call. */
function githubFetch(user: () => Response, emails: () => Response) {
  return fakeFetch((call) => {
    if (call.url === TOKEN_URL)
      return Response.json({
        access_token: ACCESS,
        scope: "read:user,user:email",
        token_type: "bearer",
      });
    if (call.url === "https://api.github.com/user") return user();
    if (call.url === "https://api.github.com/user/emails") return emails();
    return new Response("not found", { status: 404 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the github preset (plan 9c)", () => {
  it("is an oauth2 provider with GitHub's endpoints, scope, label, and a GET callback", async () => {
    const gh = githubProvider({ clientId: "gh-id", clientSecret: "gh-secret" });
    expect(gh.kind).toBe("oauth2");
    expect(gh.name).toBe("github");
    expect(gh.label).toBe("Continue with GitHub");
    expect(gh.authorizeUrl).toBe("https://github.com/login/oauth/authorize");
    expect(gh.tokenUrl).toBe(TOKEN_URL);
    expect(gh.scope).toBe("read:user user:email");
    expect(gh.authorizeParams).toEqual({});
    expect(gh.callbackMethod).toBe("GET");
    expect(await gh.clientSecret({ jwt: {} as never, now: new Date(0) })).toBe("gh-secret");
  });

  it("sends the bearer token, GitHub's media type, the API version, and a User-Agent", async () => {
    const f = githubFetch(
      () => Response.json(USER),
      () => Response.json(EMAILS),
    );
    await githubUserinfo(ACCESS, f.fetchFn);
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://api.github.com/user",
      "https://api.github.com/user/emails",
    ]);
    for (const c of f.calls)
      expect(c.headers).toMatchObject({
        authorization: `Bearer ${ACCESS}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "tempo-auth",
      });
  });

  it("takes the numeric id as the subject and the primary address, verified only by its own flag", async () => {
    const verified = githubFetch(
      () => Response.json(USER),
      () => Response.json(EMAILS),
    );
    expect(await githubUserinfo(ACCESS, verified.fetchFn)).toEqual({
      subject: "583231",
      email: "ada@example.com",
      emailVerified: true,
      name: "Ada Octo",
      image: "https://avatars.githubusercontent.com/u/583231?v=4",
    });
    // A verified secondary address does not make an unverified primary one verified.
    const unverified = githubFetch(
      () => Response.json({ ...USER, name: null }),
      () =>
        Response.json([
          { email: "ada@example.com", primary: true, verified: false, visibility: "private" },
          { email: "old@example.com", primary: false, verified: true, visibility: null },
        ]),
    );
    expect(await githubUserinfo(ACCESS, unverified.fetchFn)).toMatchObject({
      email: "ada@example.com",
      emailVerified: false,
      name: "octo-ada",
    });
  });

  it("falls back to the public address, unverified, when /user/emails answers 403 or 404", async () => {
    for (const status of [403, 404]) {
      const f = githubFetch(
        () => Response.json({ ...USER, email: "public@example.com" }),
        () => new Response("{}", { status }),
      );
      expect(await githubUserinfo(ACCESS, f.fetchFn)).toMatchObject({
        email: "public@example.com",
        emailVerified: false,
      });
    }
  });

  it("throws on a /user failure, an id that is not a positive integer, and a /user/emails failure other than 403 or 404", async () => {
    const cases: Array<[() => Response, () => Response]> = [
      [() => new Response("{}", { status: 401 }), () => Response.json(EMAILS)],
      [() => Response.json({ ...USER, id: "583231" }), () => Response.json(EMAILS)],
      [() => Response.json({ ...USER, id: 0 }), () => Response.json(EMAILS)],
      [() => Response.json(USER), () => new Response("{}", { status: 500 })],
    ];
    for (const [user, emails] of cases) {
      const f = githubFetch(user, emails);
      await expect(githubUserinfo(ACCESS, f.fetchFn)).rejects.toThrow(/github/);
    }
  });
});

describe("GitHub through the engine (plan 9c)", () => {
  function githubAuth(user: () => Response, emails: () => Response) {
    const f = githubFetch(user, emails);
    return {
      ...makeAuth({
        social: { github: { clientId: "gh-id", clientSecret: "gh-secret" }, fetch: f.fetchFn },
      }),
      calls: f.calls,
    };
  }
  async function signIn(auth: ReturnType<typeof githubAuth>) {
    const s = await startSocial(auth.config, { provider: "github", ip: "1.1.1.1" });
    if (!s.ok) throw new Error(`start failed: ${s.code}`);
    const url = new URL(s.value.location);
    expect(url.searchParams.has("nonce")).toBe(false);
    return completeSocial(auth.config, {
      provider: "github",
      state: url.searchParams.get("state"),
      code: "code-1",
      error: null,
      bindToken: s.value.bindToken,
      ip: "1.1.1.1",
      userAgent: "ua",
    });
  }

  it("links a verified primary address to the existing user", async () => {
    const auth = githubAuth(
      () => Response.json(USER),
      () => Response.json(EMAILS),
    );
    const owner = await auth.seedUser("ada@example.com");
    const r = await signIn(auth);
    expect(r.ok && r.value.user.id).toBe(owner.id);
    const ids = await auth.storage.findMany("identity", [
      { field: "provider", op: "eq", value: "github" },
    ]);
    expect(ids.map((i) => [i.userId, i.subject])).toEqual([[owner.id, "583231"]]);
  });

  it("never links an unverified primary address: email_taken_unverified, no identity, no session (Review Focus 1)", async () => {
    const auth = githubAuth(
      () => Response.json(USER),
      () =>
        Response.json([
          { email: "ada@example.com", primary: true, verified: false, visibility: "private" },
          { email: "old@example.com", primary: false, verified: true, visibility: null },
        ]),
    );
    const owner = await auth.seedUser("ada@example.com");
    expect(await signIn(auth)).toMatchObject({ ok: false, code: "email_taken_unverified" });
    expect(
      await auth.storage.findMany("identity", [{ field: "userId", op: "eq", value: owner.id }]),
    ).toEqual([]);
    expect(await auth.storage.findMany("session", [])).toHaveLength(0);
  });

  it("answers email_required when every address is private and the token cannot read them (Review Focus 1)", async () => {
    const auth = githubAuth(
      () => Response.json(USER),
      () => new Response("{}", { status: 403 }),
    );
    expect(await signIn(auth)).toMatchObject({ ok: false, code: "email_required" });
    expect(await auth.storage.findMany("user", [])).toHaveLength(0);
  });

  it("answers oauth_failed when /user fails, and logs no token", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = githubAuth(
      () => new Response("{}", { status: 401 }),
      () => Response.json(EMAILS),
    );
    expect(await signIn(auth)).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(error).toHaveBeenCalledWith("tempo-auth: social user info failed", "github", "Error");
    expect(JSON.stringify(error.mock.calls)).not.toContain(ACCESS);
  });
});
