import { CAPTCHA_HEADER } from "../captcha.js";
import type { ResolvedConfig } from "../config.js";
import { peekSession, sessionCapMs } from "../engine/sessions.js";
import { ERRORS } from "../errors.js";
import { appErrorName } from "../primitives/app-error.js";
import { clearSessionCookie, readCookie, sessionCookie } from "./cookies.js";
import { json } from "./json.js";
import type { RouterCode } from "./route-list.js";

export interface RouteContext {
  request: Request;
  url: URL;
  config: ResolvedConfig;
  ip: string | null;
  now: Date;
}

/** What a route's preflight hook reads (plan 11d). */
export interface PreflightContext {
  request: Request;
  url: URL;
  /** The Origin of the preflight. It is not `baseURL` and not in `trustedOrigins`. */
  origin: string;
  ip: string | null;
}

export interface Route {
  method: "GET" | "POST";
  path: string;
  /**
   * Skip the Origin check on this POST. Only for a callback that a provider
   * posts cross-site, such as Apple's `response_mode=form_post`. The route
   * must bind the request to the browser another way; the social routes use
   * the binding cookie and the state row.
   */
  allowCrossSiteForm?: boolean;
  /**
   * The handler checks the Origin itself (plan 11d). The router passes a
   * POST with an Origin past the Origin rule and the Fetch Metadata rule. A
   * trusted Origin gets the router's credentialed CORS. A foreign Origin
   * passes only as an origin of the client that the request names, with
   * CORS and no credentials. A POST with no Origin keeps both rules. Only
   * `POST /oauth/token` sets it: it reads no cookie, so a cross-site post
   * carries no ambient authority, and PKCE binds each code to its verifier.
   */
  clientOrigin?: boolean;
  /**
   * The answer to a preflight from a foreign origin (plan 11d), or null for
   * the 403 of the router. Only `POST /oauth/token` sets it.
   */
  preflight?(ctx: PreflightContext): Promise<Response | null>;
  handler(ctx: RouteContext): Promise<Response>;
}

/** The origin is `baseURL` or in `trustedOrigins`: it gets credentialed CORS. */
export function originTrusted(config: ResolvedConfig, origin: string): boolean {
  if (origin === config.baseURL) return true;
  return config.trustedOrigins.has(origin);
}

/**
 * A body that a page of another site can post with no CORS preflight: a
 * form, multipart, text/plain, or no type (the Fetch standard's safelisted
 * `content-type` values). JSON needs a preflight, which only a trusted
 * origin passes.
 */
function isJsonBody(request: Request): boolean {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  return type === "application/json";
}

/**
 * The Fetch Metadata rule (plan 12b), beside the Origin rule. A form post is
 * refused unless the browser says it came from this origin. A JSON post is
 * refused from another site unless its Origin is trusted. A request with no
 * `Sec-Fetch-Site` passes: an older browser, or a client that is not a browser.
 */
export function fetchMetadataRefuses(request: Request, originTrusted: boolean): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === null) return false;
  if (!isJsonBody(request)) return site !== "same-origin" && site !== "none";
  return (site === "cross-site" || site === "same-site") && !originTrusted;
}

/** One answer of the router itself (plan 11g): the code with its status from `ERRORS`. */
function routerError(code: RouterCode): Response {
  return json({ error: code }, ERRORS[code]);
}

/** Credentialed CORS for one trusted origin. `Vary: Origin` keeps a cache from serving it to another. */
function cors(res: Response, origin: string): Response {
  res.headers.set("access-control-allow-origin", origin);
  res.headers.set("access-control-allow-credentials", "true");
  res.headers.append("vary", "Origin");
  return res;
}

/**
 * The one-release move of the old session cookie (plan 12b). A request that
 * carries `tempo_session` and no `__Host-tempo_session` gets the new cookie
 * with the same token, unless the handler set it, and a clear of the old
 * one. A dead token gets the clear only. One read of the session row, once
 * per browser. Every route core ships builds its own Response, so the
 * headers are mutable here. A route must not return a fetched Response or a
 * `Response.redirect()` Response: their headers are immutable, and the
 * append here throws.
 */
async function moveLegacyCookie(
  config: ResolvedConfig,
  request: Request,
  res: Response,
): Promise<Response> {
  const legacy = config.legacyCookieName;
  if (legacy === null) return res;
  const old = readCookie(request, legacy);
  if (old === null || readCookie(request, config.cookieName) !== null) return res;
  const sets = res.headers.getSetCookie();
  if (!sets.some((c) => c.startsWith(`${config.cookieName}=`))) {
    const row = await peekSession(config, old);
    if (row) {
      // The earlier of expiresAt and the cap: a row from before absoluteDays
      // was set can hold an expiresAt past the cap.
      const end = Math.min(row.expiresAt.getTime(), sessionCapMs(config, row.createdAt));
      const seconds = Math.floor((end - config.clock.now().getTime()) / 1000);
      res.headers.append(
        "set-cookie",
        sessionCookie(config.cookieName, old, Math.max(0, seconds), config.cookie.sameSite),
      );
    }
  }
  // Sign-out clears the old name itself; one clear is enough.
  if (!sets.some((c) => c.startsWith(`${legacy}=`)))
    res.headers.append("set-cookie", clearSessionCookie(legacy, config.cookie.sameSite));
  return res;
}

/**
 * The Origin and Fetch Metadata rules of a POST, before any handler: the 403
 * of the router, or null. A route with `allowCrossSiteForm` passes. An
 * Origin on a `clientOrigin` route passes to the handler (plan 11d): a
 * trusted Origin passes there as before plan 12b, and a foreign one passes
 * only as a web origin of the named client. That route reads no cookie, so
 * the Fetch Metadata rule protects nothing on it. No Origin keeps both rules.
 * A path with no core route gets both rules. So a package that serves its
 * own POST paths beside core (the Better Auth shim) checks them as core
 * does, through `crossSiteRefusal` (plan 12a fix wave, final review F1).
 */
export function createPostGate(
  config: ResolvedConfig,
  routes: readonly Route[],
): (request: Request) => Response | null {
  const posts = new Map(
    routes.filter((r) => r.method === "POST").map((r) => [`${config.basePath}${r.path}`, r]),
  );
  return (request) => {
    if (request.method !== "POST") return null;
    const route = posts.get(new URL(request.url).pathname);
    if (route?.allowCrossSiteForm) return null;
    const origin = request.headers.get("origin");
    if (route?.clientOrigin && origin !== null) return null;
    const trusted = origin !== null && originTrusted(config, origin);
    if (origin !== null && !trusted) return routerError("origin_not_trusted");
    if (fetchMetadataRefuses(request, trusted)) return routerError("origin_not_trusted");
    return null;
  };
}

/**
 * The client IP comes from `config.clientIp`. On Workers the platform sets
 * `cf-connecting-ip`, and the default reads it. On any other host a caller
 * can set that header, so a deployment there must pass its own `clientIp`
 * that reads the trusted proxy header. A null IP counts against one shared
 * IP bucket in the magic link limit, which fails closed.
 *
 * Exact match on method and `basePath + route.path`. An `OPTIONS` from a
 * trusted origin gets 204 with the CORS headers. Any other `OPTIONS` gets 403.
 * Every response to a trusted origin carries the CORS headers. The POST
 * Origin rule is unchanged: a POST whose Origin header is present and not
 * trusted gets 403 before any handler runs. A POST with no Origin is a
 * non-browser client and passes. A POST that `fetchMetadataRefuses` names
 * gets the same 403 (plan 12b). A route with `clientOrigin` checks a
 * foreign Origin itself, and a route with `preflight` answers a foreign
 * preflight itself (plan 11d).
 */
export function createRouter(
  config: ResolvedConfig,
  routes: Route[],
  gate: (request: Request) => Response | null = createPostGate(config, routes),
): (request: Request) => Promise<Response> {
  const table = new Map(routes.map((r) => [`${r.method} ${config.basePath}${r.path}`, r]));
  // The routes that answer a foreign origin's preflight themselves (plan 11d).
  const preflights = new Map(
    routes.filter((r) => r.preflight).map((r) => [`${config.basePath}${r.path}`, r]),
  );
  return async (request) => {
    const origin = request.headers.get("origin");
    const trusted = origin !== null && originTrusted(config, origin);
    if (request.method === "OPTIONS") {
      // A browser on another origin asks before a credentialed request. Only
      // a trusted origin gets an answer it can use.
      if (!trusted) return (origin !== null && (await foreign(request, origin))) || refused();
      return cors(
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-methods": "GET, POST",
            // CAPTCHA_HEADER: the captcha token of plan 12b, from a trusted app origin.
            "access-control-allow-headers": `content-type, authorization, ${CAPTCHA_HEADER}`,
            "access-control-max-age": "600",
          },
        }),
        origin,
      );
    }
    const res = await moveLegacyCookie(config, request, await dispatch(request));
    return trusted ? cors(res, origin) : res;
  };

  function refused(): Response {
    return routerError("origin_not_trusted");
  }

  /** A route's own answer to a foreign preflight, or null. A throw is logged and answers 500, as in dispatch. */
  async function foreign(request: Request, origin: string): Promise<Response | null> {
    const url = new URL(request.url);
    const route = preflights.get(url.pathname);
    if (!route?.preflight) return null;
    try {
      return await route.preflight({ request, url, origin, ip: config.clientIp(request) });
    } catch (e) {
      console.error(
        "authtempo: unhandled error",
        "OPTIONS",
        route.path,
        // The app sets the name, so it can hold a code or a token (plan 9c).
        appErrorName(e),
      );
      return routerError("internal");
    }
  }

  async function dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = table.get(`${request.method} ${url.pathname}`);
    if (!route) return routerError("not_found");
    const refusal = gate(request);
    if (refusal) return refusal;
    return run(route, request, url);
  }

  async function run(route: Route, request: Request, url: URL): Promise<Response> {
    try {
      return await route.handler({
        request,
        url,
        config,
        ip: config.clientIp(request),
        now: config.clock.now(),
      });
    } catch (e) {
      console.error(
        "authtempo: unhandled error",
        route.method,
        route.path,
        // The app sets the name, so it can hold a code or a token (plan 9c).
        appErrorName(e),
      );
      return routerError("internal");
    }
  }
}
