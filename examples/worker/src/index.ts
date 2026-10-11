import { createD1Adapter, createD1Limiter } from "@tempo-auth/adapter-d1";
import { type Auth, createAuth, createPbkdf2PasswordHash } from "@tempo-auth/core";
import { createLegacyPasswordHash } from "@tempo-auth/legacy-hashes";
import { compatLastLink, getCompat } from "./compat.js";
import { devRedirectPattern } from "./dev-redirect.js";
import { LEGACY_FORMATS } from "./legacy-formats.js";

let lastLink: string | null = null;
let auth: Auth | null = null;

// Built once per isolate. Bindings in `env` are fixed for the isolate's life,
// so the D1 handle and the limiter can live here.
function getAuth(env: Env): Auth {
  if (auth) return auth;
  auth = createAuth({
    baseURL: env.BASE_URL,
    appName: "tempo-auth example",
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.BASE_URL],
    storage: createD1Adapter(env.DB),
    // The owned limiter keeps its counts in D1, so every isolate shares them.
    limiter: createD1Limiter(env.DB),
    mail: {
      async send(message) {
        // The example has no mail transport. It records the last link for the test.
        const m = /https?:\/\/\S+/.exec(message.text);
        lastLink = m?.[0] ?? null;
      },
    },
    // Google sign-in is on only when both vars are set. The example has no
    // real client; the test sets fake values to prove the start route.
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          social: {
            google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
          },
        }
      : {}),
    // Passkeys bind to the API's own host in this example. A real app sets
    // rpID to its registrable domain and lists every web origin.
    passkey: {
      rpID: new URL(env.BASE_URL).hostname,
      rpName: "tempo-auth example",
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
    // Password sign-in. The default PBKDF2 seam costs 100000 iterations per
    // hash. That needs more CPU than Workers Free allows, so a deployment needs
    // Workers Paid. In TEST_MODE only, use 1000 iterations so the end-to-end
    // test does not pay the full cost for each hash. Production keeps the default.
    // The legacy seam comes first (plan 9b): a user imported from Supabase,
    // Clerk, or Auth0 signs in with the old bcrypt hash once, and the sign-in
    // writes PBKDF2 over it. Every new hash is PBKDF2. The formats are in
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const a = getAuth(env);
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
    if (url.pathname === "/__test/last-link") {
      if (env.TEST_MODE !== "1") return new Response("not found", { status: 404 });
      return Response.json({ link: lastLink });
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
