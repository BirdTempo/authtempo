import { createPostgresAdapter, createPostgresLimiter } from "@authtempo/adapter-postgres";
import { createAuth, type MailPort } from "@authtempo/core";
import postgres from "postgres";

/** The bindings and vars of wrangler.jsonc, and the secret of `wrangler secret put AUTH_SECRET`. */
export interface Env {
  HYPERDRIVE: Hyperdrive;
  BASE_URL: string;
  AUTH_SECRET: string;
}

/**
 * Your mail transport. Core calls `send` once per mail. Replace the body with
 * a call to your mail provider. Until then a sign-in request answers 500.
 */
export const mail: MailPort = {
  async send() {
    throw new Error("my-app: no mail transport; replace mail.send in src/index.ts");
  },
};

/** The Worker. The test passes a mail port that keeps the mails. */
export function createWorker(mailPort: MailPort) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      // One client per request, as the adapter README asks on Workers: one
      // connection, no prepared statements, and no type fetch through Hyperdrive.
      // Warning: with max 1, a before hook must not query this client. See the
      // one-connection rule in the docs.
      const sql = postgres(env.HYPERDRIVE.connectionString, {
        max: 1,
        prepare: false,
        fetch_types: false,
      });
      try {
        const auth = createAuth({
          baseURL: env.BASE_URL,
          secret: env.AUTH_SECRET,
          trustedOrigins: [env.BASE_URL],
          storage: createPostgresAdapter(sql),
          // The owned limiter counts in Postgres, so every isolate shares one count.
          limiter: createPostgresLimiter(sql),
          mail: mailPort,
        });
        const url = new URL(request.url);
        if (url.pathname.startsWith("/auth/")) return await auth.handle(request);
        if (url.pathname === "/me") {
          const s = await auth.session(request);
          if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
          const res = Response.json({ email: s.user.email });
          // A sliding refresh moved the expiry: renew the cookie, or the browser drops it early.
          const renewed = auth.sessionCookie(request, s);
          if (renewed) res.headers.append("set-cookie", renewed);
          return res;
        }
        return new Response("not found", { status: 404 });
      } finally {
        ctx.waitUntil(sql.end({ timeout: 5 }));
      }
    },
    // The cron trigger of wrangler.jsonc runs this. It deletes the rows that no flow can use.
    async scheduled(
      _controller: ScheduledController,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<void> {
      const sql = postgres(env.HYPERDRIVE.connectionString, {
        max: 1,
        prepare: false,
        fetch_types: false,
      });
      const auth = createAuth({
        baseURL: env.BASE_URL,
        secret: env.AUTH_SECRET,
        trustedOrigins: [env.BASE_URL],
        storage: createPostgresAdapter(sql),
        limiter: createPostgresLimiter(sql),
        mail: mailPort,
      });
      ctx.waitUntil(auth.api.sweepExpired().finally(() => sql.end({ timeout: 5 })));
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorker(mail);
