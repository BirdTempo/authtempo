import { type Auth, createAuth, createMemoryAdapter } from "@tempo-auth/core";

// One adapter per isolate. Rows vanish when the isolate does. Plan 2 replaces
// this with the D1 adapter and a binding.
const storage = createMemoryAdapter();
let lastLink: string | null = null;
let auth: Auth | null = null;

function getAuth(env: Env): Auth {
  if (auth) return auth;
  auth = createAuth({
    baseURL: env.BASE_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.BASE_URL],
    storage,
    mail: {
      async send(message) {
        // The example has no mail transport. It records the last link for the test.
        const m = /https?:\/\/\S+/.exec(message.text);
        lastLink = m?.[0] ?? null;
      },
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
      return Response.json({ id: s.user.id, email: s.user.email });
    }
    if (url.pathname === "/__test/last-link") {
      if (env.TEST_MODE !== "1") return new Response("not found", { status: 404 });
      return Response.json({ link: lastLink });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
