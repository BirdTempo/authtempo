import type { Auth, ResolvedSession } from "@authtempo/core";
import { checkGateOptions, type GateAuth, readGate, withSetCookie } from "@authtempo/core/bindings";
import type { APIRoute, MiddlewareHandler } from "astro";

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
   * True for a path that needs a session. Needs `signInPath`. It gets the path
   * in URL form, as Astro routed it: duplicate slashes merged, case kept. A
   * non-ASCII letter comes encoded ("/caf%C3%A9"): write such a rule in the
   * encoded form or as a prefix (the gate contract in the README of core).
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
 * The `onRequest` of `src/middleware.ts`: sets `locals.session`, sends a
 * person with no session on a protected path to the sign-in page, and adds the
 * renewed cookie to the page's answer.
 */
export function authMiddleware(options: AstroAuthOptions): MiddlewareHandler {
  checkGateOptions(options);
  return async (context, next) => {
    // context.url is the URL that Astro's router matched: decoded until it
    // stops changing, duplicate slashes merged. The raw request.url of
    // "/%61ccount" would pass a protect rule that the routed "/account" fails.
    const gate = await readGate(
      { ...options, auth: resolve(options.auth) },
      context.request,
      context.url,
    );
    if (gate.redirect) return gate.redirect;
    context.locals.session = gate.session;
    return withSetCookie(await next(), gate.cookie);
  };
}
