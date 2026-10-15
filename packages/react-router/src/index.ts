import type { Auth, ResolvedSession } from "@authtempo/core";
import { checkGateOptions, type GateAuth, readGate, withSetCookie } from "@authtempo/core/bindings";
import {
  type ActionFunctionArgs,
  createContext,
  type LoaderFunctionArgs,
  type MiddlewareFunction,
  type RouterContext,
  type RouterContextProvider,
} from "react-router";

/**
 * The React Router binding of authtempo (plan 11d2), for the server
 * middleware of React Router 8. It imports `createContext` of react-router.
 */

/** The auth instance, or a function that makes it at the first request. */
export type AuthSource<A> = A | (() => A);

function resolve<A extends object>(source: AuthSource<A>): A {
  return typeof source === "function" ? (source as () => A)() : source;
}

/** The session of the request in the router context. `getSession(context)` reads it. */
export const sessionContext: RouterContext<ResolvedSession | null> =
  createContext<ResolvedSession | null>(null);

/**
 * The route module of the splat `auth/*`, a resource route:
 * `export const { loader, action } = authRouteModule(getAuth);`.
 */
export function authRouteModule(auth: AuthSource<Pick<Auth, "handle">>): {
  loader(args: LoaderFunctionArgs): Promise<Response>;
  action(args: ActionFunctionArgs): Promise<Response>;
} {
  const handle = ({ request }: { request: Request }) => resolve(auth).handle(request);
  return { loader: handle, action: handle };
}

export interface RouterAuthOptions {
  auth: AuthSource<GateAuth>;
  /** True for a path that needs a session. Needs `signInPath`. */
  protect?: ((pathname: string) => boolean) | undefined;
  /** The sign-in page. The middleware adds `?next=<path and query>`. */
  signInPath?: string | undefined;
  /**
   * The base path of core's routes. Default: the base path of the auth
   * object, then "/auth". Set it only for a proxy that mounts core under
   * another prefix.
   */
  basePath?: string | undefined;
}

/**
 * The path that React Router matched, from request.url with the router's own
 * steps (react-router 8.4.0, read 2026-10-15). First getNormalizedPath
 * (server-runtime/urls.js): a client navigation sends "/page.data", and the
 * router removes "/_.data" (the "/" stays) or ".data". Then decodePath
 * (router/utils.js): each segment decoded once with decodeURIComponent, a
 * decoded "/" kept as "%2F", the whole raw path on a bad escape. Not the `url`
 * argument: its pathname setter resolves dot segments, and "/account/...data"
 * reaches the matcher as "/account/..", which a splat route "account/*" matches.
 */
function routedPath(request: Request): string {
  const raw = new URL(request.url).pathname;
  const path = raw.endsWith("/_.data") ? raw.replace(/_\.data$/, "") : raw.replace(/\.data$/, "");
  try {
    return path
      .split("/")
      .map((segment) => decodeURIComponent(segment).replace(/\//g, "%2F"))
      .join("/");
  } catch {
    // A bad escape: React Router matches the raw path, so the gate judges it too.
    return path;
  }
}

/**
 * The forms of the path that the rule must hold for. React Router matches a
 * route without case unless the route sets
 * caseSensitive (the RegExp flag "i" of compilePath, router/utils.js of 8.4.0,
 * read 2026-10-15). The binding fails closed: a path needs a session when the
 * rule holds for the path or for its folded form. The path is already decoded,
 * so the fold works on the text. It folds with toUpperCase, then toLowerCase:
 * the flag "i" compares upper-case forms, so a plain toLowerCase misses "ς"
 * against a route "σ". Each other difference of this fold only protects more
 * paths. An escape that the decode kept ("%2F") keeps its upper-case hex, so a
 * rule that names it still holds. React Router also ignores trailing slashes
 * on a route that is not a splat, so the rule gets the path with them removed
 * too ("/" stays "/"). A path needs a session when any form holds. `next`
 * keeps the case and the slashes of the request.
 */
function foldCase(
  protect: ((pathname: string) => boolean) | undefined,
): ((pathname: string) => boolean) | undefined {
  if (!protect) return undefined;
  const fold = (p: string) =>
    p
      .toUpperCase()
      .toLowerCase()
      .replace(/%[0-9a-f]{2}/g, (hex) => hex.toUpperCase());
  // A route that is not a splat ends in "\/*$" (compilePath, router/utils.js of
  // 8.4.0, read 2026-10-15): "/account/" and "/account//" render "/account".
  const trim = (p: string) => p.replace(/\/+$/, "") || "/";
  return (pathname) =>
    protect(pathname) ||
    protect(fold(pathname)) ||
    protect(trim(pathname)) ||
    protect(trim(fold(pathname)));
}

/**
 * The middleware of the root route: `export const middleware = [authMiddleware({ auth: getAuth })];`.
 * It sets `sessionContext`, answers the redirect of a protected path (the
 * pipeline returns a Response of a middleware at once), and adds the renewed
 * cookie to the page's answer. A request to a route of core reads no session:
 * the root middleware also runs around the resource route `auth/*`.
 */
export function authMiddleware(options: RouterAuthOptions): MiddlewareFunction {
  checkGateOptions(options);
  const protect = foldCase(options.protect);
  return async ({ request, url, context }, next) => {
    // The object form: the gate judges the decoded path as given, and a decoded
    // "?" or "#" stays text of the path, as the router matched it.
    const gate = await readGate(
      { ...options, auth: resolve(options.auth), protect },
      request,
      { pathname: routedPath(request), search: url.search },
      // next: the page URL without ".data" and "_routes", in URL form. Not the
      // decoded path: "/%2561ccount" decodes to "/%61ccount", which a browser
      // would open as "/account".
      url,
    );
    if (gate.redirect) return gate.redirect;
    context.set(sessionContext, gate.session);
    // On the server, next() answers the Response of the page. A route's
    // `middleware` array is MiddlewareFunction<unknown>[], so the type is unknown.
    const result = await next();
    return result instanceof Response ? withSetCookie(result, gate.cookie) : result;
  };
}

/** The session that `authMiddleware` set, or null. In a loader: `getSession(context)`. */
export function getSession(context: Readonly<RouterContextProvider>): ResolvedSession | null {
  return context.get(sessionContext);
}
