import { createD1Adapter, createD1Limiter } from "@authtempo/adapter-d1";
import {
  type Auth,
  type AuthConfig,
  createAuth,
  type HooksConfig,
  type MailPort,
} from "@authtempo/core";
import { workersLogsSink } from "@authtempo/observe/workers-logs";

/** The bindings and vars of wrangler.jsonc, and the secret of `wrangler secret put AUTH_SECRET`. */
export interface Env {
  DB: D1Database;
  BASE_URL: string;
  AUTH_SECRET: string;
}

/**
 * Your mail transport. Core calls `send` once per mail: a magic link, an
 * email code, a reset link. Replace the body with a call to your mail
 * provider. Until then a sign-in request answers 500, so a deploy with no
 * mail fails at once and not in silence.
 */
export const mail: MailPort = {
  async send() {
    throw new Error("my-app: no mail transport; replace mail.send in src/index.ts");
  },
};

/**
 * The Worker. The test passes a mail port that keeps the mails, and hooks of its own.
 * `more` adds config keys for one env, after the keys below. The measure entry
 * (src/measure.ts) adds the password config and its own sink with it.
 */
export function createWorker(
  mailPort: MailPort,
  hooks?: HooksConfig,
  more?: (env: Env) => Partial<AuthConfig>,
) {
  // One auth instance per isolate. The bindings stay the same for the life of the isolate.
  let auth: Auth | null = null;
  const getAuth = (env: Env): Auth =>
    (auth ??= createAuth({
      baseURL: env.BASE_URL,
      secret: env.AUTH_SECRET,
      trustedOrigins: [env.BASE_URL],
      storage: createD1Adapter(env.DB),
      // The owned limiter counts in D1, so every isolate shares one count.
      // The default limiter counts per isolate, and is for tests only.
      limiter: createD1Limiter(env.DB),
      mail: mailPort,
      ...(hooks ? { hooks } : {}),
      // Each event of core goes to Workers Logs as one JSON object. wrangler.jsonc
      // turns the logs on. With a sink, core writes no console line of its own.
      // The sink scrubs the secret of the config from each field, as the last guard.
      observe: { sink: workersLogsSink({ secrets: [env.AUTH_SECRET] }) },
      ...(more ? more(env) : {}),
    }));

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const a = getAuth(env);
      const viaHandle = url.pathname.startsWith("/auth/");
      try {
        // The events flush after the answer. Bound on purpose: an unbound
        // ctx.waitUntil throws Illegal invocation (Cloudflare Workers best
        // practices, read 2026-10-14).
        if (viaHandle) return await a.handle(request, { waitUntil: (p) => ctx.waitUntil(p) });
        if (url.pathname === "/me") {
          const s = await a.session(request);
          if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
          const res = Response.json({ email: s.user.email });
          // A sliding refresh moved the expiry: renew the cookie, or the browser drops it early.
          const renewed = a.sessionCookie(request, s);
          if (renewed) res.headers.append("set-cookie", renewed);
          return res;
        }
        return new Response("not found", { status: 404 });
      } finally {
        // handle flushes its own events. A call outside it, such as the session
        // read of /me, flushes here, or its events wait for the next handle call.
        if (!viaHandle) ctx.waitUntil(a.observe.flush());
      }
    },
    // The cron trigger of wrangler.jsonc runs this. It deletes the rows that no flow can use.
    async scheduled(
      _controller: ScheduledController,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<void> {
      ctx.waitUntil(getAuth(env).api.sweepExpired());
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorker(mail);
