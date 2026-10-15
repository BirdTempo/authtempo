import { type Auth, createAuth, createMemoryAdapter, type MailPort } from "@authtempo/core";
import { authHandler, authSession, getSession } from "@authtempo/express";
import express, { type Express } from "express";

export interface AppEnv {
  /** The public origin of the app, read at the first request. */
  baseURL: () => string;
  AUTH_SECRET: string;
  mail: MailPort;
}

/**
 * The Express app. Warning: the memory adapter keeps rows in this process
 * only. Use the Postgres adapter in production.
 */
export function createApp(env: AppEnv): Express {
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
  const app = express();
  // Express routes without case by default, so "/ACCOUNT" would run the /account
  // page. The protect rule is exact, so the router must compare case too.
  app.set("case sensitive routing", true);
  // A body parser may run first: the binding writes the parsed body again for core.
  app.use(express.json());
  // Every route of core under /auth, the default basePath.
  app.use("/auth", authHandler(getAuth));
  // The session of every page, and /account for a signed-in person only.
  app.use(
    authSession({
      auth: getAuth,
      protect: (p) => p.startsWith("/account"),
      signInPath: "/sign-in",
    }),
  );
  app.get("/account", (_req, res) => {
    res.json({ email: getSession(res)?.user.email ?? null });
  });
  return app;
}
