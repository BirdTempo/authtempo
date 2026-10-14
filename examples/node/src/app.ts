import { createPostgresAdapter, createPostgresLimiter } from "@authtempo/adapter-postgres";
import { type Auth, createAuth, type MailPort } from "@authtempo/core";
import { createVerifier } from "@authtempo/verify";
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
  // A route that a server which is not the auth app would serve (plan 11d). Here the
  // auth app is this process, so the verifier reads the key set and the live check
  // through the handler; another server passes no fetch and reads them over HTTP.
  const verifier = createVerifier({
    issuer: `${options.baseURL}/auth`,
    audience: options.baseURL,
    // A sign-out ends access at once: one live check per request.
    checkSessionEnd: true,
    // Bun's type of fetch adds `preconnect`, which a handler has no use for: hence the cast.
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      auth.handle(new Request(input, init))) as typeof fetch,
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
      if (url.pathname === "/files") {
        const r = await verifier.verifyRequest(request);
        // The auth app did not answer: try again later, not "sign in again".
        if (!r.ok) return Response.json({ error: r.code }, { status: 503 });
        if (r.value?.kind !== "session-jwt") return verifier.unauthorized();
        return Response.json({ owner: r.value.email });
      }
      return new Response("not found", { status: 404 });
    },
  };
}
