import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, ResolvedConfig } from "../src/config.js";
import { completeSocial, startSocial } from "../src/engine/social.js";
import facebookSource from "../src/social/facebook.ts?raw";
import facebookExpectedText from "./fixtures/providers/facebook/expected.json?raw";
import facebookMeText from "./fixtures/providers/facebook/me.json?raw";
import slackExpectedText from "./fixtures/providers/slack/expected.json?raw";
import slackTokenErrorText from "./fixtures/providers/slack/token-error.json?raw";
import slackUserinfoText from "./fixtures/providers/slack/userinfo.json?raw";
import twitterExpectedText from "./fixtures/providers/twitter/expected.json?raw";
import twitterMeText from "./fixtures/providers/twitter/me.json?raw";
import twitterMeEmailText from "./fixtures/providers/twitter/me-email.json?raw";
import { makeAuth } from "./helpers.js";
import { fakeFetch, type TokenCall } from "./social-helpers.js";

type Json = Record<string, unknown>;
const json = (text: string) => JSON.parse(text) as Json;

const ACCESS = "preset-access-token-0002";
const SLACK_TOKEN = "https://slack.com/api/openid.connect.token";
const SLACK_USER = "https://slack.com/api/openid.connect.userInfo";
const X_TOKEN = "https://api.x.com/2/oauth2/token";
const X_ME = "https://api.x.com/2/users/me";
const GRAPH = "v26.0";
const FB_TOKEN = `https://graph.facebook.com/${GRAPH}/oauth/access_token`;
const FB_ME = "https://graph.facebook.com/me?fields=id,name,email,picture";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Starts a flow for `provider` and completes it with the provider answers of the fetch. */
async function signIn(config: ResolvedConfig, provider: string) {
  const s = await startSocial(config, { provider, next: "/home", ip: "1.1.1.1" });
  if (!s.ok) throw new Error(`start failed: ${s.code}`);
  const url = new URL(s.value.location);
  const done = await completeSocial(config, {
    provider,
    state: url.searchParams.get("state"),
    code: "code-1",
    error: null,
    bindToken: s.value.bindToken,
    ip: "1.1.1.1",
    userAgent: "ua",
  });
  return { url, done };
}

/** A provider world: `answer` serves each URL, and a 404 serves any other. */
function world(social: AuthConfig["social"], answer: Record<string, (c: TokenCall) => Response>) {
  const f = fakeFetch((call) => answer[call.url]?.(call) ?? new Response("nf", { status: 404 }));
  const auth = makeAuth({ social: { ...social, fetch: f.fetchFn } });
  return { ...auth, calls: f.calls };
}

const tokenAnswer = () => Response.json({ access_token: ACCESS, token_type: "bearer" });

const slackToken = () => Response.json({ ok: true, access_token: ACCESS, token_type: "Bearer" });

const slackWorld = (token: () => Response = slackToken) =>
  world(
    { slack: { clientId: "slack-id", clientSecret: "slack-secret" } },
    { [SLACK_TOKEN]: token, [SLACK_USER]: () => new Response(slackUserinfoText) },
  );

const twitterWorld = (email: () => Response = () => new Response(twitterMeEmailText)) =>
  world(
    { twitter: { clientId: "x-client-id", clientSecret: "x-client:secret" } },
    {
      [X_TOKEN]: tokenAnswer,
      [`${X_ME}?user.fields=profile_image_url`]: () => new Response(twitterMeText),
      [`${X_ME}?user.fields=confirmed_email`]: email,
    },
  );

const facebookWorld = () =>
  world(
    { facebook: { clientId: "fb-app-id", clientSecret: "fb-secret" } },
    { [FB_TOKEN]: tokenAnswer, [FB_ME]: () => new Response(facebookMeText) },
  );

async function subjects(auth: ReturnType<typeof makeAuth>, provider: string) {
  const ids = await auth.storage.findMany("identity", [
    { field: "provider", op: "eq", value: provider },
  ]);
  return ids.map((i) => i.subject);
}

const userOf = (x: Json) => ({
  user: { email: x.email, emailVerified: x.emailVerified, name: x.name, image: x.image },
});

describe("the presets of plan 12i Task 14", () => {
  it("maps each recorded profile to its subject, address, and verified flag", async () => {
    const slack = slackWorld();
    const s = await signIn(slack.config, "slack");
    const sx = json(slackExpectedText);
    expect(s.url.origin + s.url.pathname).toBe("https://slack.com/openid/connect/authorize");
    expect(s.url.searchParams.get("scope")).toBe("openid profile email");
    expect(s.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(s.done).toMatchObject({ ok: true, value: userOf(sx) });
    expect(await subjects(slack, "slack")).toEqual([sx.subject]);
    expect(slack.calls[1]?.headers.authorization).toBe(`Bearer ${ACCESS}`);

    const x = twitterWorld();
    const t = await signIn(x.config, "twitter");
    const tx = json(twitterExpectedText);
    expect(t.url.origin + t.url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(t.url.searchParams.get("scope")).toBe("users.read tweet.read users.email");
    expect(t.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(t.done).toMatchObject({ ok: true, value: userOf(tx) });
    expect(await subjects(x, "twitter")).toEqual([tx.subject]);
    // A failed address read gives no address, not oauth_failed. A new user needs one.
    const bare = twitterWorld(() => new Response("forbidden", { status: 403 }));
    expect((await signIn(bare.config, "twitter")).done).toMatchObject({
      ok: false,
      code: "email_required",
    });

    const fb = facebookWorld();
    const f = await signIn(fb.config, "facebook");
    const fx = json(facebookExpectedText);
    expect(f.url.origin + f.url.pathname).toBe(`https://www.facebook.com/${GRAPH}/dialog/oauth`);
    expect(f.url.searchParams.get("scope")).toBe("email public_profile");
    expect(f.done).toMatchObject({ ok: true, value: userOf(fx) });
    expect(await subjects(fb, "facebook")).toEqual([fx.subject]);
  });

  it("answers oauth_failed on a Slack token answer with ok false and status 200", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const slack = slackWorld(() => new Response(slackTokenErrorText, { status: 200 }));
    const r = await signIn(slack.config, "slack");
    expect(r.done).toMatchObject({ ok: false, code: "oauth_failed" });
    // The refusal is the ok check, and no user info read follows it.
    expect(log.mock.calls).toEqual([["authtempo: social token answer refused", "slack"]]);
    expect(slack.calls.map((c) => c.url)).toEqual([SLACK_TOKEN]);
    expect(await slack.storage.findMany("user", [])).toHaveLength(0);
  });

  it("sends HTTP Basic client auth when tokenAuth is basic", async () => {
    const x = twitterWorld();
    expect((await signIn(x.config, "twitter")).done).toMatchObject({ ok: true });
    const token = x.calls[0];
    expect(token?.url).toBe(X_TOKEN);
    // RFC 6749 section 2.3.1: each half is form-encoded, so the colon of the secret is %3A.
    expect(token?.headers.authorization).toBe(`Basic ${btoa("x-client-id:x-client%3Asecret")}`);
    expect(token?.form).not.toHaveProperty("client_secret");
    expect(token?.form).not.toHaveProperty("client_id");
    expect(token?.form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // A preset on the form method sends no header.
    const slack = slackWorld();
    expect((await signIn(slack.config, "slack")).done).toMatchObject({ ok: true });
    expect(slack.calls[0]?.headers.authorization).toBeUndefined();
    expect(slack.calls[0]?.form).toMatchObject({
      client_id: "slack-id",
      client_secret: "slack-secret",
    });
  });

  it("never links a Facebook address", async () => {
    const fb = facebookWorld();
    const owner = await fb.seedUser("mia@example.com");
    const r = await signIn(fb.config, "facebook");
    expect(r.done).toMatchObject({ ok: false, code: "email_taken_unverified" });
    expect(
      await fb.storage.findMany("identity", [{ field: "userId", op: "eq", value: owner.id }]),
    ).toEqual([]);
    expect(await fb.storage.findMany("session", [])).toHaveLength(0);
  });

  it("pins the Graph version with its read date", () => {
    const fb = facebookWorld();
    const p = fb.config.social.providers[0];
    expect(p?.authorizeUrl).toBe(`https://www.facebook.com/${GRAPH}/dialog/oauth`);
    expect(p?.tokenUrl).toBe(FB_TOKEN);
    // The version constant carries the day of the changelog read in its comment.
    expect(facebookSource).toMatch(
      /\/\*\*[^\n]*read \d{4}-\d{2}-\d{2}[^\n]*\*\/\nexport const GRAPH_VERSION = "v26\.0";/,
    );
  });
});
