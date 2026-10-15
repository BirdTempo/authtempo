import { createAuth, createMemoryAdapter, type MailPort } from "@authtempo/core";
import { readGate } from "@authtempo/core/bindings";
import { createVerifier } from "@authtempo/verify";
import { Elysia } from "elysia";

export interface AppEnv {
  BASE_URL: string;
  AUTH_SECRET: string;
  mail: MailPort;
  /** Called with each text that the rule tests, and at each page run. The test counts them. */
  trace?: ((event: "rule" | "page", text: string) => void) | undefined;
}

/**
 * The request on the app's own origin: the Host header, else the origin of
 * BASE_URL. The app builds it, so the origin never comes from a request line
 * in absolute form, whatever the runtime does. Bun gives the path only for a
 * Host that does not parse ("a b"): that request also gets the BASE_URL origin.
 */
export function withOrigin(request: Request, baseURL: string): Request {
  const fallback = new URL(baseURL);
  const parsed = URL.canParse(request.url) ? new URL(request.url) : null;
  const protocol = parsed?.protocol ?? fallback.protocol;
  let origin = fallback.origin;
  const host = request.headers.get("host");
  if (host && URL.canParse(`${protocol}//${host}`)) origin = new URL(`${protocol}//${host}`).origin;
  const path = parsed ? `${parsed.pathname}${parsed.search}` : request.url;
  // Join as text: a path that starts with "//" is a path here, not a host.
  const url = new URL(`${origin}${path}`);
  // The common case: the URL is already on that origin, and the request passes unchanged.
  if (parsed?.href === url.href) return request;
  const init = { method: request.method, headers: request.headers, body: request.body };
  return new Request(url, { ...init, duplex: "half" } as RequestInit);
}

/**
 * The texts that the rule tests. Elysia's router matches the raw path: no
 * decode ("/%61ccount" is not "/account"), and with case ("/ACCOUNT" is not
 * "/account"). It runs "/account" for "/account/" (strictPath is off by
 * default), so the rule also tests the path with its trailing slashes cut.
 */
function forms(path: string): string[] {
  return [path, path.replace(/\/+$/, "") || "/"];
}

/**
 * The Elysia app. Warning: the memory adapter keeps rows in this process only.
 * Use the D1 or the Postgres adapter in production.
 */
export function createApp(env: AppEnv) {
  const auth = createAuth({
    baseURL: env.BASE_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.BASE_URL],
    storage: createMemoryAdapter(),
    mail: env.mail,
  });
  // An exact rule covers one route only. For a route with a parameter, use
  // p === "/account" || p.startsWith("/account/").
  const gateOptions = {
    auth,
    protect: (p: string) =>
      forms(p).some((form) => {
        env.trace?.("rule", form);
        return form === "/account";
      }),
    signInPath: "/sign-in",
  };
  // /files takes a ts_ bearer or an API token in the Authorization header, never the
  // cookie: one call to the auth app each. Here the auth app is this process;
  // another server passes no fetch.
  const verifier = createVerifier({
    issuer: `${env.BASE_URL}/auth`,
    accept: ["session-token", "api-token"],
    fetch: (input, init) => auth.handle(new Request(input, init)),
  });
  return (
    new Elysia()
      // The gate of each matched route, with the path as the router matched it.
      // It reads no session for a route of core, and names no body, so Elysia
      // parses none: core reads the body as it came.
      .resolve(async ({ request, path, set }) => {
        const gate = await readGate(gateOptions, withOrigin(request, env.BASE_URL), path);
        // After a sliding refresh, renew the cookie, or the browser drops it early.
        if (gate.cookie) set.headers["set-cookie"] = gate.cookie;
        return { gate };
      })
      // A person with no session on /account goes to the sign-in page. No page code runs.
      .onBeforeHandle(({ gate }) => gate.redirect ?? undefined)
      // Every route of core under /auth, the default basePath. Each Set-Cookie line passes unchanged.
      .all("/auth/*", ({ request }) => auth.handle(withOrigin(request, env.BASE_URL)))
      .get("/account", ({ gate, path, status }) => {
        env.trace?.("page", path);
        if (!gate.session) return status(401, { error: "unauthorized" });
        return { email: gate.session.user.email };
      })
      .get("/files", async ({ request, path }) => {
        env.trace?.("page", path);
        const r = await verifier.verifyRequest(withOrigin(request, env.BASE_URL));
        // The auth app did not answer: try again later, not "sign in again".
        if (!r.ok) return Response.json({ error: r.code }, { status: 503 });
        if (r.value === null) return verifier.unauthorized();
        const owner =
          r.value.kind === "session-token" || r.value.kind === "api-token"
            ? r.value.user.email
            : null;
        return Response.json({ owner });
      })
  );
}
