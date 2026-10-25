import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, ResolvedConfig } from "../src/config.js";
import { completeSocial, startSocial } from "../src/engine/social.js";
import discordExpectedText from "./fixtures/providers/discord/expected.json?raw";
import discordUserText from "./fixtures/providers/discord/user.json?raw";
import gitlabExpectedText from "./fixtures/providers/gitlab/expected.json?raw";
import gitlabUserText from "./fixtures/providers/gitlab/user.json?raw";
import microsoftClaimsText from "./fixtures/providers/microsoft/claims.json?raw";
import microsoftExpectedText from "./fixtures/providers/microsoft/expected.json?raw";
import { makeAuth } from "./helpers.js";
import { fakeFetch } from "./social-helpers.js";

type Json = Record<string, unknown>;
const json = (text: string) => JSON.parse(text) as Json;

const MS = "https://login.microsoftonline.com";
const CONSUMER_TID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const TENANT_A = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const TENANT_B = "11111111-2222-4333-8444-555555555555";
const ENTRA_CLIENT = "entra-client-id";
const ACCESS = "preset-access-token-0001";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Starts a flow for `provider` and completes it with the provider answers of the fetch. */
async function signIn(config: ResolvedConfig, provider: string, onStart?: (nonce: string) => void) {
  const s = await startSocial(config, { provider, next: "/home", ip: "1.1.1.1" });
  if (!s.ok) throw new Error(`start failed: ${s.code}`);
  const url = new URL(s.value.location);
  onStart?.(url.searchParams.get("nonce") ?? "");
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

/**
 * An Entra ID world. It has an RS256 test key and its key set at the
 * tenant's JWKS URL. Its token endpoint signs the claims of `claims()` with
 * the nonce of the start. The jwt seam is core's jose seam on `social.fetch`.
 */
async function entraWorld(tenant: string, extra: Partial<AuthConfig> = {}) {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  let claims: Json = {};
  let nonce = "";
  let auth: ReturnType<typeof makeAuth> | undefined;
  const f = fakeFetch(async (call) => {
    if (call.url === `${MS}/${tenant}/discovery/v2.0/keys`) return Response.json({ keys: [jwk] });
    if (call.url === `${MS}/${tenant}/oauth2/v2.0/token`) {
      const iat = Math.floor((auth?.clock.now().getTime() ?? 0) / 1000);
      const idToken = await new SignJWT({
        aud: ENTRA_CLIENT,
        nonce,
        iat,
        exp: iat + 600,
        ...claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .sign(privateKey);
      return Response.json({ id_token: idToken, access_token: ACCESS, token_type: "Bearer" });
    }
    return new Response("not found", { status: 404 });
  });
  auth = makeAuth({
    social: {
      microsoft: { clientId: ENTRA_CLIENT, clientSecret: "entra-secret", tenant },
      fetch: f.fetchFn,
    },
    ...extra,
  });
  const made = auth;
  return {
    ...made,
    calls: f.calls,
    signIn(next: Json) {
      claims = next;
      return signIn(made.config, "microsoft", (n) => {
        nonce = n;
      });
    },
  };
}

/** The token endpoint and the profile endpoint of an oauth2 preset. */
function oauth2World(
  social: AuthConfig["social"],
  tokenUrl: string,
  userUrl: string,
  user: () => Response,
) {
  const f = fakeFetch((call) => {
    if (call.url === tokenUrl) return Response.json({ access_token: ACCESS, token_type: "Bearer" });
    if (call.url === userUrl) return user();
    return new Response("not found", { status: 404 });
  });
  const auth = makeAuth({ social: { ...social, fetch: f.fetchFn } });
  return { ...auth, calls: f.calls };
}

const discordWorld = (user: () => Response) =>
  oauth2World(
    { discord: { clientId: "discord-id", clientSecret: "discord-secret" } },
    "https://discord.com/api/oauth2/token",
    "https://discord.com/api/users/@me",
    user,
  );

const gitlabWorld = (user: () => Response, issuer = "https://gitlab.com") =>
  oauth2World(
    { gitlab: { clientId: "gitlab-id", clientSecret: "gitlab-secret", issuer } },
    `${issuer}/oauth/token`,
    `${issuer}/api/v4/user`,
    user,
  );

async function subjects(auth: ReturnType<typeof makeAuth>, provider: string) {
  const ids = await auth.storage.findMany("identity", [
    { field: "provider", op: "eq", value: provider },
  ]);
  return ids.map((i) => i.subject);
}

describe("the presets of plan 12i Task 13", () => {
  it("maps each recorded profile to its subject, address, and verified flag", async () => {
    const entra = await entraWorld(TENANT_A);
    const m = await entra.signIn(json(microsoftClaimsText));
    const mx = json(microsoftExpectedText);
    expect(m.url.origin + m.url.pathname).toBe(`${MS}/${TENANT_A}/oauth2/v2.0/authorize`);
    expect(m.url.searchParams.get("scope")).toBe("openid profile email");
    expect(m.done).toMatchObject({
      ok: true,
      value: {
        user: { email: mx.email, emailVerified: mx.emailVerified, name: mx.name, image: mx.image },
      },
    });
    expect(await subjects(entra, "microsoft")).toEqual([mx.subject]);

    const discord = discordWorld(() => new Response(discordUserText));
    const d = await signIn(discord.config, "discord");
    const dx = json(discordExpectedText);
    expect(d.url.origin + d.url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(d.url.searchParams.get("scope")).toBe("identify email");
    expect(d.done).toMatchObject({
      ok: true,
      value: {
        user: { email: dx.email, emailVerified: dx.emailVerified, name: dx.name, image: dx.image },
      },
    });
    expect(await subjects(discord, "discord")).toEqual([dx.subject]);
    expect(discord.calls[1]?.headers.authorization).toBe(`Bearer ${ACCESS}`);

    const gitlab = gitlabWorld(() => new Response(gitlabUserText));
    const g = await signIn(gitlab.config, "gitlab");
    const gx = json(gitlabExpectedText);
    expect(g.url.origin + g.url.pathname).toBe("https://gitlab.com/oauth/authorize");
    expect(g.url.searchParams.get("scope")).toBe("read_user");
    expect(g.done).toMatchObject({
      ok: true,
      value: {
        user: { email: gx.email, emailVerified: gx.emailVerified, name: gx.name, image: gx.image },
      },
    });
    expect(await subjects(gitlab, "gitlab")).toEqual([gx.subject]);
  });

  it("links no user by an Entra ID address without a verified marker", async () => {
    const entra = await entraWorld(TENANT_A);
    const owner = await entra.seedUser("abeli@microsoft.com");
    const { xms_edov: _marker, ...claims } = json(microsoftClaimsText);
    const r = await entra.signIn({ ...claims, email_verified: true });
    expect(r.done).toMatchObject({ ok: false, code: "email_taken_unverified" });
    expect(
      await entra.storage.findMany("identity", [{ field: "userId", op: "eq", value: owner.id }]),
    ).toEqual([]);
    expect(await entra.storage.findMany("session", [])).toHaveLength(0);
  });

  it("links no user by a Discord address that Discord has not verified", async () => {
    const discord = discordWorld(() =>
      Response.json({ ...json(discordUserText), verified: false }),
    );
    const owner = await discord.seedUser("nelly@discord.com");
    const r = await signIn(discord.config, "discord");
    expect(r.done).toMatchObject({ ok: false, code: "email_taken_unverified" });
    expect(
      await discord.storage.findMany("identity", [{ field: "userId", op: "eq", value: owner.id }]),
    ).toEqual([]);
    expect(await discord.storage.findMany("session", [])).toHaveLength(0);
  });

  it("refuses an issuer that does not match tid", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const entra = await entraWorld("common");
    const claims = json(microsoftClaimsText);
    // A token of tenant A whose issuer names tenant B.
    const bad = await entra.signIn({ ...claims, tid: TENANT_A, iss: `${MS}/${TENANT_B}/v2.0` });
    expect(bad.done).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(log.mock.calls).toEqual([["authtempo: social id token claims refused", "microsoft"]]);
    // An issuer off the tenant form is refused before the verify: no key set read.
    const off = await entraWorld("common");
    const offIss = await off.signIn({
      ...claims,
      tid: TENANT_A,
      iss: `https://id.example/${TENANT_A}/v2.0`,
    });
    expect(offIss.done).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(off.calls.map((c) => c.url)).toEqual([`${MS}/common/oauth2/v2.0/token`]);
    expect(log.mock.calls).toHaveLength(2);
    expect(log.mock.calls[1]).toEqual(["authtempo: social id token claims refused", "microsoft"]);
    // The same token with its own issuer signs in under common.
    const good = await entra.signIn({ ...claims, tid: TENANT_B, iss: `${MS}/${TENANT_B}/v2.0` });
    expect(good.done).toMatchObject({ ok: true });
    // A GUID tenant takes no token of another tenant.
    const one = await entraWorld(TENANT_A);
    const other = await one.signIn({ ...claims, tid: TENANT_B, iss: `${MS}/${TENANT_B}/v2.0` });
    expect(other.done).toMatchObject({ ok: false, code: "oauth_failed" });
  });

  it("refuses the consumer tenant under organizations and needs it under consumers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const claims = json(microsoftClaimsText);
    const personal = { ...claims, tid: CONSUMER_TID, iss: `${MS}/${CONSUMER_TID}/v2.0` };
    const work = { ...claims, tid: TENANT_A, iss: `${MS}/${TENANT_A}/v2.0` };
    const orgs = await entraWorld("organizations");
    expect((await orgs.signIn(personal)).done).toMatchObject({ ok: false, code: "oauth_failed" });
    expect((await orgs.signIn(work)).done).toMatchObject({ ok: true });
    const consumers = await entraWorld("consumers");
    expect((await consumers.signIn(work)).done).toMatchObject({ ok: false, code: "oauth_failed" });
    expect((await consumers.signIn(personal)).done).toMatchObject({ ok: true });
  });

  it("refuses a GitLab user who is not active or is locked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = json(gitlabUserText);
    for (const answer of [
      { ...user, state: "blocked" },
      { ...user, state: "deactivated" },
      { ...user, locked: true },
    ]) {
      const gitlab = gitlabWorld(() => Response.json(answer));
      expect((await signIn(gitlab.config, "gitlab")).done).toMatchObject({
        ok: false,
        code: "oauth_failed",
      });
      expect(await gitlab.storage.findMany("user", [])).toHaveLength(0);
    }
  });

  it("refuses a list entry named for a reserved preset", () => {
    for (const name of ["microsoft", "discord", "gitlab", "slack", "twitter", "facebook"])
      expect(() =>
        makeAuth({
          social: {
            oauth2: [
              {
                name,
                label: name,
                authorizeUrl: "https://id.example/authorize",
                tokenUrl: "https://id.example/token",
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
              },
            ],
          },
        }),
      ).toThrow(
        // The text names the presets that exist. Plan 12i Task 14 left no name kept for a coming preset.
        `social.oauth2[0].name ${name} is reserved: google, apple, github, linkedin, microsoft, discord, gitlab, slack, twitter, and facebook are presets; email and credential are identity kinds`,
      );
  });

  it("refuses a GitLab issuer that is not an https origin", () => {
    const gitlab = (issuer: string) =>
      makeAuth({ social: { gitlab: { clientId: "g", clientSecret: "s", issuer } } });
    for (const issuer of [
      "http://gitlab.example.com",
      "https://gitlab.example.com/",
      "https://gitlab.example.com/gitlab",
      "https://gitlab.example.com?x=1",
      "https://user:pw@gitlab.example.com",
      "https://10.0.0.5",
      "https://gitlab.internal",
      "https://localhost",
      "https://api.example.com",
      "gitlab.example.com",
      // An empty label hides a local name from a rule that strips one dot. The
      // issuer shares isPublicHost, which refuses each (final review D, M1).
      "https://localhost...",
      "https://gitlab.internal...",
      "https://a..example.com",
    ])
      expect(() => gitlab(issuer), issuer).toThrow(
        /social\.gitlab\.issuer must be an https origin/,
      );
    expect(gitlab("https://gitlab.example.com").config.social.providers[0]).toMatchObject({
      name: "gitlab",
      tokenUrl: "https://gitlab.example.com/oauth/token",
    });
  });
});
