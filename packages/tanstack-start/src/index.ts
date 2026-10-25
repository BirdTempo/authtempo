import type { Auth, ResolvedSession } from "@authtempo/core";
import {
  type BindingWaitUntil,
  checkGateOptions,
  type GateAuth,
  handleOptions,
  readGate,
  withSetCookie,
} from "@authtempo/core/bindings";

/**
 * The TanStack Start binding of authtempo (plan 11d2), for React and for
 * Solid. It imports nothing of TanStack: every shape it fits is a web Request
 * and Response. The app wraps `authRequestServer` in its own createMiddleware.
 */

/** The auth instance, or a function that makes it at the first request (so `vite build` reads no secret). */
export type AuthSource<A> = A | (() => A);

function resolve<A extends object>(source: AuthSource<A>): A {
  return typeof source === "function" ? (source as () => A)() : source;
}

export type RouteHandler = (ctx: { request: Request }) => Promise<Response>;

export interface RouteHandlerOptions {
  /**
   * The host's hook that keeps work alive after the answer (ruling 29 of
   * plan 12i). A server handler of TanStack Start 1.169.1 gets no platform
   * context, so the binding reads none. On Workers pass `waitUntil` of
   * "cloudflare:workers".
   */
  waitUntil?: BindingWaitUntil<{ request: Request }> | undefined;
}

/**
 * The server handlers of the splat route `src/routes/auth.$.ts`:
 * `export const Route = createFileRoute("/auth/$")({ server: { handlers: authRouteHandlers(getAuth) } });`.
 * Every method goes to core, which answers a method it does not serve. A
 * missing method would fall through to a catch-all page with no gate.
 * TanStack answers HEAD with the GET handler.
 */
export function authRouteHandlers(
  auth: AuthSource<Pick<Auth, "handle">>,
  options: RouteHandlerOptions = {},
): {
  GET: RouteHandler;
  POST: RouteHandler;
  PUT: RouteHandler;
  PATCH: RouteHandler;
  DELETE: RouteHandler;
  OPTIONS: RouteHandler;
} {
  const handle: RouteHandler = (ctx) =>
    resolve(auth).handle(
      ctx.request,
      handleOptions(options.waitUntil, ctx, () => undefined),
    );
  return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle, OPTIONS: handle };
}

/** The context that the middleware gives to the next step. */
export interface SessionContext {
  session: ResolvedSession | null;
}

export type RequestServer = <R extends { response: Response }>(args: {
  request: Request;
  /**
   * The path that TanStack Start gives a request middleware: the path of the
   * request decoded once and parsed again as a URL (`getNormalizedURL` of
   * @tanstack/router-core 1.171.37). Without it, the path of `request.url`.
   */
  pathname?: string | undefined;
  next(options: { context: SessionContext }): R | Promise<R>;
}) => Promise<R | Response>;

export interface StartAuthOptions {
  auth: AuthSource<GateAuth>;
  /**
   * True for a path that needs a session. Needs `signInPath`. It gets the
   * path as the router of TanStack matches it: decoded once, with no "/" at
   * the end. The router compares lower-case forms, so the binding also runs
   * the rule on the path in lower case, and in lower case with each escape in
   * upper-case hex ("/q%3Fx"). Write the rule in lower case: then it holds for
   * every case of the path. A rule with a capital letter, such as
   * `p.startsWith("/myAccount")`, misses "/myaccount", which runs the same page.
   */
  protect?: ((pathname: string) => boolean) | undefined;
  /** The sign-in page. The middleware adds `?next=<path and query>`. */
  signInPath?: string | undefined;
  /** The base path of core's routes. Default: the base path of the auth object, then "/auth". */
  basePath?: string | undefined;
}

/** The characters that the router escapes again after it decodes (`sanitizePathSegment`). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the router escapes these control characters again; the class copies its own.
const PATH_UNSAFE = /[\x00-\x1f\x7f"<>`{}]/g;

/** One part of the path, decoded as the router decodes it (`decodeSegment`). */
function decodePart(part: string): string {
  let decoded: string;
  try {
    decoded = decodeURI(part);
  } catch {
    // A bad escape: the router decodes each good escape alone and keeps the rest.
    decoded = part.replaceAll(/%[0-9A-F]{2}/gi, (code) => {
      try {
        return decodeURI(code);
      } catch {
        return code;
      }
    });
  }
  return decoded.replace(
    PATH_UNSAFE,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/**
 * The path that the router of TanStack Start matches. The steps are the ones
 * of @tanstack/router-core 1.171.37 (read 2026-10-15): `parseLocation` of
 * router.js decodes the middleware's path with `decodePath` of utils.js, which
 * keeps "%25" and "%5C" escaped and decodes the rest with decodeURI; then
 * `getMatchedRoutes` removes each "/" at the end (`trimPathRight` of path.js).
 * So "/%61ccount" and "/account/" both run the route "/account". The case
 * stays as it came: see authRequestServer.
 */
function routedPath(pathname: string): string {
  let path = pathname;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the router decodes a path with a control character too; the class copies its own.
  if (/[%\\\x00-\x1f\x7f]/.test(path)) {
    let out = "";
    let cursor = 0;
    for (const match of path.matchAll(/%25|%5C/gi)) {
      out += decodePart(path.slice(cursor, match.index)) + match[0];
      cursor = match.index + match[0].length;
    }
    path = out + decodePart(path.slice(cursor));
  }
  return path.length > 1 && path.endsWith("/") ? path.replace(/\/+$/, "") : path;
}

/**
 * The path in lower case with each kept escape in upper-case hex. The router
 * compares lower-case forms, so "/q%3fx" and "/Q%3FX" run the route "/q%3Fx";
 * a rule written with upper-case hex must see this form too.
 */
function upperHex(path: string): string {
  return path.toLowerCase().replace(/%[0-9a-f]{2}/g, (hex) => hex.toUpperCase());
}

/**
 * The origin of the redirect: the Host header, with the protocol of the
 * request. srvx 0.11.22, the Node server of TanStack Start, builds the URL of
 * a request line in absolute form ("GET http://evil.example/account") from
 * that line, so the origin of `request.url` is not the app's. A Host that does
 * not parse as one host ("a b") falls back to the origin of core's baseURL,
 * then to the origin of the request, so the binding never answers a 500.
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

/**
 * The server function of a request middleware:
 * `createMiddleware({ type: "request" }).server(authRequestServer({ auth: getAuth }))`.
 * It gives `{ session }` to the context, answers the redirect of a protected
 * path, and adds the renewed cookie to the page's answer.
 */
export function authRequestServer(options: StartAuthOptions): RequestServer {
  checkGateOptions(options);
  const { protect } = options;
  return async ({ request, pathname, next }) => {
    const url = new URL(request.url);
    // The page URL: the path that TanStack gives the middleware, a URL path
    // that the router decodes to the routed path. It is the `next` of the
    // redirect. The decoded path is not: "/%2561ccount" decodes to
    // "/%61ccount", which a browser opens as "/account".
    // The setter keeps "//x" a path: a parse of the text would read a host.
    const page = new URL(url);
    page.pathname = pathname ?? url.pathname;
    const path = routedPath(page.pathname);
    // The router of TanStack matches without case by default (caseSensitive:
    // false), and a route can set its own case rule. The binding cannot read
    // either, so it fails closed: the rule sees the path and the path in lower
    // case. `next` keeps the case of the request.
    const auth = resolve(options.auth);
    const gateOptions = {
      ...options,
      auth,
      protect:
        protect && ((p: string) => protect(p) || protect(p.toLowerCase()) || protect(upperHex(p))),
    };
    // The gate takes the origin of the redirect from its request: one on the
    // app's own origin, with the raw path and query and every header.
    const origin = originOf(request, url, auth.baseURL);
    const gateRequest =
      origin === url.origin
        ? request
        : new Request(`${origin}${url.pathname}${url.search}`, { headers: request.headers });
    // The gate judges the routed path, reads the cookie from the request, and
    // takes `next` from the page URL. The rule never sees the query.
    const gate = await readGate(gateOptions, gateRequest, path, page);
    if (gate.redirect) return gate.redirect;
    const result = await next({ context: { session: gate.session } });
    return { ...result, response: withSetCookie(result.response, gate.cookie) };
  };
}

/** The session of a route handler's or a server function's context, or null. */
export function getSession(context: unknown): ResolvedSession | null {
  if (typeof context !== "object" || context === null) return null;
  return (context as Partial<SessionContext>).session ?? null;
}
