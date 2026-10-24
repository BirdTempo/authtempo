import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, ResolvedConfig } from "../src/config.js";
import { completeSocial, startSocial } from "../src/engine/social.js";
import { tiktokEntry, wechatEntry } from "../src/social/entries/index.js";
import type { OAuth2Entry } from "../src/social/oauth2.js";
import type { SocialProfile, TokenRequestInput } from "../src/social/provider.js";
import tiktokExpectedText from "./fixtures/providers/tiktok/expected.json?raw";
import tiktokTokenText from "./fixtures/providers/tiktok/token.json?raw";
import tiktokTokenErrorText from "./fixtures/providers/tiktok/token-error.json?raw";
import tiktokUserText from "./fixtures/providers/tiktok/user.json?raw";
import tiktokUserErrorText from "./fixtures/providers/tiktok/user-error.json?raw";
import wechatExpectedText from "./fixtures/providers/wechat/expected.json?raw";
import wechatTokenText from "./fixtures/providers/wechat/token.json?raw";
import wechatTokenErrorText from "./fixtures/providers/wechat/token-error.json?raw";
import wechatTokenOpenidText from "./fixtures/providers/wechat/token-openid.json?raw";
import wechatUserText from "./fixtures/providers/wechat/userinfo.json?raw";
import wechatUserErrorText from "./fixtures/providers/wechat/userinfo-error.json?raw";
import wechatUserOpenidText from "./fixtures/providers/wechat/userinfo-openid.json?raw";
import { BASE_URL, makeAuth, recordCredential } from "./helpers.js";
import { fakeFetch, type TokenCall } from "./social-helpers.js";

type Json = Record<string, unknown>;
const json = (text: string) => JSON.parse(text) as Json;

// The endpoints of the two entries, read 2026-10-24 (plan-12i-task-22-pages.md).
const TT_AUTHORIZE = "https://www.tiktok.com/v2/auth/authorize/";
const TT_TOKEN = "https://open.tiktokapis.com/v2/oauth/token/";
const TT_USER =
  "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name";
const WX_AUTHORIZE = "https://open.weixin.qq.com/connect/qrconnect";
const WX_TOKEN = "https://api.weixin.qq.com/sns/oauth2/access_token";
const WX_USER = "https://api.weixin.qq.com/sns/userinfo";

// No event, line, or answer may hold a client secret or a code.
const TT_SECRET = recordCredential("tiktok-client-secret-0001");
const WX_SECRET = recordCredential("wechat-app-secret-0001");
const HOOK_SECRET = recordCredential("hook-client-secret-0001");
const CODE = recordCredential("code-tr-0001");

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every console line of the test, so a test can check that no line holds a secret. */
function consoleLines(): () => string {
  const lines: unknown[][] = [];
  for (const m of ["error", "warn", "log", "info"] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a));
  return () => JSON.stringify(lines);
}

/** Starts a flow for `provider`. */
async function start(config: ResolvedConfig, provider: string) {
  const s = await startSocial(config, { provider, next: "/home", ip: "1.1.1.1" });
  if (!s.ok) throw new Error(`start failed: ${s.code}`);
  return s.value;
}

/** Starts a flow and completes it, with the browser's own binding token unless `bindToken` is given. */
async function signIn(config: ResolvedConfig, provider: string, bindToken?: string) {
  const s = await start(config, provider);
  const url = new URL(s.location);
  const done = await completeSocial(config, {
    provider,
    state: url.searchParams.get("state"),
    code: CODE,
    error: null,
    bindToken: bindToken ?? s.bindToken,
    ip: "1.1.1.1",
    userAgent: "ua",
  });
  return { location: s.location, url, done };
}

/** A provider world: `answer` serves each URL by its path with no query, and a 404 serves any other. */
function world(social: AuthConfig["social"], answer: Record<string, (c: TokenCall) => Response>) {
  const f = fakeFetch(
    (call) => answer[call.url.split("?")[0] ?? ""]?.(call) ?? new Response("nf", { status: 404 }),
  );
  const auth = makeAuth({ social: { ...social, fetch: f.fetchFn } });
  return { ...auth, calls: f.calls };
}

const tiktokWorld = (
  token: () => Response = () => new Response(tiktokTokenText),
  user: () => Response = () => new Response(tiktokUserText),
) =>
  world(
    { oauth2: [tiktokEntry({ clientKey: "tiktok-client-key", clientSecret: TT_SECRET })] },
    { [TT_TOKEN]: token, [TT_USER.split("?")[0] ?? ""]: user },
  );

const wechatWorld = (
  token: () => Response = () => new Response(wechatTokenText),
  user: () => Response = () => new Response(wechatUserText),
) =>
  world(
    { oauth2: [wechatEntry({ appId: "wx-app-id", appSecret: WX_SECRET })] },
    { [WX_TOKEN]: token, [WX_USER]: user },
  );

/** A plain oauth2 list entry with a hook, for the rules of the hook alone. */
function hookEntry(over: Partial<OAuth2Entry> = {}): OAuth2Entry {
  return {
    name: "hooked",
    label: "Continue with Hooked",
    authorizeUrl: "https://id.hooked.example/authorize",
    tokenUrl: "https://id.hooked.example/token",
    clientId: "hooked-id",
    clientSecret: HOOK_SECRET,
    scope: "profile",
    userinfo: async () => ({
      subject: "hooked-1",
      email: null,
      emailVerified: false,
      name: null,
      image: null,
    }),
    ...over,
  };
}

async function users(auth: ReturnType<typeof makeAuth>) {
  return auth.storage.findMany("user", []);
}

async function identities(auth: ReturnType<typeof makeAuth>, provider: string) {
  return auth.storage.findMany("identity", [{ field: "provider", op: "eq", value: provider }]);
}

describe("the tokenRequest hook (plan 12i Task 22)", () => {
  it("runs tokenRequest in place of the standard exchange and passes extra to userinfo", async () => {
    const tokenRequest = vi.fn(async (_input: TokenRequestInput) => ({
      accessToken: "hook-access-0001",
      extra: { account: "acct-7" },
    }));
    const userinfo = vi.fn(
      async (
        _t: string,
        _f: typeof fetch,
        extra?: Record<string, string>,
      ): Promise<SocialProfile> => ({
        subject: `hooked-${extra?.account ?? "none"}`,
        email: null,
        emailVerified: false,
        name: "Hooked",
        image: null,
      }),
    );
    const w = world({ oauth2: [hookEntry({ tokenRequest, userinfo, addressless: true })] }, {});
    const r = await signIn(w.config, "hooked");
    expect(r.done).toMatchObject({ ok: true });
    // The engine made no call of its own: the hook replaced the exchange.
    expect(w.calls).toEqual([]);
    expect(tokenRequest).toHaveBeenCalledTimes(1);
    expect(tokenRequest.mock.calls[0]?.[0]).toMatchObject({
      code: CODE,
      redirectUri: `${BASE_URL}/auth/social/hooked/callback`,
      clientId: "hooked-id",
      clientSecret: HOOK_SECRET,
      codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(userinfo).toHaveBeenCalledTimes(1);
    expect(userinfo.mock.calls[0]?.[0]).toBe("hook-access-0001");
    expect(userinfo.mock.calls[0]?.[2]).toEqual({ account: "acct-7" });
    expect((await identities(w, "hooked")).map((i) => i.subject)).toEqual(["hooked-acct-7"]);
  });

  it("keeps the state row and the binding cookie when tokenRequest is set", async () => {
    const tokenRequest = vi.fn(async () => ({ accessToken: "hook-access-0001", extra: {} }));
    const w = world({ oauth2: [hookEntry({ tokenRequest, addressless: true })] }, {});
    // Another browser's binding cookie: the callback stops before the hook.
    const other = await start(w.config, "hooked");
    const r = await signIn(w.config, "hooked", other.bindToken);
    expect(r.done).toMatchObject({ ok: false, code: "invalid_token" });
    expect(tokenRequest).toHaveBeenCalledTimes(0);
    // The state is spent: the same state again stops before the hook too.
    const again = await completeSocial(w.config, {
      provider: "hooked",
      state: r.url.searchParams.get("state"),
      code: CODE,
      error: null,
      bindToken: other.bindToken,
      ip: "1.1.1.1",
      userAgent: "ua",
    });
    expect(again).toMatchObject({ ok: false, code: "invalid_token" });
    expect(tokenRequest).toHaveBeenCalledTimes(0);
    expect(await users(w)).toEqual([]);
  });

  it("answers oauth_failed on a throw of tokenRequest", async () => {
    const lines = consoleLines();
    const tokenRequest = vi.fn(async (input: { clientSecret: string; code: string }) => {
      throw new Error(`refused ${input.clientSecret} ${input.code}`);
    });
    const userinfo = vi.fn(hookEntry().userinfo);
    const w = world({ oauth2: [hookEntry({ tokenRequest, userinfo, addressless: true })] }, {});
    const r = await signIn(w.config, "hooked");
    expect(r.done).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(userinfo).toHaveBeenCalledTimes(0);
    expect(await users(w)).toEqual([]);
    await w.config.observe.flush();
    // One line with the error class, never the message, the secret, or the code.
    expect(lines()).toContain("social token request failed");
    expect(lines()).not.toContain(HOOK_SECRET);
    expect(lines()).not.toContain(CODE);
  });

  it("refuses a tokenRequest fetch to a host or a path other than tokenUrl", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const answers: Record<string, (c: TokenCall) => Response> = {
      "https://id.hooked.example/token": () => Response.json({ access_token: "a" }),
      "https://evil.example/token": () => Response.json({ access_token: "a" }),
      "https://id.hooked.example/other": () => Response.json({ access_token: "a" }),
    };
    for (const url of ["https://evil.example/token", "https://id.hooked.example/other"]) {
      const userinfo = vi.fn(hookEntry().userinfo);
      const w = world(
        {
          oauth2: [
            hookEntry({
              userinfo,
              addressless: true,
              tokenRequest: async ({ fetch }) => {
                await fetch(url);
                return { accessToken: "a", extra: {} };
              },
            }),
          ],
        },
        answers,
      );
      expect((await signIn(w.config, "hooked")).done).toMatchObject({
        ok: false,
        code: "oauth_failed",
      });
      // The engine refused the call before any network request.
      expect(w.calls).toEqual([]);
      expect(userinfo).toHaveBeenCalledTimes(0);
    }
    // The pinned URL with a query passes, and the call carries no redirect follow.
    const w = world(
      {
        oauth2: [
          hookEntry({
            addressless: true,
            tokenRequest: async ({ fetch }) => {
              await fetch("https://id.hooked.example/token?x=1");
              return { accessToken: "a", extra: {} };
            },
          }),
        ],
      },
      answers,
    );
    expect((await signIn(w.config, "hooked")).done).toMatchObject({ ok: true });
    expect(w.calls.map((c) => c.url)).toEqual(["https://id.hooked.example/token?x=1"]);
  });

  it("answers oauth_failed on a tokenRequest answer that breaks the shape", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bad: unknown[] = [
      null,
      { accessToken: "", extra: {} },
      { accessToken: 7, extra: {} },
      { accessToken: "a\nb", extra: {} },
      { accessToken: "a".repeat(4097), extra: {} },
      { accessToken: "a" },
      { accessToken: "a", extra: [] },
      { accessToken: "a", extra: { k: 1 } },
      { accessToken: "a", extra: { "bad key": "v" } },
      { accessToken: "a", extra: { k: "v\u0000" } },
      {
        accessToken: "a",
        extra: Object.fromEntries([...Array(17).keys()].map((i) => [`k${i}`, "v"])),
      },
    ];
    for (const answer of bad) {
      const userinfo = vi.fn(hookEntry().userinfo);
      const w = world(
        {
          oauth2: [
            hookEntry({
              userinfo,
              addressless: true,
              tokenRequest: async () =>
                answer as { accessToken: string; extra: Record<string, string> },
            }),
          ],
        },
        {},
      );
      expect((await signIn(w.config, "hooked")).done).toMatchObject({
        ok: false,
        code: "oauth_failed",
      });
      expect(userinfo).toHaveBeenCalledTimes(0);
    }
  });

  it("refuses an authorizeClientIdParam of CORE_AUTHORIZE_PARAMS", () => {
    for (const key of ["client_id", "state", "redirect_uri", "code_challenge"])
      expect(() =>
        makeAuth({ social: { oauth2: [hookEntry({ authorizeClientIdParam: key })] } }),
      ).toThrow(/authorizeClientIdParam/);
    // A key of authorizeParams would replace the client id: refused too.
    expect(() =>
      makeAuth({
        social: {
          oauth2: [
            hookEntry({ authorizeClientIdParam: "appid", authorizeParams: { appid: "other" } }),
          ],
        },
      }),
    ).toThrow(/authorizeClientIdParam/);
    expect(() =>
      makeAuth({ social: { oauth2: [hookEntry({ authorizeSuffix: "wechat_redirect" })] } }),
    ).toThrow(/authorizeSuffix/);
    expect(() =>
      makeAuth({ social: { oauth2: [hookEntry({ addressless: false as unknown as true })] } }),
    ).toThrow(/addressless/);
    expect(() =>
      makeAuth({
        social: {
          oauth2: [
            hookEntry({ tokenRequest: "x" as unknown as NonNullable<OAuth2Entry["tokenRequest"]> }),
          ],
        },
      }),
    ).toThrow(/tokenRequest/);
  });

  it("signs in a TikTok profile by its open_id with no address", async () => {
    const w = tiktokWorld();
    const x = json(tiktokExpectedText);
    const first = await signIn(w.config, "tiktok");
    expect(first.url.origin + first.url.pathname).toBe(TT_AUTHORIZE);
    expect(first.url.searchParams.get("client_key")).toBe("tiktok-client-key");
    expect(first.url.searchParams.get("client_id")).toBeNull();
    expect(first.url.searchParams.get("scope")).toBe("user.info.basic");
    expect(first.url.searchParams.get("response_type")).toBe("code");
    // The Login Kit page names no PKCE (read 2026-10-24); the entry sends it, the owner check proves it.
    expect(first.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(first.done).toMatchObject({
      ok: true,
      value: { user: { email: null, emailVerified: false, name: x.name, image: x.image } },
    });
    // The token call: a form POST with client_key, never client_id.
    const token = w.calls[0];
    expect(token?.url).toBe(TT_TOKEN);
    expect(token?.form).toEqual({
      client_key: "tiktok-client-key",
      client_secret: TT_SECRET,
      code: CODE,
      grant_type: "authorization_code",
      redirect_uri: `${BASE_URL}/auth/social/tiktok/callback`,
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(w.calls[1]?.url).toBe(TT_USER);
    expect(w.calls[1]?.headers.authorization).toBe("Bearer act.tiktok-access-0001");
    expect((await identities(w, "tiktok")).map((i) => i.subject)).toEqual([x.subject]);
    // No email identity: the user has no address.
    expect(await identities(w, "email")).toEqual([]);
    const second = await signIn(w.config, "tiktok");
    expect(second.done).toMatchObject({ ok: true });
    const all = await users(w);
    expect(all).toHaveLength(1);
    expect(all[0]?.email).toBeNull();
    if (
      first.done.ok &&
      second.done.ok &&
      "user" in first.done.value &&
      "user" in second.done.value
    )
      expect(second.done.value.user.id).toBe(first.done.value.user.id);
    else throw new Error("no user");
  });

  it("answers oauth_failed on a TikTok error envelope", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: [string, ReturnType<typeof tiktokWorld>][] = [
      ["user error.code", tiktokWorld(undefined, () => new Response(tiktokUserErrorText))],
      [
        "user error.code beside a user",
        tiktokWorld(undefined, () =>
          Response.json({ ...json(tiktokUserText), error: json(tiktokUserErrorText).error }),
        ),
      ],
      ["token error body", tiktokWorld(() => new Response(tiktokTokenErrorText))],
      [
        "token error status",
        tiktokWorld(() => new Response(tiktokTokenErrorText, { status: 400 })),
      ],
      [
        "another open_id",
        tiktokWorld(undefined, () => {
          const u = json(tiktokUserText) as { data: { user: Json } };
          u.data.user.open_id = "-000another";
          return Response.json(u);
        }),
      ],
    ];
    for (const [what, w] of cases) {
      const r = await signIn(w.config, "tiktok");
      expect(r.done, what).toMatchObject({ ok: false, code: "oauth_failed" });
      expect(await users(w), what).toEqual([]);
    }
  });

  it("builds the WeChat authorize URL with appid and the fragment, and no code_challenge", async () => {
    const w = wechatWorld();
    const s = await start(w.config, "wechat");
    expect(s.location.endsWith("#wechat_redirect")).toBe(true);
    const url = new URL(s.location);
    expect(url.hash).toBe("#wechat_redirect");
    expect(url.origin + url.pathname).toBe(WX_AUTHORIZE);
    expect(url.searchParams.get("appid")).toBe("wx-app-id");
    expect(url.searchParams.get("client_id")).toBeNull();
    expect(url.searchParams.get("scope")).toBe("snsapi_login");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE_URL}/auth/social/wechat/callback`);
    expect(url.searchParams.get("state")).toMatch(/^os_/);
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(url.searchParams.get("code_challenge_method")).toBeNull();
    expect(url.searchParams.get("nonce")).toBeNull();
    const r = await signIn(w.config, "wechat");
    expect(r.done).toMatchObject({ ok: true });
    // The token call is a GET with appid, secret, and code in the query, and no verifier.
    const token = new URL(w.calls[0]?.url ?? "");
    expect(token.origin + token.pathname).toBe(WX_TOKEN);
    expect(Object.fromEntries(token.searchParams)).toEqual({
      appid: "wx-app-id",
      secret: WX_SECRET,
      code: CODE,
      grant_type: "authorization_code",
    });
    expect(w.calls[0]?.form).toEqual({});
    // A plain entry with pkce false and the standard exchange sends no verifier either.
    const plain = world(
      { oauth2: [hookEntry({ pkce: false })] },
      { "https://id.hooked.example/token": () => Response.json({ access_token: "a" }) },
    );
    const p = await signIn(plain.config, "hooked");
    expect(p.url.searchParams.get("code_challenge")).toBeNull();
    expect(plain.calls[0]?.form).toEqual({
      grant_type: "authorization_code",
      code: CODE,
      redirect_uri: `${BASE_URL}/auth/social/hooked/callback`,
      client_id: "hooked-id",
      client_secret: HOOK_SECRET,
    });
  });

  it("answers oauth_failed on a WeChat errcode with status 200", async () => {
    const lines = consoleLines();
    // An errcode beside the other fields fails too: the errcode decides.
    const withCode = (text: string) => () =>
      Response.json({ ...json(text), ...json(wechatTokenErrorText) });
    for (const w of [
      wechatWorld(() => new Response(wechatTokenErrorText)),
      wechatWorld(undefined, () => new Response(wechatUserErrorText)),
      wechatWorld(withCode(wechatTokenText)),
      wechatWorld(undefined, withCode(wechatUserText)),
    ]) {
      const r = await signIn(w.config, "wechat");
      expect(r.done).toMatchObject({ ok: false, code: "oauth_failed" });
      expect(await users(w)).toEqual([]);
      expect(await w.storage.findMany("session", [])).toEqual([]);
      await w.config.observe.flush();
    }
    // The token URL holds the secret and the code: no line may hold either.
    expect(lines()).not.toContain(WX_SECRET);
    expect(lines()).not.toContain(CODE);
  });

  it("takes the WeChat unionid as the subject, else the openid", async () => {
    const x = json(wechatExpectedText);
    const union = wechatWorld();
    expect((await signIn(union.config, "wechat")).done).toMatchObject({
      ok: true,
      value: { user: { email: null, emailVerified: false, name: x.name, image: x.image } },
    });
    expect((await identities(union, "wechat")).map((i) => i.subject)).toEqual([x.subject]);
    // The userinfo call names the openid of the token answer.
    expect(new URL(union.calls[1]?.url ?? "").searchParams.get("openid")).toBe(x.openidSubject);

    const open = wechatWorld(
      () => new Response(wechatTokenOpenidText),
      () => new Response(wechatUserOpenidText),
    );
    expect((await signIn(open.config, "wechat")).done).toMatchObject({ ok: true });
    expect((await identities(open, "wechat")).map((i) => i.subject)).toEqual([x.openidSubject]);

    // A unionid of the user info answer alone still names the subject.
    const late = wechatWorld(() => new Response(wechatTokenOpenidText));
    expect((await signIn(late.config, "wechat")).done).toMatchObject({ ok: true });
    expect((await identities(late, "wechat")).map((i) => i.subject)).toEqual([x.subject]);

    vi.spyOn(console, "error").mockImplementation(() => {});
    // Two answers that disagree on the person refuse the sign-in.
    for (const patch of [{ openid: "o-another" }, { unionid: "u-another" }]) {
      const w = wechatWorld(undefined, () => Response.json({ ...json(wechatUserText), ...patch }));
      expect((await signIn(w.config, "wechat")).done).toMatchObject({
        ok: false,
        code: "oauth_failed",
      });
    }
  });

  it("never links an addressless profile by address", async () => {
    const used = "mia@example.com";
    const userinfo = async (): Promise<SocialProfile> => ({
      subject: "hooked-mia",
      email: used,
      emailVerified: true,
      name: "Mia",
      image: null,
    });
    const w = world(
      {
        oauth2: [
          hookEntry({
            userinfo,
            addressless: true,
            tokenRequest: async () => ({ accessToken: "a", extra: {} }),
          }),
        ],
      },
      {},
    );
    const owner = await w.seedUser(used);
    const r = await signIn(w.config, "hooked");
    expect(r.done).toMatchObject({
      ok: true,
      value: { user: { email: null, emailVerified: false } },
    });
    // The owner holds no new identity, and the new user holds no address.
    expect(
      await w.storage.findMany("identity", [{ field: "userId", op: "eq", value: owner.id }]),
    ).toEqual([]);
    const made = (await users(w)).filter((u) => u.id !== owner.id);
    expect(made).toHaveLength(1);
    expect(made[0]?.email).toBeNull();
    expect(await identities(w, "email")).toEqual([]);
    // The second sign-in finds the same user by the identity.
    expect((await signIn(w.config, "hooked")).done).toMatchObject({ ok: true });
    expect(await users(w)).toHaveLength(2);
  });
});
