import { type Auth, createAuth, createMemoryAdapter, type MailPort } from "@authtempo/core";
import { authRoutes, authSession, getSession } from "@authtempo/fastify";
import Fastify, { type FastifyInstance } from "fastify";

export interface AppEnv {
  /** The public origin of the app, read at the first request. */
  baseURL: () => string;
  AUTH_SECRET: string;
  mail: MailPort;
}

/**
 * The Fastify app. Warning: the memory adapter keeps rows in this process
 * only. Use the Postgres adapter in production.
 */
export async function createApp(env: AppEnv): Promise<FastifyInstance> {
  let auth: Auth | null = null;
  const getAuth = (): Auth => {
    auth ??= createAuth({
      baseURL: env.baseURL(),
      secret: env.AUTH_SECRET,
      trustedOrigins: [env.baseURL()],
      storage: createMemoryAdapter(),
      mail: env.mail,
    });
    return auth;
  };
  const app = Fastify();
  // Declare the field once, as Fastify asks, so every request has the same shape.
  app.decorateRequest("authSession", null);
  // The session of every page, and /account for a signed-in person only.
  // The rule gets the path that the router matches: the router is case-sensitive.
  app.addHook(
    "onRequest",
    authSession({
      auth: getAuth,
      protect: (p) => p.startsWith("/account"),
      signInPath: "/sign-in",
    }),
  );
  // Every route of core under /auth, the default basePath.
  await app.register(authRoutes({ auth: getAuth }));
  app.get("/account", async (request) => ({ email: getSession(request)?.user.email ?? null }));
  return app;
}
