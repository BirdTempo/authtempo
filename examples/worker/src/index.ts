import { createD1Adapter } from "@tempo-auth/adapter-d1";
import { type Auth, createAuth } from "@tempo-auth/core";

let lastLink: string | null = null;
let auth: Auth | null = null;

// Built once per isolate. Bindings in `env` are fixed for the isolate's life,
// so the D1 handle and the limiter can live here.
function getAuth(env: Env): Auth {
  if (auth) return auth;
  auth = createAuth({
    baseURL: env.BASE_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.BASE_URL],
    storage: createD1Adapter(env.DB),
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
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
