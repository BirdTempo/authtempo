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
 * The path and query that React Router matched. `url` is the routed URL, not
 * request.url: a client navigation sends "/page.data?_routes=...", and React
 * Router normalizes only `url` (server-runtime/urls.js and router.js of 8.4.0,
 * read 2026-10-15). The router then decodes each segment once with
 * decodeURIComponent and keeps a decoded "/" as "%2F" (decodePath of
 * router/utils.js, read 2026-10-15), so "/%61ccount" runs the page of
 * "/account". The gate reads the same text. A bad escape leaves the whole
 * path raw, as in the router.
 */
function routedPath(url: URL): string {
  let path = url.pathname;
  try {
    path = path
      .split("/")
      .map((segment) => decodeURIComponent(segment).replace(/\//g, "%2F"))
      .join("/");
  } catch {
    // A bad escape: React Router matches the raw path, so the gate reads it too.
  }
  // The router matches a decoded "?", "#", or "\" as text of the path. In a URL
  // they would start the query, start the fragment, or turn into "/".
  return path.replace(/[?#\\]/g, encodeURIComponent) + url.search;
}

/**
 * React Router matches a route without case unless the route sets
 * caseSensitive (the RegExp flag "i" of compilePath, router/utils.js of 8.4.0,
 * read 2026-10-15). The binding fails closed: a path needs a session when the
 * rule holds for the path or for its folded form. The fold works on the
 * decoded text, because "%c3%89" is still the escape of "É". It folds with
 * toUpperCase, then toLowerCase: the flag "i" compares upper-case forms, so a
 * plain toLowerCase misses "ς" against a route "σ". Each other difference of
 * this fold only protects more paths. `next` keeps the case of the request.
 */
function foldCase(
  protect: ((pathname: string) => boolean) | undefined,
): ((pathname: string) => boolean) | undefined {
  if (!protect) return undefined;
  return (pathname) => {
    if (protect(pathname)) return true;
    let text = pathname;
    try {
      // decodeURI keeps "%2F", "%3F", and "%23" as escapes, so no segment changes.
      text = decodeURI(pathname);
    } catch {
      // A bad escape: fold the URL form as it is.
    }
    // Back to URL form, with upper-case escape hex as the gate gives it.
    const folded = new URL(`http://x${text.toUpperCase().toLowerCase()}`).pathname.replace(
      /%[0-9a-f]{2}/g,
      (hex) => hex.toUpperCase(),
    );
    return protect(folded);
  };
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
    // The gate judges the routed path and reads the cookie from the request.
    const gate = await readGate(
      { ...options, auth: resolve(options.auth), protect },
      request,
      routedPath(url),
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
