import { createD1Adapter, createD1Limiter } from "@authtempo/adapter-d1";
import { type Auth, createAuth, createPbkdf2PasswordHash } from "@authtempo/core";
import { readBearer, readSessionToken, sessionCookieNames } from "@authtempo/core/credentials";
import { createLegacyPasswordHash } from "@authtempo/legacy-hashes";
import {
  createVerifier,
  insufficientScopeResponse,
  unauthorizedResponse,
  type Verifier,
} from "@authtempo/verify";

/**
 * True when the request held a bearer and no session cookie. Core lets a
 * session cookie win and never reads the bearer then, so a refused cookie
 * request names no invalid_token (RFC 6750 section 3.1). The cookie names come
 * from core.
 */
function refusedBearer(request: Request): boolean {
  if (readBearer(request) === null) return false;
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  return readSessionToken(sessionCookieNames(), { headers }) === null;
}

import { compatLastLink, getCompat } from "./compat.js";
import { conformanceConfig, conformanceOn, seedConformance } from "./conformance.js";
import { devRedirectPattern } from "./dev-redirect.js";
import { exampleHooks } from "./hooks.js";
import { LEGACY_FORMATS } from "./legacy-formats.js";
import { rememberCode } from "./test-capture.js";
import { testProvider, testProviderFetch, testProviderRoute } from "./test-provider.js";

let lastLink: string | null = null;
// Keyed by address, so a test never reads the stale code of another address
// (an isolate serves many tests in turn). Bounded by rememberCode (plan 9h).
const lastCodes = new Map<string, string>();
let auth: Auth | null = null;

// Built once per isolate. Bindings in `env` are fixed for the isolate's life,
// so the D1 handle and the limiter can live here.
function getAuth(env: Env): Auth {
  if (auth) return auth;
  auth = createAuth({
    baseURL: env.BASE_URL,
    appName: "authtempo example",
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.BASE_URL],
    storage: createD1Adapter(env.DB),
    // The owned limiter keeps its counts in D1, so every isolate shares them.
    limiter: createD1Limiter(env.DB),
    mail: {
      async send(message) {
        // The example has no mail transport. It records the last link for the
        // test, or, per address, the code of a mail that carries no link (plan 9e).
        const m = /https?:\/\/\S+/.exec(message.text);
        if (m) lastLink = m[0];
        else
          rememberCode(lastCodes, message.to, /\b(\d{8}|\d{6})\b/.exec(message.text)?.[1] ?? null);
      },
    },
    // Google sign-in is on only when both vars are set. The example has no
    // real client; the test sets fake values to prove the start route.
    // In TEST_MODE only, one oauth2 provider whose endpoints are test routes
    // of this Worker proves the full flow on D1 (plan 9c).
    social: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
        : {}),
      ...(env.TEST_MODE === "1"
        ? { oauth2: [testProvider(env.BASE_URL)], fetch: testProviderFetch(env.BASE_URL) }
        : {}),
    },
    // Passkeys bind to the API's own host in this example. A real app sets
    // rpID to its registrable domain and lists every web origin.
    passkey: {
      rpID: new URL(env.BASE_URL).hostname,
      rpName: "authtempo example",
      origins: [env.BASE_URL],
    },
    // The handoff for a desktop or native app. The example admits one scheme. In development,
    // DEV_REDIRECT_PATTERN admits an Expo Go redirect such as exp://192.168.1.20:8081/--/auth.
    // Leave it unset in a deploy: a dev pattern admits a redirect that no app store binds to this app.
    // An unanchored source is refused with one log line (see dev-redirect.ts).
    handoff: (() => {
      const pattern = devRedirectPattern(env.DEV_REDIRECT_PATTERN);
      return { schemes: ["example-app://"], ...(pattern ? { devRedirectPattern: pattern } : {}) };
    })(),
    // Organizations, members, and mailed invitations. The routes need the 0002 migration.
    organizations: {},
    // Email codes (plan 9e): /auth/otp/request and /auth/otp/verify, and with the password
    // config below the reset by code. They are on by default; `{}` keeps the defaults (6 digits,
    // 10 minutes, 5 guesses), and `emailOtp: false` turns them off.
    emailOtp: {},
    // The OAuth 2.1 and OIDC provider (plan 9g) for one MCP resource on this Worker, and the
    // JWTs it signs (`jwtMint` is on by default). Dynamic registration only: it is off by
    // default since plan 12e, so the config turns it on. A client ID metadata document needs
    // the app's own SSRF-guarded fetch, and the example has none.
    // In TEST_MODE only, a second resource with no route: the end-to-end test proves that its
    // tokens answer 401 at /mcp.
    oauth: {
      resources: [
        `${env.BASE_URL}/mcp`,
        ...(env.TEST_MODE === "1" ? [`${env.BASE_URL}/files`] : []),
      ],
      registration: { cimd: false, dynamic: true },
      scopes: { "mcp:tools": "Use the example tools" },
    },
    // CONFORMANCE_MODE "1" only (plan 12e Task 17): RS256, the device grant, and a default
    // resource for the local OpenID conformance run. wrangler.jsonc keeps "0" for a deploy.
    ...(conformanceOn(env) ? conformanceConfig(env.BASE_URL, (i, init) => fetch(i, init)) : {}),
    // The operator route (plan 11c) for `authtempo keys rotate`: on only when the var
    // OPERATOR_SECRET_HASH is set. The Worker holds the hash, never the secret.
    ...(env.OPERATOR_SECRET_HASH ? { operator: { secretHash: env.OPERATOR_SECRET_HASH } } : {}),
    // TEST_MODE only (plan 9d): the hooks the end-to-end test proves on D1. They write
    // app_tenant, a table of the test setup, so a deploy without the table sets none.
    ...(env.TEST_MODE === "1" ? { hooks: exampleHooks(env.DB) } : {}),
    // Password sign-in. The default PBKDF2 seam costs 100000 iterations per
    // hash. That needs more CPU than Workers Free allows, so a deployment needs
    // Workers Paid. In TEST_MODE only, use 1000 iterations so the end-to-end
    // test does not pay the full cost for each hash. Production keeps the default.
    // The legacy seam comes first (plan 9b): a user imported from Supabase,
    // Clerk, or Auth0 signs in with the old bcrypt hash once, or until a
    // sign-in with a password of at most 72 bytes, and that sign-in writes
    // PBKDF2 over it. A longer password stays bcrypt (BCRYPT_MAX_PASSWORD_BYTES). Every new hash is PBKDF2. The formats are in
    // legacy-formats.ts, which the import test reads too.
    password: {
      hash: createLegacyPasswordHash({
        formats: LEGACY_FORMATS,
        next:
          env.TEST_MODE === "1"
            ? createPbkdf2PasswordHash({ iterations: 1000 })
            : createPbkdf2PasswordHash(),
      }),
    },
  });
  return auth;
}

let seeded: Promise<void> | null = null;

// CONFORMANCE_MODE "1" only: the test user and the two clients, once per isolate.
function seedOnce(env: Env, a: Auth): Promise<void> {
  if (!env.CONFORMANCE_PASSWORD)
    throw new Error("conformance mode needs the var CONFORMANCE_PASSWORD");
  const password = env.CONFORMANCE_PASSWORD;
  seeded ??= seedConformance(a, password, () => lastLink);
  return seeded;
}

let verifier: Verifier | null = null;

// The verifier of a server that is not the auth app (plan 11d). This Worker is the
// auth app too, so the verifier reads the key set and the live check through its handler.
function getVerifier(env: Env): Verifier {
  verifier ??= createVerifier({
    issuer: `${env.BASE_URL}/auth`,
    audience: env.BASE_URL,
    checkSessionEnd: true,
    fetch: (input, init) => getAuth(env).handle(new Request(input, init)),
  });
  return verifier;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const a = getAuth(env);
    if (conformanceOn(env)) await seedOnce(env, a);
    // RFC 8414 and RFC 9728 put the metadata at the origin root (plan 9g).
    if (url.pathname.startsWith("/.well-known/")) return a.wellKnown(request);
    if (url.pathname.startsWith("/auth/")) return a.handle(request);
    if (url.pathname === "/me") {
      const s = await a.session(request);
      if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
      const res = Response.json({ id: s.user.id, email: s.user.email });
      // After a sliding refresh, renew the cookie or the browser drops it early.
      const renewed = a.sessionCookie(request, s);
      if (renewed) res.headers.set("set-cookie", renewed);
      return res;
    }
    // A route that a script may call with an API token (plan 8b). `caller`
    // resolves the session cookie, a `ts_` bearer, or a `tk_` bearer. `/me`
    // above calls `session`, so it stays session-only and answers 401 to a token.
    if (url.pathname === "/whoami") {
      const c = await a.caller(request);
      // A client_credentials token acts for no user, so this route has no one to name (plan 12e).
      if (!c || c.kind === "oauth-client")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      const res = Response.json({ kind: c.kind, id: c.user.id, email: c.user.email });
      // After a sliding refresh, renew the cookie or the browser drops it early.
      const renewed = c.kind === "session" ? a.sessionCookie(request, c) : null;
      if (renewed) res.headers.set("set-cookie", renewed);
      return res;
    }
    // A session JWT route (plan 11d): what another Worker of the app would serve.
    if (url.pathname === "/notes") {
      const v = getVerifier(env);
      const r = await v.verifyRequest(request);
      // The auth app limited the live checks: 429. It did not answer: 503.
      if (!r.ok)
        return Response.json({ error: r.code }, { status: r.code === "rate_limited" ? 429 : 503 });
      // A refused bearer gets error="invalid_token" (RFC 6750 section 3.1). No bearer, and a
      // Basic header is none, gets the plain challenge. The verifier reads the bearer only,
      // never a cookie, so this route needs no cookie rule (that is /mcp's, through caller).
      if (r.value?.kind !== "session-jwt")
        return v.unauthorized({ invalidToken: readBearer(request) !== null });
      return Response.json({ owner: r.value.email });
    }
    // An MCP resource (plan 9g): an OAuth access token for this resource only. A session
    // or an API token is refused here, and a token for another resource is null at `caller`.
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const resource = `${env.BASE_URL}/mcp`;
      const c = await a.caller(request);
      // MCP 2026-07-28: the 401 names the scope of the tools, so a client asks for it.
      if (c?.kind !== "oauth")
        return unauthorizedResponse({
          resource,
          scope: "mcp:tools",
          invalidToken: refusedBearer(request),
        });
      // The tools need the scope mcp:tools. Without this check a token with only
      // openid calls them, and every app that copies this example inherits that.
      if (!c.scopes.includes("mcp:tools"))
        return insufficientScopeResponse({ resource, scope: "mcp:tools" });
      // c.user is for the app; c.subject is what the client may see.
      return Response.json({ sub: c.subject, clientId: c.clientId, scopes: c.scopes });
    }
    // TEST_MODE only (plan 9c): the fake provider's authorize step, which the browser visits.
    if (url.pathname.startsWith("/__test/oauth/")) {
      if (env.TEST_MODE !== "1") return new Response("not found", { status: 404 });
      return testProviderRoute(request, url);
    }
    if (url.pathname === "/__test/last-link") {
      if (env.TEST_MODE !== "1") return new Response("not found", { status: 404 });
      return Response.json({ link: lastLink });
    }
    // TEST_MODE only (plan 9e): the last code mailed to `?email=`. A deploy must never
    // serve it: anyone could read a live sign-in code. The gate answers 404 without TEST_MODE.
    if (url.pathname === "/__test/last-code") {
      if (env.TEST_MODE !== "1") return new Response("not found", { status: 404 });
      return Response.json({ code: lastCodes.get(url.searchParams.get("email") ?? "") ?? null });
    }
    // The Better Auth compatibility instance (plan 9) on BA_DB. Core's routes above do not change.
    if (url.pathname.startsWith("/api/auth/")) return getCompat(env).handler(request);
    if (url.pathname === "/compat/me") {
      const s = await getCompat(env).api.getSession({ headers: request.headers });
      if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({
        id: s.user.id,
        email: s.user.email,
        name: s.user.name,
        activeOrganizationId: s.session.activeOrganizationId,
      });
    }
    if (url.pathname === "/__test/compat-last-link") {
      if (env.TEST_MODE !== "1") return new Response("not found", { status: 404 });
      return Response.json({ link: compatLastLink(url.searchParams.get("to") ?? "") });
    }
    return new Response("not found", { status: 404 });
  },
  // The cron trigger in wrangler.jsonc calls this. It deletes expired tokens, invitations, and sessions.
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const counts = await getAuth(env).api.sweepExpired();
    console.log("sweepExpired", JSON.stringify(counts));
  },
} satisfies ExportedHandler<Env>;
