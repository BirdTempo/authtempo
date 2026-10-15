import type { Auth } from "./create-auth.js";
import type { ResolvedSession } from "./engine/sessions.js";
import { safeNext } from "./http/safe-next.js";

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
  /** `auth.baseURL`: the origin a binding uses when the Host header does not parse. */
  readonly baseURL?: string | undefined;
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
  // Judge the origin with the parser that the redirect uses: it reads "//host", "/\host",
  // and "/\t/host" (a tab, a newline, or a carriage return is dropped) as another origin.
  const local = "http://gate.invalid";
  const foreign =
    signInPath?.startsWith("/") === true && new URL(signInPath, local).origin !== local;
  if (signInPath !== undefined && (!signInPath.startsWith("/") || foreign))
    throw new Error('authtempo bindings: signInPath must be a path of this origin, one "/" first');
  // The rule of core's own basePath: with a "/" at the end, no path of core would match.
  const trailing = basePath?.endsWith("/");
  if (basePath !== undefined && (!basePath.startsWith("/") || trailing))
    throw new Error('authtempo bindings: basePath must start with "/" and not end with "/"');
}

/**
 * True for a path of core: under the base path, and not the base path itself.
 * False for a malformed base path ("", no leading "/", or a "/" at the end), so
 * a hand-made auth object with such a base path makes the gate fail closed.
 */
export function isAuthPath(pathname: string, basePath: string = DEFAULT_BASE_PATH): boolean {
  if (!basePath.startsWith("/") || basePath.endsWith("/")) return false;
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
  const joined = `${pathname.replace(/^\/+/, "/")}${search}`;
  // The rule of core's own flows: no backslash, no control character, no second origin, else "/".
  const next = safeNext(joined);
  const query = `${target.search ? `${target.search}&` : "?"}next=${encodeNext(next)}`;
  return Response.redirect(`${target.origin}${target.pathname}${query}`, 307);
}

/** A lone surrogate makes encodeURIComponent throw: the gate then answers next "/", not a 500. */
function encodeNext(next: string): string {
  try {
    return encodeURIComponent(next);
  } catch {
    return "%2F";
  }
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
 * A path that the router matched as text, for a router that decodes "%3F" or
 * "%23" into the path: the gate judges `pathname` as given, with no split at
 * "?" and no drop of "#". `search` is accepted and not read: `next` comes from
 * `returnTo` or `request.url`, which hold the query.
 */
export interface RoutedPath {
  pathname: string;
  search?: string | undefined;
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
function judge(request: Request, url: URL | RoutedPath | string | undefined): Judged {
  const raw = new URL(request.url);
  if (url === undefined) return { origin: raw.origin, pathname: raw.pathname, search: raw.search };
  if (url instanceof URL) return { origin: raw.origin, pathname: url.pathname, search: url.search };
  if (typeof url !== "string") {
    // The object form: the path text as the router matched it, "?" and "#" included.
    const lead = url.pathname.startsWith("/") ? "" : "/";
    return { origin: raw.origin, pathname: `${lead}${url.pathname}`, search: "" };
  }
  const text = url.split("#")[0] ?? "";
  const q = text.indexOf("?");
  const path = q === -1 ? text : text.slice(0, q);
  const search = q === -1 ? "" : text.slice(q);
  // A path with no leading "/" gets one: "account" is judged as "/account", and "" as "/".
  const slash = path.startsWith("/") ? "" : "/";
  return { origin: raw.origin, pathname: `${slash}${path}`, search };
}

/** The path and the query of `next`: of `returnTo`, else of a routed URL object, else of the request. */
function back(
  request: Request,
  routed: URL | RoutedPath | string | undefined,
  returnTo: URL | undefined,
): URL {
  if (returnTo !== undefined) return returnTo;
  // A routed URL object is the framework's parse; a routed text or RoutedPath is never a next.
  if (routed instanceof URL) return routed;
  return new URL(request.url);
}

function redirectBack(origin: string, page: URL, signInPath: string): Response {
  return redirectTo(origin, page.pathname, page.search, signInPath);
}

/**
 * The session of a page request, the redirect of a protected path, and the
 * renewed cookie. A path of core reads nothing: `auth.handle` reads and renews
 * the session itself.
 *
 * `routed` is the path that the framework's router matched, with the query: a
 * string, or a URL object that the framework parsed. The gate uses its path
 * for the base path check and the `protect` rule. The cookie and the bearer
 * still come from `request`, and the origin of the redirect from
 * `request.url`. Without `routed` the gate judges the
 * raw `request.url`, which is right only for a router that matches the raw
 * path. A router that decodes "/%61ccount" to "/account", or matches
 * "/ACCOUNT" as "/account", needs `routed`, or a protected page renders with
 * no session (plan 11d2 path probe).
 *
 * `returnTo` is the page URL, for a request whose URL is not the page URL,
 * such as SvelteKit's "/account/__data.json" or React Router's "/account.data".
 * The judged path and the return URL are two values: a decoded text is not a
 * safe `next`, because "/%2561ccount" decodes to "/%61ccount", which a browser
 * then opens as "/account". `next` is the path and the query of `returnTo`
 * when given, else of a routed URL object, else of `request.url`. It never
 * comes from a routed string.
 *
 * `protect` gets the path exactly as the router matched it. The gate does not
 * change it: no resolution of "." or "..", no decoding, no encoding, no merge
 * of slashes. Of a string the gate drops the fragment and splits the query at
 * the first "?". A path with no leading "/" gets one. Of a URL object the gate
 * takes `pathname` and `search`, as the framework parsed them. A router that
 * decodes "%3F" or "%23" into the path text makes "?" or "#" part of the
 * path: such a binding passes the object form `{ pathname }` (a
 * `RoutedPath`), and the gate judges `pathname` as given, with no split and no
 * drop of a fragment. The string form keeps its split, for a router whose
 * decode keeps "%3F" escaped. Each binding's
 * README states how its router decodes the path and compares the case.
 */
export async function readGate(
  options: GateOptions,
  request: Request,
  routed?: URL | RoutedPath | string,
  returnTo?: URL,
): Promise<Gate> {
  const judged = judge(request, routed);
  // One source for the base path: core's own, unless a proxy moved core's routes.
  const basePath = options.basePath ?? options.auth.basePath ?? DEFAULT_BASE_PATH;
  // Both forms: the raw path that core's router reads, and the path that the app's router matched.
  const rawCore = isAuthPath(new URL(request.url).pathname, basePath);
  const core = rawCore && isAuthPath(judged.pathname, basePath);
  // When only one form is a path of core, the gate judges a page: a session read is the worst case.
  if (core) return { session: null, redirect: null, cookie: null };
  const session = await options.auth.session(request);
  if (!session && options.signInPath && options.protect?.(judged.pathname))
    return {
      session,
      redirect: redirectBack(judged.origin, back(request, routed, returnTo), options.signInPath),
      cookie: null,
    };
  return {
    session,
    redirect: null,
    cookie: session ? options.auth.sessionCookie(request, session) : null,
  };
}
