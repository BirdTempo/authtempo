import type { Auth } from "./create-auth.js";
import type { ResolvedSession } from "./engine/sessions.js";

/**
 * The one gate of every server binding (plan 11d2): Hono, Express, Fastify,
 * Astro, SvelteKit, React Router, TanStack Start, and the Nuxt and Solid Start
 * entries. A binding fits it to its framework; the rule itself lives here once.
 */

export const DEFAULT_BASE_PATH = "/auth";

/**
 * `basePath` is optional, so an auth object of an older core, or a stand-in
 * with the three calls, still fits. With it, the gate reads core's own base path.
 */
export type GateAuth = Pick<Auth, "handle" | "session" | "sessionCookie"> & {
  readonly basePath?: string | undefined;
};

export interface GateOptions {
  auth: GateAuth;
  /** True for a path that needs a session. Needs `signInPath`. It gets the path in URL form: see `readGate`. */
  protect?: ((pathname: string) => boolean) | undefined;
  /**
   * The sign-in page of the app, a path that starts with "/". The gate adds
   * `next`: the path and the query of the request, as one encoded value. The
   * query goes too, so keep secrets out of the query of a protected URL.
   */
  signInPath?: string | undefined;
  /**
   * The path under which core's routes reach this app. Default `auth.basePath`,
   * then "/auth". Set it only for a proxy that mounts core under another prefix.
   */
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
export function checkGateOptions(
  options: Pick<GateOptions, "protect" | "signInPath" | "basePath">,
): void {
  const { signInPath, basePath } = options;
  if (options.protect && !signInPath)
    throw new Error("authtempo bindings: protect needs signInPath");
  // "//host" and "/\host" are links to another origin, as a browser reads them.
  const foreign = signInPath?.startsWith("//") || signInPath?.startsWith("/\\");
  if (signInPath !== undefined && (!signInPath.startsWith("/") || foreign))
    throw new Error('authtempo bindings: signInPath must be a path of this origin, one "/" first');
  // The rule of core's own basePath: with a "/" at the end, no path of core would match.
  const trailing = basePath?.endsWith("/");
  if (basePath !== undefined && (!basePath.startsWith("/") || trailing))
    throw new Error('authtempo bindings: basePath must start with "/" and not end with "/"');
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
 * The URL the gate judges: the origin of `request.url`, with the path and the
 * query of the routed URL when the binding gives it. The fragment goes.
 */
function routedURL(request: Request, url: URL | string | undefined): URL {
  const raw = new URL(request.url);
  if (url === undefined) return raw;
  const path = typeof url === "string" ? url : `${url.pathname}${url.search}`;
  // A path with no leading "/" gets one, so no request can throw here.
  const slash = path.startsWith("/") ? "" : "/";
  // Only the path and the query count: the redirect never leaves the origin of the request.
  return new URL(`${raw.origin}${slash}${path}`);
}

/**
 * The session of a page request, the redirect of a protected path, and the
 * renewed cookie. A path of core reads nothing: `auth.handle` reads and renews
 * the session itself.
 *
 * `url` is the URL that the framework's router matched, with the query: the
 * path decoded as the router decodes it, in the case the router compares. The
 * gate uses it for the base path check, the `protect` rule, and the `next` of
 * the redirect. The cookie and the bearer still come from `request`. Without
 * `url` the gate judges the raw `request.url`, which is right only for a
 * router that matches the raw path. A router that decodes "/%61ccount" to
 * "/account", or matches "/ACCOUNT" as "/account", needs `url`, or a protected
 * page renders with no session (plan 11d2 path probe).
 *
 * Pass a path with a leading "/" (and the query), or a URL object. The gate
 * takes only the path and the query of it, on the origin of `request.url`, so
 * the redirect stays on that origin. "//x" stays a path. A string with no
 * leading "/" gets one: "account" is judged as "/account", and "" as "/".
 *
 * `protect` gets the path in URL form: the WHATWG `pathname` of the routed
 * URL. An escaped letter such as "%61" is decoded where the router decodes it.
 * A space or a non-ASCII letter is encoded again by the URL parser: "/café"
 * and "/caf%C3%A9" both reach the rule as "/caf%C3%A9", and "/my account" as
 * "/my%20account". Write such a rule in the encoded form or as a prefix. A
 * rule `p === "/café"` never matches, and the page opens with no session.
 */
export async function readGate(
  options: GateOptions,
  request: Request,
  url?: URL | string,
): Promise<Gate> {
  const routed = routedURL(request, url);
  // One source for the base path: core's own, unless a proxy moved core's routes.
  const basePath = options.basePath ?? options.auth.basePath ?? DEFAULT_BASE_PATH;
  if (isAuthPath(routed.pathname, basePath)) return { session: null, redirect: null, cookie: null };
  const session = await options.auth.session(request);
  if (!session && options.signInPath && options.protect?.(routed.pathname))
    return { session, redirect: signInRedirect(routed, options.signInPath), cookie: null };
  return {
    session,
    redirect: null,
    cookie: session ? options.auth.sessionCookie(request, session) : null,
  };
}
