import { type Auth, createAuth, createMemoryAdapter, type MailPort } from "@authtempo/core";
import { type AuthEnv, authHandler, authSession, getSession } from "@authtempo/hono";
import { Hono } from "hono";

/** The values of the environment: Workers bindings, or process.env on Node and Bun. */
export interface AppEnv {
  BASE_URL: string;
  AUTH_SECRET: string;
  mail: MailPort;
}

/**
 * The Hono app. Warning: the memory adapter keeps rows in this process only.
 * Use the D1 or the Postgres adapter in production.
 */
export function createApp(env: AppEnv): Hono<AuthEnv> {
  const auth: Auth = createAuth({
    baseURL: env.BASE_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.BASE_URL],
    storage: createMemoryAdapter(),
    mail: env.mail,
  });
  const app = new Hono<AuthEnv>();
  // The session of every page, and /account for a signed-in person only.
  app.use(
    "*",
    authSession({ auth, protect: (p) => p.startsWith("/account"), signInPath: "/sign-in" }),
  );
  // Every route of core under /auth, the default basePath.
  app.on(["GET", "POST", "OPTIONS"], "/auth/*", authHandler(auth));
  app.get("/account", (c) => c.json({ email: getSession(c)?.user.email ?? null }));
  return app;
}
