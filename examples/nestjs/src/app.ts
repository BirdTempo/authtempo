import "reflect-metadata";
import { type Auth, createAuth, createMemoryAdapter, type MailPort } from "@authtempo/core";
import { authHandler, authSession, getSession, toWebRequest } from "@authtempo/express";
import { createVerifier, type Verifier } from "@authtempo/verify";
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  type INestApplication,
  Module,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import express, { type Request as ExpressRequest, type Response as ExpressResponse } from "express";

export interface AppEnv {
  /** The public origin of the app, read at the first request. */
  baseURL: () => string;
  AUTH_SECRET: string;
  mail: MailPort;
  /** Called with each text that the rule tests, and at each page run. The test counts them. */
  trace?: ((event: "rule" | "page", text: string) => void) | undefined;
  /** True for a path that needs a session. Default: the exact path "/account". */
  protect?: ((path: string) => boolean) | undefined;
}

// A user can have no address (authtempo plan 12i), so the caller's email can be null.
type WithCaller = ExpressRequest & { caller?: { email: string | null } };

/** A guard that knows the caller from a ts_ bearer or an API token in the Authorization header. */
class CallerGuard implements CanActivate {
  constructor(private readonly verifier: () => Verifier) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<WithCaller>();
    const r = await this.verifier().verifyRequest(toWebRequest(req));
    // The auth app did not answer: 503, not "sign in again".
    if (!r.ok) throw new ServiceUnavailableException(r.code);
    if (r.value === null) throw new UnauthorizedException();
    if (r.value.kind === "session-token" || r.value.kind === "api-token")
      req.caller = { email: r.value.user.email };
    return true;
  }
}

/**
 * The Nest app, before `listen`. Warning: the memory adapter keeps rows in
 * this process only. Use the Postgres adapter in production.
 */
export async function createApp(env: AppEnv): Promise<INestApplication> {
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
  let verifier: Verifier | null = null;
  const getVerifier = (): Verifier => {
    verifier ??= createVerifier({
      issuer: `${env.baseURL()}/auth`,
      accept: ["session-token", "api-token"],
      // The auth app is this process; another server passes no fetch.
      fetch: (input, init) => getAuth().handle(new Request(input, init)),
    });
    return verifier;
  };

  @Controller()
  class AccountController {
    // The page of a signed-in person. The middleware of the Express package sent anyone else to /sign-in.
    @Get("account")
    account(@Req() req: ExpressRequest, @Res({ passthrough: true }) res: ExpressResponse) {
      env.trace?.("page", req.path);
      return { email: getSession(res)?.user.email ?? null };
    }

    // A route for scripts: the guard reads the Authorization header, never the cookie.
    @Get("files")
    @UseGuards(new CallerGuard(getVerifier))
    files(@Req() req: WithCaller) {
      env.trace?.("page", req.path);
      return { owner: req.caller?.email ?? null };
    }
  }

  @Module({ controllers: [AccountController] })
  class AppModule {}

  // Express routes without case by default: "/myaccount" would run the page of
  // "/myAccount", which a rule with a capital letter misses. So the router
  // compares case too. Set it on an Express app of our own, before Nest gets it:
  // Express reads it when it makes the router, and the constructor of
  // ExpressAdapter already calls use(), so a set after NestFactory.create does nothing.
  const server = express();
  server.set("case sensitive routing", true);
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), { logger: false });
  // Every route of core under /auth, through the Express binding.
  app.use("/auth", authHandler(getAuth));
  // The session of every page, and /account for a signed-in person only. Express
  // matches without case and with an optional trailing slash, and the
  // middleware tests those forms too. An exact rule covers one route only.
  app.use(
    authSession({
      auth: getAuth,
      protect: (p) => {
        env.trace?.("rule", p);
        return env.protect ? env.protect(p) : p === "/account";
      },
      signInPath: "/sign-in",
    }),
  );
  return app;
}
