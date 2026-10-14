import { createD1Adapter, createD1Limiter } from "@authtempo/adapter-d1";
import { type Auth, createAuth, type MailPort } from "@authtempo/core";

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

/** The Worker. The test passes a mail port that keeps the mails. */
export function createWorker(mailPort: MailPort) {
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
    }));

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const a = getAuth(env);
      if (url.pathname.startsWith("/auth/")) return a.handle(request);
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
