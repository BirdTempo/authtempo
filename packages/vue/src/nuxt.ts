import type { Auth, ResolvedSession } from "@authtempo/core";
import { checkGateOptions, type GateAuth, readGate } from "@authtempo/core/bindings";
import {
  appendResponseHeader,
  defineEventHandler,
  type EventHandler,
  getRequestURL,
  type H3Event,
  toWebRequest,
} from "h3";

/**
 * The server of Nuxt (plan 11d2): Nitro on h3 1. A server route mounts core,
 * and a server middleware reads the session into `event.context.session`.
 */

declare module "h3" {
  interface H3EventContext {
    /** The session that `authSessionHandler` read, or null. */
    session?: ResolvedSession | null;
  }
}

/** The auth instance, or a function that makes it at the first request (so `nuxt build` reads no secret). */
export type AuthSource<A> = A | (() => A);

function resolve<A extends object>(source: AuthSource<A>): A {
  return typeof source === "function" ? (source as () => A)() : source;
}

/** The handler of `server/routes/auth/[...path].ts`: `export default authEventHandler(getAuth);`. */
export function authEventHandler(auth: AuthSource<Pick<Auth, "handle">>): EventHandler {
  return defineEventHandler((event) => resolve(auth).handle(toWebRequest(event)));
}

export interface NuxtAuthOptions {
  auth: AuthSource<GateAuth>;
  /** True for a path that needs a session. Needs `signInPath`. */
  protect?: ((pathname: string) => boolean) | undefined;
  /** The sign-in page. The middleware adds `?next=<path and query>`. */
  signInPath?: string | undefined;
  /**
   * The path under which core's routes reach this app. Default the base path
   * of the auth object (`auth.basePath`), then "/auth". Set it only for a proxy
   * that mounts core under another prefix.
   */
  basePath?: string | undefined;
}

/**
 * The URL that h3 routes and the Nuxt renderer reads. h3 1.15.11 decodes the
 * path once with decodeURIComponent and keeps "%2F" and "%25" (_decodePath and
 * ufo's decodePath, read 2026-10-15), so "/%61ccount" and "/account%3F" both
 * render the page of "/account". The gate reads the same text. The URL is
 * built again from that text, so a decoded "?" starts the query, as in h3.
 * A path with a bad escape stays as it came, as in h3. Not event.path: under
 * a Nuxt app.baseURL it loses the base that core's routes keep.
 */
function routedURL(raw: string | URL): URL {
  const url = new URL(raw);
  let path = url.pathname;
  try {
    path = decodeURIComponent(path.replace(/%25/g, "%2525").replace(/%2F/gi, "%252F"));
  } catch {
    // A bad escape: h3 keeps the raw path, so the raw path is the routed path.
  }
  // One leading slash: "//x" after the origin would name another host.
  return new URL(path.replace(/^[/\\]+/, "/") + url.search, url.origin);
}

/**
 * The server middleware of `server/middleware/session.ts`:
 * `export default authSessionHandler({ auth: getAuth });`. It reads the URL
 * and the headers only, never the body that a later handler needs. A request
 * to a route of core reads no session: core reads and renews it itself.
 */
export function authSessionHandler(options: NuxtAuthOptions): EventHandler {
  checkGateOptions(options);
  return defineEventHandler(async (event) => {
    // A web handler (toWebHandler, a Worker preset) keeps the request's URL in
    // event.web; on Node, getRequestURL builds it from the Host header.
    const raw = event.web?.url ?? getRequestURL(event);
    // A body-less copy for the session read: the gate reads the headers only.
    const request = new Request(raw, { headers: event.headers });
    const gate = await readGate(
      { ...options, auth: resolve(options.auth) },
      request,
      routedURL(raw),
    );
    // A middleware that answers ends the request; one that answers nothing lets it go on.
    if (gate.redirect) return gate.redirect;
    event.context.session = gate.session;
    if (gate.cookie) appendResponseHeader(event, "set-cookie", gate.cookie);
    return undefined;
  });
}

/** The session that `authSessionHandler` set, or null. */
export function getSession(event: H3Event): ResolvedSession | null {
  return event.context.session ?? null;
}
