import type { Auth } from "./create-auth.js";
import type { ResolvedSession } from "./engine/sessions.js";

/**
 * The one gate of every server binding (plan 11d2): Hono, Express, Fastify,
 * Astro, SvelteKit, React Router, TanStack Start, and the Nuxt and Solid Start
 * entries. A binding fits it to its framework; the rule itself lives here once.
 */

export const DEFAULT_BASE_PATH = "/auth";

export type GateAuth = Pick<Auth, "handle" | "session" | "sessionCookie">;

export interface GateOptions {
  auth: GateAuth;
  /** True for a path that needs a session. Needs `signInPath`. */
  protect?: ((pathname: string) => boolean) | undefined;
  /**
   * The sign-in page of the app, a path that starts with "/". The gate adds
   * `next`: the path and the query of the request, as one encoded value. The
   * query goes too, so keep secrets out of the query of a protected URL.
   */
  signInPath?: string | undefined;
  /** The `basePath` of core. Default "/auth". */
  basePath?: string | undefined;
}

export interface Gate {
  session: ResolvedSession | null;
  /** The redirect to the sign-in page, or null. Answer it and run no page code. */
  redirect: Response | null;
  /** The renewed session cookie after the sliding refresh, or null. Send it on the page's answer. */
  cookie: string | null;
}

/** Throws for a wrong option. A binding calls it at construction, not per request. */
export function checkGateOptions(options: Pick<GateOptions, "protect" | "signInPath">): void {
  if (options.protect && !options.signInPath)
    throw new Error("authtempo bindings: protect needs signInPath");
  if (options.signInPath !== undefined && !options.signInPath.startsWith("/"))
    throw new Error('authtempo bindings: signInPath must start with "/"');
}

/** True for a path of core: under the base path, and not the base path itself. */
export function isAuthPath(pathname: string, basePath: string = DEFAULT_BASE_PATH): boolean {
  return pathname.startsWith(`${basePath}/`);
}

/**
 * 307 to the sign-in page, with `next` = the path and the query of `url`. A
 * query of `signInPath` stays. This is the rule of `@authtempo/next` (plan 11d
 * Task 11), moved here so every binding has the same one.
 */
export function signInRedirect(url: URL, signInPath: string): Response {
  const target = new URL(signInPath, url);
  // One leading slash: "//host/x" would be a link to another origin on the sign-in page.
  const next = `${url.pathname.replace(/^\/+/, "/")}${url.search}`;
  const query = `${target.search ? `${target.search}&` : "?"}next=${encodeURIComponent(next)}`;
  return Response.redirect(`${target.origin}${target.pathname}${query}`, 307);
}

/**
 * Adds one Set-Cookie line. An answer whose headers are fixed (such as one of
 * Response.redirect) throws at the append, so the gate answers a copy.
 */
export function withSetCookie(response: Response, cookie: string | null): Response {
  if (!cookie) return response;
  try {
    response.headers.append("set-cookie", cookie);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.append("set-cookie", cookie);
    return copy;
  }
}

/**
 * The session of a page request, the redirect of a protected path, and the
 * renewed cookie. A path of core reads nothing: `auth.handle` reads and renews
 * the session itself.
 */
export async function readGate(options: GateOptions, request: Request): Promise<Gate> {
  const url = new URL(request.url);
  if (isAuthPath(url.pathname, options.basePath))
    return { session: null, redirect: null, cookie: null };
  const session = await options.auth.session(request);
  if (!session && options.signInPath && options.protect?.(url.pathname))
    return { session, redirect: signInRedirect(url, options.signInPath), cookie: null };
  return {
    session,
    redirect: null,
    cookie: session ? options.auth.sessionCookie(request, session) : null,
  };
}
