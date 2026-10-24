import type { Auth, ResolvedSession } from "@authtempo/core";
import {
  type BindingWaitUntil,
  boundWaitUntil,
  checkGateOptions,
  type GateAuth,
  handleOptions,
  type RoutedPath,
  readGate,
} from "@authtempo/core/bindings";
import {
  appendResponseHeader,
  defineEventHandler,
  type EventHandler,
  getRequestProtocol,
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

export interface NuxtRouteOptions {
  /**
   * The host's hook that keeps work alive after the answer (ruling 29 of
   * plan 12i). Default: the hook of the platform that Nitro puts in the
   * event context. Not `event.waitUntil`: Nitro sets that one on every
   * host, so it does not tell a Worker with no hook.
   */
  waitUntil?: BindingWaitUntil<H3Event> | undefined;
}

/**
 * The hook of the platform. Nitro 2.13.4 copies the `waitUntil` of its
 * Cloudflare presets to `event.context.waitUntil`, and the ExecutionContext
 * to `event.context.cloudflare.context` (runtime/internal/app.mjs:48-59 and
 * presets/cloudflare/runtime/_module-handler.mjs:94-99, read 2026-10-25).
 */
function platformWaitUntil(event: H3Event): ((promise: Promise<unknown>) => void) | undefined {
  const context = event.context as {
    waitUntil?: unknown;
    cloudflare?: { context?: unknown };
  };
  if (typeof context.waitUntil === "function") return boundWaitUntil(context);
  return boundWaitUntil(context.cloudflare?.context);
}

/** The handler of `server/routes/auth/[...path].ts`: `export default authEventHandler(getAuth);`. */
export function authEventHandler(
  auth: AuthSource<Pick<Auth, "handle">>,
  options: NuxtRouteOptions = {},
): EventHandler {
  return defineEventHandler((event) =>
    resolve(auth).handle(
      toWebRequest(event),
      handleOptions(options.waitUntil, event, () => platformWaitUntil(event)),
    ),
  );
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

/** The raw request target: the path and the query as the request line wrote them. */
function rawTarget(event: H3Event): string {
  return event.node.req.originalUrl ?? event.node.req.url ?? "/";
}

/**
 * The path and the query that h3 routes, in the object form of the gate. h3
 * 1.15.11 routes the raw request target decoded once with decodeURIComponent,
 * with "%2F" and "%25" kept (_decodePath and ufo's decodePath, read
 * 2026-10-15). It does not resolve dot segments or backslashes:
 * "/account/%2e%2e" routes as "/account/.." to a child route "/account/:id".
 * So the text is decoded here the same way and is never parsed as a URL: a
 * parse would resolve "..", turn a backslash into "/", drop a tab, and judge a path
 * that h3 did not route. A bad escape stays raw, as in h3. h3 routes
 * "//account" as is, so it stays as is (probed 2026-10-15). The source is
 * originalUrl, not event.path: under a Nuxt app.baseURL, event.path loses the
 * base that core's routes keep.
 */
function routedPath(event: H3Event): RoutedPath {
  const raw = rawTarget(event);
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  const search = q === -1 ? "" : raw.slice(q);
  // The object form: h3 decodes "%3F" and "%23" into the path, so the gate
  // must not split the decoded text at "?" or drop it at "#".
  try {
    return {
      pathname: decodeURIComponent(path.replace(/%25/g, "%2525").replace(/%2F/gi, "%252F")),
      search,
    };
  } catch {
    // A bad escape: h3 keeps the raw path, so the raw path is the routed path.
    return { pathname: path, search };
  }
}

/**
 * The origin of the redirect. A web handler (toWebHandler, a Worker preset)
 * keeps the request's own URL in event.web. On Node it is the protocol of
 * h3 and the Host header, never the request target: an absolute-form line
 * "GET http://evil.example/account" names another host (plan 11d2 path probe
 * 2). A Host that does not parse as one host falls back to the origin of
 * auth.baseURL, so no request answers 500.
 */
function originOf(event: H3Event, auth: GateAuth): string {
  if (event.web?.url) return new URL(event.web.url).origin;
  const host = event.node.req.headers.host ?? "";
  const protocol = getRequestProtocol(event);
  try {
    const url = new URL(`${protocol}://${host}`);
    if (host !== "" && url.host === host.toLowerCase()) return url.origin;
  } catch {
    // Not a host: the fallback below.
  }
  return new URL(auth.baseURL ?? "http://localhost").origin;
}

/** The page URL on `origin`. A target that no URL parses gives the root, so no request answers 500. */
function pageURL(origin: string, target: string): string {
  try {
    return new URL(`${origin}${target.startsWith("/") ? "" : "/"}${target}`).href;
  } catch {
    return `${origin}/`;
  }
}

/**
 * The path that Nuxt's page router renders for the h3 text: cut at the first
 * "?", each backslash as "/", "." and ".." segments resolved, and no trailing
 * "/" (the root stays "/"). vue-router matches with or without a trailing "/"
 * (strict: false), and Nuxt's renderer parses the path as a URL, which
 * resolves "." (review 2026-10-15, M5). It works on the decoded text, not
 * through a URL parse, so no letter is encoded again: "/café/" gives "/café".
 */
function pagePath(text: string): string {
  const q = text.indexOf("?");
  const path = (q === -1 ? text : text.slice(0, q)).replace(/\\/g, "/");
  const out: string[] = [];
  for (const segment of path.split("/").slice(1)) {
    if (segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join("/")}`.replace(/\/+$/, "") || "/";
}

/**
 * Two routers read one request. h3's handlers match the decoded text, where
 * "%3F" and "%23" became "?" and "#": "/account%3F" is "/account?". Nuxt's
 * page router cuts that text at the first "?" (not at "#": "/secret/x%23y"
 * renders the page "/secret/[id]" with id "x#y", reviewed 2026-10-15), and it
 * renders the page of pagePath. So the rule runs on four forms, in this order:
 * the full text; the text cut at the first "?"; the page path; and, as an
 * extra form, the text cut at the first "#". Then each form runs in lower
 * case, because Vue Router compares in any case by default. An extra form
 * only adds a redirect, never removes one. A path needs a session when the
 * rule holds for any form, so an exact rule fails closed. The rule sees each
 * form only once.
 */
function bothForms(
  protect: ((pathname: string) => boolean) | undefined,
): ((pathname: string) => boolean) | undefined {
  if (!protect) return undefined;
  return (pathname) => {
    const forms = [pathname];
    const add = (form: string) => {
      if (!forms.includes(form)) forms.push(form);
    };
    const query = pathname.indexOf("?");
    add(query === -1 ? pathname : pathname.slice(0, query));
    const page = pagePath(pathname);
    add(page);
    const hash = pathname.indexOf("#");
    add(hash === -1 ? pathname : pathname.slice(0, hash));
    // Vue Router compares a path in any case by default (sensitive: false), so
    // each form runs in lower case too (final review, M1). toUpperCase first
    // folds more letters than toLowerCase alone; a form that no router renders
    // only adds a redirect.
    for (const form of [...forms]) add(form.toUpperCase().toLowerCase());
    return forms.some((form) => protect(form));
  };
}

/**
 * The server middleware of `server/middleware/session.ts`:
 * `export default authSessionHandler({ auth: getAuth });`. It reads the URL
 * and the headers only, never the body that a later handler needs. A request
 * to a route of core reads no session: core reads and renews it itself.
 */
export function authSessionHandler(options: NuxtAuthOptions): EventHandler {
  checkGateOptions(options);
  const protect = bothForms(options.protect);
  return defineEventHandler(async (event) => {
    const auth = resolve(options.auth);
    // The request that the gate reads the cookie of, and takes the origin and
    // next from: the raw target on the origin of originOf, with no body. A
    // target with no leading "/" (the absolute form) becomes a path of it.
    const target = rawTarget(event);
    const origin = originOf(event, auth);
    const request = new Request(pageURL(origin, target), { headers: event.headers });
    const gate = await readGate({ ...options, auth, protect }, request, routedPath(event));
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
