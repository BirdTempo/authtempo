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
  /** True for a path that needs a session. Needs `signInPath`. It gets the path as the router matched it: see `readGate`. */
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
  return redirectTo(url, url.pathname, url.search, signInPath);
}

/** The redirect of `signInRedirect`, for a path and a search that no URL parser touched. */
function redirectTo(base: URL | string, pathname: string, search: string, signInPath: string) {
  const target = new URL(signInPath, base);
  // One leading slash: "//host/x" would be a link to another origin on the sign-in page.
  const next = `${pathname.replace(/^\/+/, "/")}${search}`;
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

/** What the gate judges: the origin of the request, and the path and the search of the route. */
interface Judged {
  origin: string;
  pathname: string;
  search: string;
}

/**
 * The origin always comes from `request.url`, so the redirect never leaves it.
 * A routed string is not parsed as a URL: a parse resolves "..", ".", and
 * "%2e", re-encodes letters, and would judge a path that the router did not
 * match (plan 11d2 Task 3 review, C1). The fragment goes.
 */
function judge(request: Request, url: URL | string | undefined): Judged {
  const raw = new URL(request.url);
  if (url === undefined) return { origin: raw.origin, pathname: raw.pathname, search: raw.search };
  if (typeof url !== "string")
    return { origin: raw.origin, pathname: url.pathname, search: url.search };
  const text = url.split("#")[0] ?? "";
  const q = text.indexOf("?");
  const path = q === -1 ? text : text.slice(0, q);
  const search = q === -1 ? "" : text.slice(q);
  // A path with no leading "/" gets one: "account" is judged as "/account", and "" as "/".
  const slash = path.startsWith("/") ? "" : "/";
  return { origin: raw.origin, pathname: `${slash}${path}`, search };
}

/**
 * The session of a page request, the redirect of a protected path, and the
 * renewed cookie. A path of core reads nothing: `auth.handle` reads and renews
 * the session itself.
 *
 * `url` is the path that the framework's router matched, with the query: a
 * string, or a URL object that the framework parsed. The gate uses its path
 * for the base path check, the `protect` rule, and the `next` of the
 * redirect. The cookie and the bearer still come from `request`, and the
 * origin of the redirect from `request.url`. Without `url` the gate judges the
 * raw `request.url`, which is right only for a router that matches the raw
 * path. A router that decodes "/%61ccount" to "/account", or matches
 * "/ACCOUNT" as "/account", needs `url`, or a protected page renders with no
 * session (plan 11d2 path probe).
 *
 * `protect` gets the path exactly as the router matched it. The gate does not
 * change it: no resolution of "." or "..", no decoding, no encoding, no merge
 * of slashes. Of a string the gate drops the fragment and splits the query at
 * the first "?". A path with no leading "/" gets one. Of a URL object the gate
 * takes `pathname` and `search`, as the framework parsed them. Each binding's
 * README states how its router decodes the path and compares the case.
 */
export async function readGate(
  options: GateOptions,
  request: Request,
  url?: URL | string,
): Promise<Gate> {
  const routed = judge(request, url);
  // One source for the base path: core's own, unless a proxy moved core's routes.
  const basePath = options.basePath ?? options.auth.basePath ?? DEFAULT_BASE_PATH;
  if (isAuthPath(routed.pathname, basePath)) return { session: null, redirect: null, cookie: null };
  const session = await options.auth.session(request);
  if (!session && options.signInPath && options.protect?.(routed.pathname))
    return {
      session,
      redirect: redirectTo(routed.origin, routed.pathname, routed.search, options.signInPath),
      cookie: null,
    };
  return {
    session,
    redirect: null,
    cookie: session ? options.auth.sessionCookie(request, session) : null,
  };
}
