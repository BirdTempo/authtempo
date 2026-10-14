import { createPostgresAdapter, createPostgresLimiter } from "@authtempo/adapter-postgres";
import { type Auth, createAuth, type MailPort } from "@authtempo/core";
import type { Sql } from "postgres";

export interface AppOptions {
  /** The origin where the server answers, such as https://api.example.com. */
  baseURL: string;
  /** At least 32 characters. Keep it in a secret store, never in the code. */
  secret: string;
  sql: Sql;
  mail: MailPort;
}

/**
 * The header that the server sets from the socket address. The server drops
 * a copy that the caller sent, so a caller cannot choose its own IP for the
 * per-IP limits.
 */
export const CLIENT_IP_HEADER = "x-tempo-client-ip";

/**
 * Your mail transport. Core calls `send` once per mail. Replace the body with
 * a call to your mail provider. Until then a sign-in request answers 500.
 */
export const mail: MailPort = {
  async send() {
    throw new Error("my-app: no mail transport; replace mail.send in src/app.ts");
  },
};

/** A server of each runtime: Node's http module, or Bun.serve. */
export type Serve = (
  handler: (request: Request) => Promise<Response>,
  options: { port: number; hostname: string; origin: string },
) => Promise<{ close(): Promise<void> }>;

export function createApp(options: AppOptions): {
  auth: Auth;
  fetch(request: Request): Promise<Response>;
} {
  const auth = createAuth({
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: [options.baseURL],
    storage: createPostgresAdapter(options.sql),
    // The owned limiter counts in Postgres, so every process shares one count.
    limiter: createPostgresLimiter(options.sql),
    mail: options.mail,
    // The default reads cf-connecting-ip, which only Cloudflare sets. Off
    // Workers any caller can send it, so read the header the server sets.
    clientIp: (request) => request.headers.get(CLIENT_IP_HEADER),
  });
  return {
    auth,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/auth/")) return auth.handle(request);
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
    },
  };
}
