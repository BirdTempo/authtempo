import { afterEach, describe, expect, it, vi } from "vitest";
import { completeSocial, startSocial } from "../src/engine/social.js";
import type { JwtSeam } from "../src/seams/jwt.js";
import { linkedinProvider, linkedinUserinfo } from "../src/social/linkedin.js";
import { makeAuth } from "./helpers.js";
import { fakeFetch } from "./social-helpers.js";

const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const ACCESS = "li-access-token-0001";
/**
 * The sample answer of `GET https://api.linkedin.com/v2/userinfo` on LinkedIn's page
 * "Sign In with LinkedIn using OpenID Connect", read 2026-10-12. The page marks `email`
 * and `email_verified` as optional, and `email_verified` as a boolean.
 */
const SAMPLE = {
  sub: "782bbtaQ",
  name: "John Doe",
  given_name: "John",
  family_name: "Doe",
  picture:
    "https://media.licdn-ei.com/dms/image/C5F03AQHqK8v7tB1HCQ/profile-displayphoto-shrink_100_100/0/",
  locale: "en-US",
  email: "doe@email.com",
  email_verified: true,
};

/** The token endpoint and the user info endpoint. The token answer carries an ID token that the preset must ignore. */
function linkedinFetch(userinfo: () => Response) {
  return fakeFetch((call) => {
    if (call.url === TOKEN_URL)
      return Response.json({
        access_token: ACCESS,
        expires_in: 3600,
        scope: "email,openid,profile",
        token_type: "Bearer",
        id_token: "li-idtok-that-is-never-read",
      });
    if (call.url === USERINFO_URL) return userinfo();
    return new Response("not found", { status: 404 });
  });
}

/** A jwt seam that fails the test if the engine calls it: the preset reads no ID token. */
const NO_JWT: JwtSeam = {
  async verifyIdToken() {
    throw new Error("the LinkedIn preset must not verify an ID token");
  },
  async signES256() {
    throw new Error("not used");
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the linkedin preset (plan 9c)", () => {
  it("is an oauth2 provider with LinkedIn's endpoints, scope, label, and a GET callback", async () => {
    // Endpoints from LinkedIn's discovery document and guide page, read 2026-10-12.
    const li = linkedinProvider({ clientId: "li-id", clientSecret: "li-secret" });
    expect(li.kind).toBe("oauth2");
    expect(li.name).toBe("linkedin");
    expect(li.label).toBe("Continue with LinkedIn");
    expect(li.authorizeUrl).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(li.tokenUrl).toBe(TOKEN_URL);
    expect(li.scope).toBe("openid profile email");
    expect(li.authorizeParams).toEqual({});
    expect(li.callbackMethod).toBe("GET");
    expect(await li.clientSecret({ jwt: NO_JWT, now: new Date(0) })).toBe("li-secret");
  });

  it("calls the user info endpoint with the bearer token and maps the documented sample", async () => {
    const f = linkedinFetch(() => Response.json(SAMPLE));
    expect(await linkedinUserinfo(ACCESS, f.fetchFn)).toEqual({
      subject: "782bbtaQ",
      email: "doe@email.com",
      emailVerified: true,
      name: "John Doe",
      image: SAMPLE.picture,
    });
    expect(f.calls.map((c) => c.url)).toEqual([USERINFO_URL]);
    expect(f.calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${ACCESS}`,
      accept: "application/json",
    });
  });

  it("gives no verified address when email or email_verified is absent or not the boolean true", async () => {
    const { email: _email, email_verified: _verified, ...noEmail } = SAMPLE;
    for (const [answer, email] of [
      [noEmail, null],
      [{ ...SAMPLE, email_verified: undefined }, "doe@email.com"],
      [{ ...SAMPLE, email_verified: "true" }, "doe@email.com"],
      [{ ...SAMPLE, email_verified: 1 }, "doe@email.com"],
    ] as const) {
      const f = linkedinFetch(() => Response.json(answer));
      expect(await linkedinUserinfo(ACCESS, f.fetchFn)).toMatchObject({
        email,
        emailVerified: false,
      });
    }
  });

  it("throws on a failed answer, an answer that is not an object, and an answer with no sub", async () => {
    for (const answer of [
      () => new Response("{}", { status: 401 }),
      () => Response.json([SAMPLE]),
      () => Response.json({ ...SAMPLE, sub: "" }),
      () => Response.json({ ...SAMPLE, sub: 782 }),
      () => new Response("not json", { status: 200 }),
    ]) {
      const f = linkedinFetch(answer);
      await expect(linkedinUserinfo(ACCESS, f.fetchFn)).rejects.toThrow();
    }
  });
});

describe("LinkedIn through the engine (plan 9c)", () => {
  function linkedinAuth(userinfo: () => Response) {
    const f = linkedinFetch(userinfo);
    return {
      ...makeAuth({
        social: { linkedin: { clientId: "li-id", clientSecret: "li-secret" }, fetch: f.fetchFn },
        jwt: NO_JWT,
      }),
      calls: f.calls,
    };
  }
  async function signIn(auth: ReturnType<typeof linkedinAuth>) {
    const s = await startSocial(auth.config, { provider: "linkedin", ip: "1.1.1.1" });
    if (!s.ok) throw new Error(`start failed: ${s.code}`);
    const url = new URL(s.value.location);
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.search).toContain("scope=openid%20profile%20email");
    expect(url.searchParams.has("nonce")).toBe(false);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    return completeSocial(auth.config, {
      provider: "linkedin",
      state: url.searchParams.get("state"),
      code: "code-1",
      error: null,
      bindToken: s.value.bindToken,
      ip: "1.1.1.1",
      userAgent: "ua",
    });
  }

  it("signs in through the user info endpoint and never verifies the ID token", async () => {
    const auth = linkedinAuth(() => Response.json(SAMPLE));
    const r = await signIn(auth);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.user).toMatchObject({ email: "doe@email.com", emailVerified: true });
    expect(auth.calls.map((c) => c.url)).toEqual([TOKEN_URL, USERINFO_URL]);
    expect(auth.calls[0]?.form.client_secret).toBe("li-secret");
    const ids = await auth.storage.findMany("identity", [
      { field: "provider", op: "eq", value: "linkedin" },
    ]);
    expect(ids.map((i) => i.subject)).toEqual(["782bbtaQ"]);
  });

  it("never links an address that LinkedIn does not report as verified (Review Focus 1)", async () => {
    const auth = linkedinAuth(() => Response.json({ ...SAMPLE, email_verified: "true" }));
    const owner = await auth.seedUser("doe@email.com");
    expect(await signIn(auth)).toMatchObject({ ok: false, code: "email_taken_unverified" });
    expect(
      await auth.storage.findMany("identity", [{ field: "userId", op: "eq", value: owner.id }]),
    ).toEqual([]);
    expect(await auth.storage.findMany("session", [])).toHaveLength(0);
  });

  it("answers oauth_failed when the user info endpoint fails, and logs no token", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = linkedinAuth(() => new Response("{}", { status: 401 }));
    expect(await signIn(auth)).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(error).toHaveBeenCalledWith("tempo-auth: social user info failed", "linkedin", "Error");
    expect(JSON.stringify(error.mock.calls)).not.toContain(ACCESS);
  });
});
