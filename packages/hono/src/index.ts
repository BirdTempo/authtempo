import type { Auth, ResolvedSession } from "@authtempo/core";
import {
  type BindingWaitUntil,
  boundWaitUntil,
  checkGateOptions,
  type GateAuth,
  handleOptions,
  readGate,
  withSetCookie,
} from "@authtempo/core/bindings";
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

export interface HonoHandlerOptions {
  /**
   * The host's hook that keeps work alive after the answer (ruling 29 of
   * plan 12i). Default on Workers: `c.executionCtx.waitUntil`. Set it on a
   * host whose runtime stops work at the answer and that Hono does not see.
   */
  waitUntil?: BindingWaitUntil<Context> | undefined;
}

/**
 * The ExecutionContext of Workers, or undefined. The getter `c.executionCtx`
 * of Hono 4.13.13 throws when the runtime gives none, as on Node
 * (dist/types/context.d.ts:247, read 2026-10-25).
 */
function executionContext(c: Context): unknown {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/** The handler of the routes of core, for every method: `app.all("/auth/*", authHandler(auth))`. */
export function authHandler(
  auth: HonoAuthSource<Pick<Auth, "handle">>,
  options: HonoHandlerOptions = {},
): (c: Context) => Promise<Response> {
  return (c) =>
    resolve(auth, c).handle(
      c.req.raw,
      handleOptions(options.waitUntil, c, () => boundWaitUntil(executionContext(c))),
    );
}

/**
 * The origin of the redirect: the Host header, with the protocol of the
 * request, then the origin of core's baseURL, then the origin of the request.
 * Never the request target: @hono/node-server 2.1.5 keeps an absolute-form
 * line ("GET http://evil.example/account") as the request URL and reads no
 * Host (final review m5). The rule is the one of the TanStack Start binding.
 */
function originOf(request: Request, url: URL, baseURL: string | undefined): string {
  const host = request.headers.get("host") ?? "";
  if (host && (url.protocol === "http:" || url.protocol === "https:")) {
    try {
      // A slash, a backslash, "?", "#", "@", or a space would end the host or name a user.
      if (!/[/\\?#@\s]/.test(host)) return new URL(`${url.protocol}//${host}`).origin;
    } catch {
      // Not one host: try core's baseURL.
    }
  }
  if (baseURL) {
    try {
      return new URL(baseURL).origin;
    } catch {
      // core checks baseURL at creation; a stand-in may not.
    }
  }
  return url.origin;
}

export interface HonoSessionOptions {
  auth: HonoAuthSource<GateAuth>;
  /** True for a path that needs a session. Needs `signInPath`. */
  protect?: ((pathname: string) => boolean) | undefined;
  /** The sign-in page. The middleware adds `?next=<path and query>`. */
  signInPath?: string | undefined;
  /**
   * The path under which core's routes reach this app. Default `auth.basePath`,
   * then "/auth". Set it only for a proxy that mounts core under another prefix.
   * It starts with "/" and does not end with "/": `authSession` throws otherwise.
   */
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
    // The path exactly as the router matched it (Hono's getPath: decoded once,
    // "%25" kept, case kept), with the query. protect gets it as given: "/café".
    const url = new URL(c.req.url);
    const routed = `${c.req.path}${url.search}`;
    const auth = resolve(options.auth, c);
    // The gate takes the origin of the redirect from its request: one on the
    // app's own origin, with the raw path and query and every header.
    const origin = originOf(c.req.raw, url, auth.baseURL);
    const request =
      origin === url.origin
        ? c.req.raw
        : new Request(`${origin}${url.pathname}${url.search}`, { headers: c.req.raw.headers });
    const gate = await readGate({ ...options, auth }, request, routed);
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
