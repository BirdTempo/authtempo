import type { Auth, ResolvedSession } from "@authtempo/core";
import { checkGateOptions, type GateAuth, readGate, withSetCookie } from "@authtempo/core/bindings";
import type { Context, MiddlewareHandler } from "hono";

/**
 * The Hono binding of authtempo (plan 11d2). It runs where Hono runs:
 * Workers, Node, Bun, and Deno. It imports nothing of Hono at run time.
 */

/** The value that `authSession` sets: `c.get("session")`. */
export type AuthEnv = { Variables: { session: ResolvedSession | null } };

/** The auth instance, or a function of the context that makes it (on Workers, from `c.env`). */
export type HonoAuthSource<A> = A | ((c: Context) => A);

function resolve<A extends object>(source: HonoAuthSource<A>, c: Context): A {
  return typeof source === "function" ? (source as (c: Context) => A)(c) : source;
}

/** The handler of the routes of core: `app.on(["GET", "POST", "OPTIONS"], "/auth/*", authHandler(auth))`. */
export function authHandler(
  auth: HonoAuthSource<Pick<Auth, "handle">>,
): (c: Context) => Promise<Response> {
  return (c) => resolve(auth, c).handle(c.req.raw);
}

export interface HonoSessionOptions {
  auth: HonoAuthSource<GateAuth>;
  /** True for a path that needs a session. Needs `signInPath`. */
  protect?: ((pathname: string) => boolean) | undefined;
  /** The sign-in page. The middleware adds `?next=<path and query>`. */
  signInPath?: string | undefined;
  /** The base path of core's routes. Default: the base path of the auth object, then "/auth". */
  basePath?: string | undefined;
}

/**
 * Sets `c.get("session")` for every request except the routes of core, sends
 * a person with no session on a protected path to the sign-in page, and adds
 * the renewed cookie to the answer.
 */
export function authSession(options: HonoSessionOptions): MiddlewareHandler<AuthEnv> {
  checkGateOptions(options);
  return async (c, next) => {
    // The path the router matched (Hono's getPath: decoded once, case kept), with the query.
    const routed = `${c.req.path}${new URL(c.req.url).search}`;
    const gate = await readGate({ ...options, auth: resolve(options.auth, c) }, c.req.raw, routed);
    if (gate.redirect) return gate.redirect;
    c.set("session", gate.session);
    await next();
    c.res = withSetCookie(c.res, gate.cookie);
  };
}

/** The session that `authSession` set, or null. */
export function getSession(c: Context<AuthEnv>): ResolvedSession | null {
  return c.get("session") ?? null;
}
