import type { Auth, ResolvedSession } from "@authtempo/core";
import { signInRedirect } from "@authtempo/core/bindings";
import {
  readBearer,
  readSessionToken,
  SESSION_TOKEN_PREFIX,
  sessionCookieNames,
} from "@authtempo/core/credentials";

/**
 * The Next.js binding of authtempo (plan 11d, spec 20), for the App Router of
 * Next 16. It imports nothing of Next at run time: a route handler and a proxy
 * take a web Request and answer a web Response.
 */

/** The auth instance, or a function that makes it at the first request (so a build reads no secret). */
export type AuthSource<A> = A | (() => A);

function resolve<A extends object>(source: AuthSource<A>): A {
  return typeof source === "function" ? (source as () => A)() : source;
}

/**
 * The handlers of `app/auth/[...path]/route.ts`:
 * `export const { GET, POST, OPTIONS } = authRouteHandlers(getAuth);`.
 * The folder `auth` is core's default `basePath`.
 */
export function authRouteHandlers(auth: AuthSource<Pick<Auth, "handle">>): {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
  OPTIONS(request: Request): Promise<Response>;
} {
  const handle = (request: Request) => resolve(auth).handle(request);
  return { GET: handle, POST: handle, OPTIONS: handle };
}

/**
 * The session of a server component, a server action, or a route handler:
 * `await authSession(getAuth, await headers())`. It is a read with no write
 * (`refresh: false`): a server component cannot set a cookie, so this read
 * leaves the sliding refresh in the row for the browser's own read of
 * `/auth/session`, the one answer that sends the renewed cookie. A server read
 * that took the refresh would drop it, and the cookie would end at its first
 * Max-Age (plan 11d Task 11 review, J1).
 */
export async function authSession(
  auth: AuthSource<Pick<Auth, "session">>,
  headers: Headers,
): Promise<ResolvedSession | null> {
  // Core reads the cookie and the bearer header only; the URL is not read.
  return resolve(auth).session(new Request("https://next.invalid/", { headers }), {
    refresh: false,
  });
}

export interface AuthProxyOptions {
  /** True for a path that needs a session, such as `(p) => p.startsWith("/account")`. */
  protect(pathname: string): boolean;
  /**
   * The app's sign-in page. The proxy adds `next`: the path and query of the
   * request, as one encoded value. The query goes too, so keep secrets out of
   * the query of a protected URL.
   */
  signInPath: string;
  /**
   * With the auth instance, the proxy asks core for the session: one storage
   * read per protected request, with no write. Without it, the proxy checks
   * only that a session cookie, or a bearer with core's session token prefix,
   * is present, and the page checks the session.
   */
  auth?: AuthSource<Pick<Auth, "session">> | undefined;
  /**
   * The session cookie name, as core's `cookieName`. Default
   * `__Host-tempo_session`; with the default, the name before plan 12b
   * (`tempo_session`) counts too, for one release, as core reads it.
   */
  cookieName?: string | undefined;
}

/**
 * The `proxy` of `proxy.ts` (Next 16 renamed middleware to proxy): a request
 * on a protected path with no session goes to the sign-in page with `next`;
 * every other request goes on (the answer `undefined`).
 */
export function authProxy(
  options: AuthProxyOptions,
): (request: Request) => Promise<Response | undefined> {
  // The one copy of the cookie name rule (plan 12b): core's own helper.
  const names = sessionCookieNames(options.cookieName);
  const live = async (request: Request): Promise<boolean> => {
    // With the auth instance core decides, with no write, so the browser keeps the refresh.
    if (options.auth)
      return (await resolve(options.auth).session(request, { refresh: false })) !== null;
    // Without it: a session cookie, or a bearer that is a session token. An API
    // token or any other bearer is no session here.
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    if (readSessionToken(names, { headers }) !== null) return true;
    return readBearer(request)?.startsWith(SESSION_TOKEN_PREFIX) ?? false;
  };
  return async (request) => {
    const url = new URL(request.url);
    if (!options.protect(url.pathname)) return undefined;
    if (await live(request)) return undefined;
    // The redirect rule of every binding, with the one-leading-slash guard of next.
    return signInRedirect(url, options.signInPath);
  };
}
