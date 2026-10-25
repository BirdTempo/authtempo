import type { Auth, ResolvedSession } from "@authtempo/core";
import {
  type BindingWaitUntil,
  boundWaitUntil,
  checkGateOptions,
  type GateAuth,
  handleOptions,
  readGate,
} from "@authtempo/core/bindings";

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

/**
 * The fields of the APIEvent of Solid Start 2.0.6 that the handlers read.
 * `nativeEvent` is the H3Event of h3 2.0.2. Its `req` is the request of
 * srvx 1.0.5, whose optional `waitUntil` holds the hook of the runtime
 * (dist/_chunks/types.d.mts:589, read 2026-10-25).
 */
export interface StartApiEventLike {
  request: Request;
  nativeEvent?: { req?: unknown } | undefined;
}

type Handler = (event: StartApiEventLike) => Promise<Response>;

export interface StartRouteOptions {
  /**
   * The host's hook that keeps work alive after the answer (ruling 29 of
   * plan 12i). Default: the `waitUntil` of the srvx request, which srvx sets
   * on Workers. The binding does not call `nativeEvent.waitUntil` of h3: it
   * drops the promise when the request has no hook.
   */
  waitUntil?: BindingWaitUntil<StartApiEventLike> | undefined;
}

/**
 * The handlers of `src/routes/auth/[...path].ts`, one per method that the
 * file router of Solid Start 2.0.6 reads (HTTP_METHODS of
 * dist/config/fs-router.js; HEAD falls back to GET). Export each one by name:
 * `export const GET = h.GET;`. A method with no export falls through to the
 * pages, past the middleware, which skips a path of core: so core gets every
 * method under its base path, and answers each one itself.
 */
export function authRouteHandlers(
  auth: AuthSource<Pick<Auth, "handle">>,
  options: StartRouteOptions = {},
): {
  GET: Handler;
  POST: Handler;
  PUT: Handler;
  PATCH: Handler;
  DELETE: Handler;
  OPTIONS: Handler;
} {
  const handle: Handler = (event) =>
    resolve(auth).handle(
      event.request,
      handleOptions(options.waitUntil, event, () => boundWaitUntil(event.nativeEvent?.req)),
    );
  return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle, OPTIONS: handle };
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
   * request, not decoded, with one "/" at the end removed. Solid Router
   * compares a page path in lower case, escapes too. Write the rule in lower
   * case, with escapes in upper case: `p === "/caf%C3%A9"`. The entry also
   * asks the rule with the path in that form (see the README).
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
 * The rule, asked with each form of the path that a router of Solid Start
 * runs as the same route. A path needs a session when the rule holds for any
 * form. radix3 matches an API route with case, and Solid Router matches a page
 * without case (each static part in lower case): the entry cannot know which
 * one serves a path, so it asks the lower-case form too. radix3 removes one
 * "/" at the end, so "/account//" runs a child route "/account/:id" with an
 * empty id: the entry asks the form with each "/" at the end removed too.
 * "/" stays "/". The rule sees the path as matched first.
 * Solid Router 1.0.0 encodes a static part of a page (`encodeSegment` of
 * dist/routing.js) and lower-cases the pattern and the path, hex included
 * (`createMatcher` of dist/utils.js): the entry asks the lower-case forms
 * with each escape in upper case too.
 */
function failClosed(protect: (pathname: string) => boolean): (pathname: string) => boolean {
  return (p) => {
    const trimmed = p.replace(/\/+$/, "") || "/";
    const lower = [p.toLowerCase(), trimmed.toLowerCase()];
    // Solid Router lower-cases the hex of an escape too: "/caf%c3%a9" runs the
    // page "/café", whose pattern is "/caf%C3%A9". A rule in that form needs
    // the lower-case path with each escape in upper case.
    const hexUp = lower.map((f) => f.replace(/%[0-9a-f]{2}/g, (e) => e.toUpperCase()));
    const forms = new Set([p, trimmed, ...lower, ...hexUp]);
    for (const form of forms) if (protect(form)) return true;
    return false;
  };
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
    const gateOptions = { ...options, auth, protect: protect && failClosed(protect) };
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
