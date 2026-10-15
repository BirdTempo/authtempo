import type { Auth, ResolvedSession } from "@authtempo/core";
import { checkGateOptions, type GateAuth, readGate, withSetCookie } from "@authtempo/core/bindings";
import type { APIContext, APIRoute, MiddlewareHandler } from "astro";

/**
 * The Astro binding of authtempo (plan 11d2), for on-demand pages
 * (`output: "server"`). It imports nothing of Astro at run time.
 */

declare global {
  namespace App {
    interface Locals {
      /** The session that `authMiddleware` read, or null. `Astro.locals.session` in a page. */
      session: ResolvedSession | null;
    }
  }
}

/** The auth instance, or a function that makes it at the first request (so `astro build` reads no secret). */
export type AuthSource<A> = A | (() => A);

function resolve<A extends object>(source: AuthSource<A>): A {
  return typeof source === "function" ? (source as () => A)() : source;
}

/**
 * The endpoint of the routes of core, in `src/pages/auth/[...path].ts`:
 * `export const ALL = authRoute(getAuth); export const prerender = false;`.
 */
export function authRoute(auth: AuthSource<Pick<Auth, "handle">>): APIRoute {
  return ({ request }) => resolve(auth).handle(request);
}

export interface AstroAuthOptions {
  auth: AuthSource<GateAuth>;
  /**
   * True for a path that needs a session. Needs `signInPath`. It gets the text
   * that Astro's router matched: decoded until it stops changing, duplicate
   * slashes merged, case kept, with no trailing "/" and without Astro's `base`.
   * A non-ASCII route reaches the rule decoded ("/café").
   */
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
 * The text that Astro's router matched. Astro 7.3.8 keeps it in
 * `context.originPathname` (FetchState `pathname`: decoded until it stops
 * changing, duplicate slashes merged, `base` removed), with a "/" appended for
 * the default trailing slash rule. `context.url` is not that text: Astro writes
 * the text into the URL, and the URL parses it again, so "/account/../x" (from
 * "/account/%252e%252e/x") becomes "/x" there, while the router ran the
 * "/account/[...rest]" page. `context.request.url` is not it either: with
 * `security.allowedDomains` and a forwarded header, Astro rebuilds the request
 * from that parsed URL.
 */
function routedPath(context: APIContext): string {
  const path = context.originPathname;
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * The `onRequest` of `src/middleware.ts`: sets `locals.session`, sends a
 * person with no session on a protected path to the sign-in page, and adds the
 * renewed cookie to the page's answer.
 */
export function authMiddleware(options: AstroAuthOptions): MiddlewareHandler {
  checkGateOptions(options);
  return async (context, next) => {
    // The gate judges the routed text; next comes from the page URL, context.url.
    const gate = await readGate(
      { ...options, auth: resolve(options.auth) },
      context.request,
      routedPath(context),
      context.url,
    );
    if (gate.redirect) return gate.redirect;
    context.locals.session = gate.session;
    return withSetCookie(await next(), gate.cookie);
  };
}
