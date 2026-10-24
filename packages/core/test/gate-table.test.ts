import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { CAPTCHA_FLOWS } from "../src/captcha.js";
import type { AuthConfig } from "../src/config.js";
import { ANONYMOUS_REFUSED } from "../src/engine/anonymous.js";
import { continueHandoff, startHandoff } from "../src/engine/handoff.js";
import { SESSION_VIA, type SessionVia } from "../src/engine/hooks.js";
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import { addPhone, verifyAddPhone } from "../src/engine/phone.js";
import type { ChallengeMethod } from "../src/engine/second-factor.js";
import { enableEmailMethod, enablePasskeyMethod } from "../src/engine/second-factor-methods.js";
import { resolveSession } from "../src/engine/sessions.js";
import { completeSocial, startLink, startSocial } from "../src/engine/social.js";
import { challengeView, enableTotp, setupTotp } from "../src/engine/totp.js";
import { setUsername } from "../src/engine/username.js";
import { IMPERSONATION_REFUSED } from "../src/http/impersonation-rules.js";
import { ROUTES, type RouteKey } from "../src/http/route-list.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { SIGN_IN_ROUTES } from "../src/observe/events.js";
import { sha256Base64Url, sha256Hex } from "../src/primitives/crypto.js";
import { base32Decode } from "../src/primitives/totp.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import discordUserText from "./fixtures/providers/discord/user.json?raw";
import microsoftClaimsText from "./fixtures/providers/microsoft/claims.json?raw";
import slackUserinfoText from "./fixtures/providers/slack/userinfo.json?raw";
import twitterMeText from "./fixtures/providers/twitter/me.json?raw";
import twitterMeEmailText from "./fixtures/providers/twitter/me-email.json?raw";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post, recordCredential, settled } from "./helpers.js";
import { OPERATOR_SECRETS, operatorFixture } from "./operator-helpers.js";
import { FAST } from "./password-helpers.js";
import { fakeFetch, type TokenCall } from "./social-helpers.js";
import { seedOrganization, verifiedDomain } from "./sso/helpers.js";
import { oidcConnection, ssoSignIn, ssoSignInWorld } from "./sso/sign-in-helpers.js";
import { codeNow, PASSWORD, verifiedSession } from "./totp-helpers.js";

/**
 * The gate table (plan 12i Task 15, Review Focus 1, ASVS 6.3.4): the one
 * place that says which gate each sign-in pathway passes. Each row runs
 * its pathway for a user with every second-factor method on (TOTP, a
 * passkey, and the email code) and expects exactly its challenge methods,
 * or a session with no challenge. A `SessionVia` value with no row fails,
 * so a new way to open a session cannot ship without a decision here.
 * Every state comes from the flows of the product.
 */

const EMAIL = "ada@example.com";
const PHONE = "+14155550100";
const RP = { rpID: "example.com", rpName: "Example", origins: [APP_ORIGIN] };

/** The methods of a challenge after a password sign-in: the email code passes there only (12c decision 4). */
const PASSWORD_METHODS: ChallengeMethod[] = ["passkey", "totp", "email", "backup"];
/** The methods of a challenge after any other first factor. */
const OTHER_METHODS: ChallengeMethod[] = ["passkey", "totp", "backup"];

type Outcome =
  | { kind: "challenge"; methods: ChallengeMethod[] }
  | { kind: "session"; via: SessionVia };

/**
 * One row of the gate table: a pathway, its `via`, the gate that decides
 * it, and the outcome. `off` is the config that turns the row's gate key
 * off: the same pathway then opens a session, so the row names the key
 * that decides it. `run` takes config keys that replace the world's.
 */
interface GateRow {
  pathway: string;
  via: SessionVia;
  gate: string;
  expect: Outcome;
  off?: Partial<AuthConfig>;
  run: (extra: Partial<AuthConfig>) => Promise<Outcome>;
}

// ---------------------------------------------------------------------------
// The world: one core with every pathway on, and the fake provider answers.
// ---------------------------------------------------------------------------

const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_CLIENT = "web.apps.googleusercontent.com";
const MS = "https://login.microsoftonline.com";
const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const ACCESS = "gate-table-access-token";
const GITHUB_OVERRIDE = `${BASE_URL}/auth/oauth/github`;

const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };

/** The provider answers of every social row. Each profile carries the user's address as verified. */
function providerFetch(state: { msNonce: string; now: () => number }) {
  return fakeFetch(async (call: TokenCall) => {
    const at = { access_token: ACCESS, token_type: "Bearer" };
    switch (call.url) {
      case GOOGLE_JWKS:
      case `${MS}/${TENANT}/discovery/v2.0/keys`:
        return Response.json({ keys: [JWK] });
      case "https://github.com/login/oauth/access_token":
        return Response.json({ access_token: ACCESS, scope: "read:user", token_type: "bearer" });
      case "https://api.github.com/user":
        return Response.json({ login: "ada", id: 7, name: "Ada", email: null, avatar_url: null });
      case "https://api.github.com/user/emails":
        return Response.json([{ email: EMAIL, primary: true, verified: true, visibility: null }]);
      case `${MS}/${TENANT}/oauth2/v2.0/token`: {
        const iat = state.now();
        const idToken = await new SignJWT({
          ...(JSON.parse(microsoftClaimsText) as Record<string, unknown>),
          email: EMAIL,
          aud: "entra-client-id",
          nonce: state.msNonce,
          iat,
          exp: iat + 600,
        })
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .sign(privateKey);
        return Response.json({ id_token: idToken, ...at });
      }
      case "https://discord.com/api/oauth2/token":
      case "https://api.x.com/2/oauth2/token":
        return Response.json(at);
      case "https://slack.com/api/openid.connect.token":
        return Response.json({ ok: true, ...at });
      case "https://discord.com/api/users/@me":
        return Response.json({ ...JSON.parse(discordUserText), email: EMAIL, verified: true });
      case "https://slack.com/api/openid.connect.userInfo":
        return Response.json({ ...JSON.parse(slackUserinfoText), email: EMAIL });
      case "https://api.x.com/2/users/me?user.fields=profile_image_url":
        return new Response(twitterMeText);
      case "https://api.x.com/2/users/me?user.fields=confirmed_email": {
        const me = JSON.parse(twitterMeEmailText) as { data: Record<string, unknown> };
        return Response.json({ ...me, data: { ...me.data, confirmed_email: EMAIL } });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  });
}

/** The config of the main world: every pathway that a user with a factor can take. */
function gateConfig(fetch: typeof globalThis.fetch, sms: ReturnType<typeof createRecordingSms>) {
  return {
    password: { hash: FAST, uniformSignUp: false },
    username: {},
    phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: true },
    passkey: { ...RP, signUp: { isolateLimiter: "allow" } },
    anonymous: { isolateLimiter: "allow" },
    multiSession: {},
    handoff: { schemes: ["consumera://"] },
    social: {
      google: { clientId: GOOGLE_CLIENT, clientSecret: "g-secret" },
      github: { clientId: "gh-id", clientSecret: "gh-secret", redirectURI: GITHUB_OVERRIDE },
      microsoft: { clientId: "entra-client-id", clientSecret: "entra-secret", tenant: TENANT },
      discord: { clientId: "discord-id", clientSecret: "discord-secret" },
      slack: { clientId: "slack-id", clientSecret: "slack-secret" },
      twitter: { clientId: "x-client-id", clientSecret: "x-client:secret" },
      fetch,
    },
  } satisfies Partial<AuthConfig>;
}

let ips = 0;
/** A new client IP for each request, so no per-IP limit decides a row. */
const ip = () => ({ "cf-connecting-ip": `198.51.100.${(++ips % 250) + 1}` });

/** A cookie jar over a handler: the cookies that the routes set go back on the next request. */
function browser(handle: (r: Request) => Promise<Response>) {
  const jar = new Map<string, string>();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  async function send(build: (headers: Record<string, string>) => Request): Promise<Response> {
    const res = await handle(build({ ...ip(), ...(jar.size > 0 ? { cookie: cookie() } : {}) }));
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (attrs.some((a) => a.trim() === "Max-Age=0") || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  }
  return {
    jar,
    post: (path: string, body: unknown) => send((h) => post(`/auth${path}`, body, h)),
    get: (path: string) => send((h) => get(`/auth${path}`, h)),
  };
}
type Browser = ReturnType<typeof browser>;

/**
 * The user of every row: a verified address with a password, a username
 * and a phone where the world has them (the phone set by its code), and a
 * passkey, then TOTP, the passkey method, and the email method on, each
 * through its enable flow.
 */
async function factorUser(
  auth: ReturnType<typeof makeAuth>,
  sms?: { sent: { text: string }[] },
  email = EMAIL,
) {
  const session = await verifiedSession(auth, email);
  if (auth.config.username) {
    const named = await setUsername(auth.config, {
      session,
      username: "ada",
      ip: null,
      userAgent: null,
    });
    if (!named.ok) throw new Error(named.code);
  }
  if (auth.config.phone && sms) {
    const added = await addPhone(auth.config, { session, phone: PHONE, ip: "203.0.113.9" });
    if (!added.ok) throw new Error(added.code);
    const code = recordCredential(/^(\d+) /.exec(sms.sent.at(-1)?.text ?? "")?.[1] ?? "");
    const set = await verifyAddPhone(auth.config, { session, code, ip: null, userAgent: null });
    if (!set.ok) throw new Error(set.code);
  }
  const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
  const options = await passkeyRegistrationOptions(auth.config, { user: session.user });
  if (!options.ok) throw new Error(options.code);
  const registered = await verifyPasskeyRegistration(auth.config, {
    user: session.user,
    response: await soft.register(
      options.value.challenge,
      new TextEncoder().encode(session.user.id),
    ),
  });
  if (!registered.ok) throw new Error(registered.code);
  const setup = await setupTotp(auth.config, { userId: session.user.id, password: PASSWORD });
  if (!setup.ok) throw new Error(setup.code);
  recordCredential(setup.value.secret);
  for (const c of setup.value.backupCodes) recordCredential(c);
  const secret = base32Decode(setup.value.secret);
  const on = await enableTotp(auth.config, { session, code: await codeNow(auth, secret) });
  if (!on.ok) throw new Error(on.code);
  auth.clock.advance(30_000);
  const assertion = await passkeyAuthenticationOptions(auth.config, { ip: null });
  if (!assertion.ok) throw new Error(assertion.code);
  const passkeyOn = await enablePasskeyMethod(auth.config, {
    session,
    password: PASSWORD,
    response: await soft.authenticate(assertion.value.challenge),
  });
  if (!passkeyOn.ok) throw new Error(passkeyOn.code);
  const emailOn = await enableEmailMethod(auth.config, { session, password: PASSWORD });
  if (!emailOn.ok) throw new Error(emailOn.code);
  expect(emailOn.value.methods.sort()).toEqual(["email", "passkey", "totp"]);
  return { session, secret, soft, user: session.user };
}

/** The main world with the factor user. */
async function world(extra: Partial<AuthConfig> = {}) {
  const sms = createRecordingSms();
  const state = { msNonce: "", now: () => 0 };
  const f = providerFetch(state);
  const vias = viaRecorder();
  const auth = makeAuth({ ...gateConfig(f.fetchFn, sms), hooks: vias.hooks, ...extra });
  state.now = () => Math.floor(auth.clock.now().getTime() / 1000);
  const handle = settled(createRouter(auth.config, coreRoutes(auth.config)));
  const user = await factorUser(auth, sms);
  return { ...auth, ...user, handle, sms, state, vias: vias.byId };
}
type World = Awaited<ReturnType<typeof world>>;

/**
 * The `via` of each session that opened, by session id, as the session
 * hook `afterCreate` gets it. The session row holds no via: the hook event
 * is where core states it.
 */
function viaRecorder() {
  const byId = new Map<string, SessionVia>();
  const hooks: AuthConfig["hooks"] = {
    session: {
      afterCreate: (e) => {
        byId.set(e.session.id, e.via);
      },
    },
  };
  return { hooks, byId };
}

/** The outcome of a JSON sign-in answer: a challenge with its methods, or a session with its `via`. */
async function outcomeOf(w: Pick<World, "vias">, res: Response): Promise<Outcome> {
  const body = (await res.json()) as {
    twoFactor?: { methods: ChallengeMethod[] };
    session?: { id: string };
    error?: string;
  };
  if (body.twoFactor) return { kind: "challenge", methods: body.twoFactor.methods };
  if (!body.session) throw new Error(`no session and no challenge: ${res.status} ${body.error}`);
  return sessionOutcome(w, body.session.id);
}

/** The `via` of a session that the hook saw open. */
function sessionOutcome(w: Pick<World, "vias">, sessionId: string): Outcome {
  const via = w.vias.get(sessionId);
  if (via === undefined) throw new Error("no session hook ran for the session");
  return { kind: "session", via };
}

/**
 * The outcome of a browser callback: the methods of the challenge of the
 * redirect, as the challenge page reads them, or the session of the
 * session cookie that the callback set.
 */
async function redirectOutcome(
  w: Pick<World, "config" | "vias">,
  location: string | null,
  sessionToken: string | null | undefined,
): Promise<Outcome> {
  const challenge = new URL(location ?? "", BASE_URL).searchParams.get("challenge");
  if (challenge) {
    const view = await challengeView(w.config, { challenge, trustToken: undefined });
    if (!view.ok) throw new Error(view.code);
    return { kind: "challenge", methods: view.value.methods };
  }
  const opened = sessionToken ? await resolveSession(w.config, sessionToken) : null;
  if (!opened) throw new Error(`no challenge and no session: ${location}`);
  return sessionOutcome(w, opened.session.id);
}

/** The outcome of an engine social callback. */
async function socialOutcome(
  w: Pick<World, "config" | "vias">,
  done: Awaited<ReturnType<typeof completeSocial>>,
): Promise<Outcome> {
  if (!done.ok) throw new Error(`the callback failed: ${done.code}`);
  if ("twoFactor" in done.value)
    return { kind: "challenge", methods: done.value.twoFactor.methods };
  if (!("token" in done.value)) throw new Error("the callback linked and opened nothing");
  const opened = await resolveSession(w.config, recordCredential(done.value.token));
  if (!opened) throw new Error("the callback session is not live");
  return sessionOutcome(w, opened.session.id);
}

/** A code of the last SMS to a number: the default text starts with it. */
const smsCode = (w: World) =>
  recordCredential(/^(\d+) /.exec(w.sms.sent.at(-1)?.text ?? "")?.[1] ?? "");
/** The 6-digit code of the last mail. */
const mailCode = (w: World) =>
  recordCredential(/\b(\d{6})\b/.exec(w.mail.at(-1)?.text ?? "")?.[1] ?? "");
/** The token of the last mailed link. */
const mailToken = (w: World) => {
  const m = /token=([A-Za-z0-9_%-]+)/.exec(w.mail.at(-1)?.text ?? "");
  return recordCredential(decodeURIComponent(m?.[1] ?? ""));
};

/** A session of the factor user that passed its challenge: the token a bag or a handoff holds. */
async function passedChallenge(w: World, b: Browser): Promise<string> {
  const signIn = await b.post("/password/sign-in", { email: EMAIL, password: PASSWORD });
  const { twoFactor } = (await signIn.json()) as { twoFactor: { challenge: string } };
  const res = await b.post("/totp/verify", {
    challenge: twoFactor.challenge,
    code: await codeNow(w, w.secret),
  });
  expect(res.status).toBe(200);
  w.clock.advance(30_000);
  const { token } = (await res.json()) as { token: string };
  return recordCredential(token);
}

/** Links a provider to the factor user through the link flow, then signs in through it. */
async function linkThenSignIn(w: World, provider: string): Promise<Outcome> {
  const fresh = await resolveSession(w.config, w.session.token);
  if (!fresh) throw new Error("the session of the factor user ended");
  const link = await startLink(w.config, { session: fresh, provider, ip: "203.0.113.7" });
  if (!link.ok) throw new Error(`${provider} link start: ${link.code}`);
  const linkUrl = new URL(link.value.location);
  w.state.msNonce = linkUrl.searchParams.get("nonce") ?? "";
  const linked = await completeSocial(w.config, {
    provider,
    state: linkUrl.searchParams.get("state"),
    code: "code-link",
    error: null,
    bindToken: link.value.bindToken,
    // The browser of the link start sends its session cookie with the callback.
    sessionToken: w.session.token,
    ip: "203.0.113.7",
    userAgent: "ua",
  });
  if (!linked.ok) throw new Error(`${provider} link: ${linked.code}`);
  const s = await startSocial(w.config, { provider, next: "/home", ip: "203.0.113.8" });
  if (!s.ok) throw new Error(`${provider} start: ${s.code}`);
  const url = new URL(s.value.location);
  w.state.msNonce = url.searchParams.get("nonce") ?? "";
  return socialOutcome(
    w,
    await completeSocial(w.config, {
      provider,
      state: url.searchParams.get("state"),
      code: "code-sign-in",
      error: null,
      bindToken: s.value.bindToken,
      ip: "203.0.113.8",
      userAgent: "ua",
    }),
  );
}

// ---------------------------------------------------------------------------
// The rows.
// ---------------------------------------------------------------------------

const ROWS: GateRow[] = [
  {
    pathway: "password sign-in by address",
    via: "password",
    gate: "always",
    expect: { kind: "challenge", methods: PASSWORD_METHODS },
    async run(extra) {
      const w = await world(extra);
      return outcomeOf(
        w,
        await browser(w.handle).post("/password/sign-in", { email: EMAIL, password: PASSWORD }),
      );
    },
  },
  {
    pathway: "password sign-in by username",
    via: "password",
    gate: "always",
    expect: { kind: "challenge", methods: PASSWORD_METHODS },
    async run(extra) {
      const w = await world(extra);
      return outcomeOf(
        w,
        await browser(w.handle).post("/password/sign-in", { username: "ada", password: PASSWORD }),
      );
    },
  },
  {
    pathway: "password sign-in by phone",
    via: "password",
    gate: "always",
    expect: { kind: "challenge", methods: PASSWORD_METHODS },
    async run(extra) {
      const w = await world(extra);
      return outcomeOf(
        w,
        await browser(w.handle).post("/password/sign-in", { phone: PHONE, password: PASSWORD }),
      );
    },
  },
  {
    pathway: "phone code sign-in",
    via: "phone",
    gate: "totp.gate.phone, on by default",
    expect: { kind: "challenge", methods: OTHER_METHODS },
    off: { totp: { gate: { phone: false } } },
    async run(extra) {
      const w = await world(extra);
      const b = browser(w.handle);
      expect((await b.post("/phone/request", { phone: PHONE })).status).toBe(200);
      return outcomeOf(w, await b.post("/phone/verify", { phone: PHONE, code: smsCode(w) }));
    },
  },
  {
    pathway: "ID-token route",
    via: "social",
    gate: "totp.gate.social",
    expect: { kind: "challenge", methods: OTHER_METHODS },
    off: { totp: { gate: { social: false } } },
    async run(extra) {
      const w = await world(extra);
      const b = browser(w.handle);
      const n = (await (await b.post("/social/google/id-token/nonce", {})).json()) as {
        nonce: string;
        providerNonce: string;
      };
      const iat = w.state.now();
      const idToken = await new SignJWT({
        iss: "https://accounts.google.com",
        aud: GOOGLE_CLIENT,
        sub: "g-1",
        email: EMAIL,
        email_verified: true,
        nonce: await sha256Hex(n.nonce),
        iat,
        exp: iat + 600,
      })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .sign(privateKey);
      return outcomeOf(
        w,
        await b.post("/social/google/id-token", {
          idToken: recordCredential(idToken),
          nonce: recordCredential(n.nonce),
        }),
      );
    },
  },
  {
    pathway: "a callback on a redirect override",
    via: "social",
    gate: "totp.gate.social",
    expect: { kind: "challenge", methods: OTHER_METHODS },
    off: { totp: { gate: { social: false } } },
    async run(extra) {
      const w = await world(extra);
      const b = browser(w.handle);
      const start = await b.get("/social/github/start?next=/home");
      const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
      // The override path, not the default callback path, serves the provider's answer.
      const res = await b.get(`/oauth/github?code=gh-code&state=${state}`);
      expect(res.status).toBe(302);
      return redirectOutcome(w, res.headers.get("location"), b.jar.get("__Host-tempo_session"));
    },
  },
  {
    pathway: "each new preset (microsoft, discord, slack, twitter)",
    via: "social",
    gate: "totp.gate.social",
    expect: { kind: "challenge", methods: OTHER_METHODS },
    off: { totp: { gate: { social: false } } },
    async run(extra) {
      // gitlab and facebook give no verified address, so no user with a
      // factor can hold their identity: a link needs a verified address, and
      // a claim deletes an identity of an unverified sign-up.
      const w = await world(extra);
      const outcomes: Outcome[] = [];
      for (const provider of ["microsoft", "discord", "slack", "twitter"])
        outcomes.push(await linkThenSignIn(w, provider));
      const [first, ...rest] = outcomes;
      if (!first) throw new Error("no preset ran");
      for (const o of rest) expect(o).toEqual(first);
      return first;
    },
  },
  {
    pathway: "magic link",
    via: "magic_link",
    gate: "totp.gate.magicLink",
    expect: { kind: "challenge", methods: OTHER_METHODS },
    off: { totp: { gate: { magicLink: false } } },
    async run(extra) {
      const w = await world(extra);
      const b = browser(w.handle);
      expect((await b.post("/magic-link/request", { email: EMAIL })).status).toBe(200);
      return outcomeOf(w, await b.post("/magic-link/verify", { token: mailToken(w) }));
    },
  },
  {
    pathway: "email code sign-in",
    via: "email_otp",
    gate: "totp.gate.emailOtp",
    expect: { kind: "challenge", methods: OTHER_METHODS },
    off: { totp: { gate: { emailOtp: false } } },
    async run(extra) {
      const w = await world(extra);
      const b = browser(w.handle);
      expect((await b.post("/otp/request", { email: EMAIL })).status).toBe(200);
      return outcomeOf(w, await b.post("/otp/verify", { email: EMAIL, code: mailCode(w) }));
    },
  },
  {
    pathway: "SSO connection",
    via: "sso",
    gate: "totp.gate.sso, unless the IdP asserts a listed MFA value",
    expect: { kind: "challenge", methods: OTHER_METHODS },
    off: { totp: { gate: { sso: false } } },
    async run(extra) {
      const ADA = "ada@acme.example";
      const vias = viaRecorder();
      const w = ssoSignInWorld({
        password: { hash: FAST, uniformSignUp: false },
        passkey: RP,
        hooks: vias.hooks,
        ...extra,
      });
      const organizationId = await seedOrganization(w, "acme");
      await verifiedDomain(w, organizationId, "acme.example");
      const connectionId = await oidcConnection(w, organizationId, "acme");
      await factorUser(w, undefined, ADA);
      const r = await ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA, amr: ["pwd"] });
      return redirectOutcome(
        { config: w.config, vias: vias.byId },
        r.res.headers.get("location"),
        r.token,
      );
    },
  },
  {
    pathway: "passkey sign-in",
    via: "passkey",
    gate: "none: a passkey with user verification is two factors",
    expect: { kind: "session", via: "passkey" },
    async run(extra) {
      const w = await world(extra);
      const b = browser(w.handle);
      const options = (await (await b.post("/passkey/authenticate/options", {})).json()) as {
        challenge: string;
      };
      return outcomeOf(
        w,
        await b.post("/passkey/authenticate/verify", {
          response: await w.soft.authenticate(options.challenge),
        }),
      );
    },
  },
  {
    pathway: "passkey-first sign-up",
    via: "passkey",
    gate: "none: a new user has no factor, and a passkey with user verification is two factors",
    expect: { kind: "session", via: "passkey" },
    async run(extra) {
      const w = await world(extra);
      const b = browser(w.handle);
      const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
      const o = (await (await b.post("/passkey/sign-up/options", { name: "Bea" })).json()) as {
        challenge: string;
        user: { id: string };
      };
      const handle = Uint8Array.from(atob(o.user.id.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0),
      );
      return outcomeOf(
        w,
        await b.post("/passkey/sign-up/verify", {
          response: await soft.register(o.challenge, handle),
        }),
      );
    },
  },
  {
    pathway: "anonymous sign-in",
    via: "anonymous",
    gate: "none: ANONYMOUS_REFUSED holds every factor enable route",
    expect: { kind: "session", via: "anonymous" },
    async run(extra) {
      const w = await world(extra);
      return outcomeOf(w, await browser(w.handle).post("/anonymous/sign-in", {}));
    },
  },
  {
    pathway: "upgrade into an existing user",
    via: "magic_link",
    gate: "the target user's gate; the challenge row carries anonymousUserId",
    expect: { kind: "challenge", methods: OTHER_METHODS },
    async run(extra) {
      const w = await world(extra);
      const b = browser(w.handle);
      const anon = (await (await b.post("/anonymous/sign-in", {})).json()) as {
        user: { id: string };
      };
      expect((await b.post("/magic-link/request", { email: EMAIL })).status).toBe(200);
      const outcome = await outcomeOf(
        w,
        await b.post("/magic-link/verify", { token: mailToken(w) }),
      );
      // The link runs at the verify: the challenge row names the anonymous user.
      const rows = await w.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "two-factor" },
      ]);
      expect(rows.map((r) => (r.data as { anonymousUserId?: string }).anonymousUserId)).toContain(
        anon.user.id,
      );
      return outcome;
    },
  },
  {
    pathway: "multi-session switch",
    via: "password",
    gate: "none: each token passed its own gate, and resolves through resolveSession",
    expect: { kind: "session", via: "password" },
    async run(extra) {
      const w = await world(extra);
      const b = browser(w.handle);
      await passedChallenge(w, b);
      const first = (await (await b.get("/session")).json()) as { session: { id: string } };
      // A second user in the same browser makes the first session a bag session.
      expect((await b.post("/magic-link/request", { email: "bea@example.com" })).status).toBe(200);
      const bea = await b.post("/magic-link/verify", { token: mailToken(w) });
      expect(bea.status).toBe(200);
      const res = await b.post("/multi-session/switch", { sessionId: first.session.id });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { session: { id: string }; twoFactor?: unknown };
      expect(body.twoFactor).toBeUndefined();
      expect(body.session.id).toBe(first.session.id);
      return sessionOutcome(w, body.session.id);
    },
  },
  {
    pathway: "handoff redeem",
    via: "handoff",
    gate: "none: the session that made it passed its own gate",
    expect: { kind: "session", via: "handoff" },
    async run(extra) {
      const w = await world(extra);
      const b = browser(w.handle);
      const token = await passedChallenge(w, b);
      const resolved = await resolveSession(w.config, token);
      if (!resolved) throw new Error("no session");
      const verifier = recordCredential("v".repeat(43));
      const h = await startHandoff(w.config, {
        challenge: await sha256Base64Url(verifier),
        redirect: "consumera://auth",
        ip: null,
      });
      if (!h.ok) throw new Error(h.code);
      const c = await continueHandoff(w.config, {
        handoffId: h.value.handoffId,
        userId: resolved.user.id,
        sessionId: resolved.session.id,
      });
      if (!c.ok) throw new Error(c.code);
      const code = recordCredential(new URL(c.value.location).searchParams.get("code") ?? "");
      return outcomeOf(w, await browser(w.handle).post("/handoff/redeem", { code, verifier }));
    },
  },
  {
    pathway: "operator impersonation",
    via: "impersonation",
    // The operator's session passed its own gate, and IMPERSONATION_REFUSED holds every way in.
    gate: "none: the session that made it passed its own gate",
    expect: { kind: "session", via: "impersonation" },
    async run(extra) {
      const vias = viaRecorder();
      const f = await operatorFixture({
        config: {
          ...extra,
          passkey: RP,
          hooks: vias.hooks,
          operator: {
            secrets: [
              {
                name: "support",
                secretHash: await sha256Hex(OPERATOR_SECRETS.support),
                scopes: ["users", "sessions", "audit"],
              },
            ],
            users: true,
            impersonation: {},
          },
        },
      });
      const target = await factorUser(f.auth);
      const handle = settled(createRouter(f.auth.config, coreRoutes(f.auth.config)));
      const res = await handle(
        post(
          "/auth/operator/impersonate",
          { userId: target.user.id, reason: "Ticket 1: the gate table" },
          { cookie: `__Host-tempo_session=${f.operator.token}`, ...ip() },
        ),
      );
      expect(res.status).toBe(200);
      // The start answers the session in its cookie.
      const line = res.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_session="));
      const token = line?.slice("__Host-tempo_session=".length).split(";")[0] ?? "";
      const opened = await resolveSession(f.auth.config, recordCredential(token));
      if (!opened) throw new Error("the impersonation opened no session");
      return sessionOutcome({ vias: vias.byId }, opened.session.id);
    },
  },
];

describe("the gate table (plan 12i Task 15, Review Focus 1)", () => {
  it.each(ROWS.map((r) => [r.pathway, r] as const))(
    "each pathway answers its row of the gate table: %s",
    async (_name, row) => {
      expect(await row.run({})).toEqual(row.expect);
      // The row's gate key decides it: with the key off, the pathway opens a session.
      if (row.off) expect(await row.run(row.off)).toEqual({ kind: "session", via: row.via });
    },
  );

  it("each SessionVia value has a row", () => {
    // SESSION_VIA is the one list of the values (engine/hooks.ts): a new value
    // fails here until the table gets a row that runs it.
    const vias = Object.keys(SESSION_VIA) as SessionVia[];
    const covered = new Set(ROWS.map((r) => r.via));
    expect(vias.filter((v) => !covered.has(v))).toEqual([]);
    // Each sign-in route names a via of a row, and each row's via is a value.
    for (const via of Object.values(SIGN_IN_ROUTES)) expect(covered).toContain(via);
    for (const row of ROWS) expect(vias).toContain(row.via);
    // A row that says "none" opens a session; a gated row answers a challenge.
    for (const row of ROWS)
      expect(row.expect.kind, row.pathway).toBe(
        row.gate.startsWith("none") ? "session" : "challenge",
      );
  });

  it("gives every route of ROUTES one row of each gate, read from the code", () => {
    // The route gates, each from the one source in the code: the auth form
    // of ROUTES, the impersonation list, the anonymous list, the sign-in
    // routes with their via, and the declared refusal codes.
    const table = ROUTES.map((r) => {
      const key = `${r.method} ${r.path}` as RouteKey;
      const codes = new Set<string>([...((r as { codes?: readonly string[] }).codes ?? [])]);
      return {
        key,
        auth: (r as { auth?: readonly string[] }).auth ?? ["none"],
        impersonation: IMPERSONATION_REFUSED.has(key) ? "refused" : "allowed",
        anonymous: ANONYMOUS_REFUSED.has(key) ? "refused" : "allowed",
        signIn: SIGN_IN_ROUTES[key] ?? null,
        fresh: codes.has("session_not_fresh"),
        captcha: codes.has("captcha_required"),
        limited: codes.has("rate_limited"),
        codes,
      };
    });
    expect(table).toHaveLength(ROUTES.length);
    for (const row of table) {
      // A refusal must be declared where the code refuses, and only there.
      expect(row.codes.has("impersonation_session"), row.key).toBe(row.impersonation === "refused");
      // POST /anonymous/delete refuses the other way: a session that is not anonymous.
      if (row.key !== "POST /anonymous/delete")
        expect(row.codes.has("anonymous_refused"), row.key).toBe(row.anonymous === "refused");
      // A sign-in route opens a session of a via that has a row of the gate table.
      if (row.signIn !== null)
        expect(
          ROWS.map((g) => g.via),
          row.key,
        ).toContain(row.signIn);
      // A sign-in route that runs a gate declares nothing it cannot answer:
      // the session routes of an anonymous refusal are never sign-in routes.
      if (row.signIn !== null) expect(row.anonymous, row.key).toBe("allowed");
      // A fresh route reads a session.
      if (row.fresh)
        expect(
          row.auth.some((a) => a.startsWith("session")),
          row.key,
        ).toBe(true);
    }
    // Each captcha flow guards at least one route that declares it.
    expect(table.filter((r) => r.captcha).length).toBeGreaterThanOrEqual(CAPTCHA_FLOWS.length);
    // A route that checks a secret short enough to guess (a password or a
    // code) has an owned limit, so each guess costs a count (ASVS 6.6.3). A
    // link token, a state, or a signed assertion is too long to guess.
    for (const row of table)
      if (row.codes.has("invalid_code") || row.codes.has("invalid_credentials"))
        expect(row.limited, row.key).toBe(true);
  });
});
