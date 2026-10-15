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
 * The middleware of the root route: `export const middleware = [authMiddleware({ auth: getAuth })];`.
 * It sets `sessionContext`, answers the redirect of a protected path (the
 * pipeline returns a Response of a middleware at once), and adds the renewed
 * cookie to the page's answer. A request to a route of core reads no session:
 * the root middleware also runs around the resource route `auth/*`.
 */
export function authMiddleware(options: RouterAuthOptions): MiddlewareFunction {
  checkGateOptions(options);
  return async ({ request, context }, next) => {
    const gate = await readGate({ ...options, auth: resolve(options.auth) }, request);
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
