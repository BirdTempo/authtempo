import type { Auth, ResolvedSession } from "@authtempo/core";
import { checkGateOptions, type GateAuth, readGate } from "@authtempo/core/bindings";

/**
 * The server of Solid Start (plan 11d2). An API route mounts core, and a
 * request middleware reads the session into `event.locals.session`. It
 * imports nothing of Solid Start: the event is a web Request with locals.
 */

declare global {
  namespace App {
    interface RequestEventLocals {
      /** The session that `authOnRequest` read, or null. */
      session?: ResolvedSession | null;
    }
  }
}

/** The auth instance, or a function that makes it at the first request (so `vite build` reads no secret). */
export type AuthSource<A> = A | (() => A);

function resolve<A extends object>(source: AuthSource<A>): A {
  return typeof source === "function" ? (source as () => A)() : source;
}

type Handler = (event: { request: Request }) => Promise<Response>;

/** The handlers of `src/routes/auth/[...path].ts`. Export each method by name: `export const GET = h.GET;`. */
export function authRouteHandlers(auth: AuthSource<Pick<Auth, "handle">>): {
  GET: Handler;
  POST: Handler;
  OPTIONS: Handler;
} {
  const handle: Handler = ({ request }) => resolve(auth).handle(request);
  return { GET: handle, POST: handle, OPTIONS: handle };
}

/** The fields of Solid Start's FetchEvent that the entry reads and writes. */
export interface StartEventLike {
  request: Request;
  response: { headers: Headers };
  locals: object;
}

export interface SolidStartAuthOptions {
  auth: AuthSource<GateAuth>;
  /**
   * True for a path that needs a session. Needs `signInPath`. It gets the
   * path as the routers of Solid Start match it: the parsed path of the
   * request, not decoded, with one "/" at the end removed. The entry folds
   * case (see the README).
   */
  protect?: ((pathname: string) => boolean) | undefined;
  /** The sign-in page. The middleware adds `?next=<path and query>`. */
  signInPath?: string | undefined;
  /** The base path of core's routes. Default: the base path of the auth object, then "/auth". */
  basePath?: string | undefined;
}

/**
 * The path that the routers of Solid Start 2.0.6 match (read 2026-10-15).
 * `createBaseHandler` of dist/server/handler.js parses `request.url` with the
 * URL parser, so "..", "%2e", a backslash, and a tab are resolved before any
 * route matches, and no escape is decoded. An API route matches in radix3
 * 1.1.2 (`lookup` removes one "/" at the end and compares the case). A page
 * matches in @solidjs/router 1.0.0 (`createMatcher` of dist/utils.js removes
 * one "/" at the end and compares each static part in lower case).
 */
function routedPath(url: URL): string {
  const path = url.pathname;
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * The app's own origin: the protocol of the request and its Host header, when
 * the header parses as that one host. On Node the URL of the request (srvx
 * 0.12.8) takes the host of an absolute-form line "GET http://evil.example/x",
 * so the host never comes from the URL. A Host that is not one host, or no
 * Host (a web runtime, HTTP/2), falls back to the origin of `auth.baseURL`,
 * then to "http://localhost", so no request answers 500.
 */
function hostOrigin(protocol: string, host: string | null): string | null {
  if (!host) return null;
  try {
    const url = new URL(`${protocol}//${host}`);
    return url.host === host.toLowerCase() ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The `onRequest` of `src/middleware.ts`:
 * `export default createMiddleware({ onRequest: [authOnRequest({ auth: getAuth })] })`.
 * It sets `locals.session`, answers the redirect of a protected path, and
 * writes the renewed cookie to the event's response headers.
 */
export function authOnRequest(
  options: SolidStartAuthOptions,
): (event: StartEventLike) => Promise<Response | undefined> {
  checkGateOptions(options);
  const { protect } = options;
  return async (event) => {
    const auth = resolve(options.auth);
    const { request } = event;
    const url = new URL(request.url);
    const origin = hostOrigin(url.protocol, request.headers.get("host")) ?? fallback(auth.baseURL);
    // The page URL on the app's origin: the `next` of the redirect. The setter
    // keeps "//x" a path; a parse of the text would read a host.
    const page = new URL(origin);
    page.pathname = url.pathname;
    page.search = url.search;
    // The gate takes the origin of the redirect from the request it reads.
    const gateRequest =
      url.origin === origin ? request : new Request(page, { headers: request.headers });
    // radix3 matches an API route with case. Solid Router matches a page
    // without case: it compares each static part in lower case. The entry
    // cannot know which one serves a path, so it fails closed: the rule sees
    // the path as matched, then the path in lower case when that differs.
    const fold = (p: string) => p.toLowerCase();
    const gateOptions = {
      ...options,
      auth,
      protect: protect && ((p: string) => protect(p) || (fold(p) !== p && protect(fold(p)))),
    };
    const gate = await readGate(gateOptions, gateRequest, routedPath(url), page);
    if (gate.redirect) return gate.redirect;
    (event.locals as { session?: ResolvedSession | null }).session = gate.session;
    if (gate.cookie) event.response.headers.append("set-cookie", gate.cookie);
    return undefined;
  };
}

/** The origin of core's baseURL, else "http://localhost". */
function fallback(baseURL: string | undefined): string {
  try {
    if (baseURL) return new URL(baseURL).origin;
  } catch {
    // Not a URL: the last fallback.
  }
  return "http://localhost";
}

/** The session that `authOnRequest` set, or null. */
export function getSession(event: { locals: object }): ResolvedSession | null {
  return (event.locals as { session?: ResolvedSession | null }).session ?? null;
}
