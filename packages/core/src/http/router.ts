import { CAPTCHA_HEADER } from "../captcha.js";
import { atBase, pickBase, type ResolvedConfig } from "../config.js";
import { peekSession, resolvedUserOf, sessionCapMs } from "../engine/sessions.js";
import { ERRORS } from "../errors.js";
import { type Outcome, SIGN_IN_ROUTES, validateEvent } from "../observe/events.js";
import type { HandleOptions } from "../observe/port.js";
import { mintTrace, parseTraceparent, TRACE_HEADER } from "../observe/trace.js";
import {
  BODY_BUSY_RETRY_SECONDS,
  BodyBusy,
  BodyTimeout,
  BodyTooLarge,
  bindBodyClient,
  bindBodyRoute,
  ipBodyClient,
} from "./body-cap.js";
import { clearSessionCookie, readCookie, sessionCookie } from "./cookies.js";
import { anonymousRefusal, impersonationRefusal } from "./impersonation-rules.js";
import { ANSWER_CODE, json } from "./json.js";
import { REDIRECT_ERROR } from "./redirect.js";
import { PARAM_SEGMENT_RE } from "./route-key.js";
import {
  BODY_CODE,
  BUSY_CODE,
  HOST_CODE,
  type RouteKey,
  type RouterCode,
  TIMEOUT_CODE,
} from "./route-list.js";
import { withSessionBag } from "./session-answer.js";

export interface RouteContext {
  request: Request;
  url: URL;
  /**
   * The config of this request (plan 12h): the config of construction with
   * an observer that stamps the trace of the request on each event. A
   * handler calls the engine with it, never with the config it closes over.
   */
  config: ResolvedConfig;
  ip: string | null;
  now: Date;
  /**
   * The value of each `:<name>` segment of the route's path (plan 12d). An
   * empty object for a route with none.
   */
  params: Readonly<Record<string, string>>;
  /**
   * Keeps `work` alive after the answer (ruling 23 of plan 12i). A route
   * whose slow work differs by whether an account exists starts it here and
   * answers at once, so the answer time tells nothing. The router hands the
   * work to the `waitUntil` of the call. With none, the work runs detached.
   * A rejection never reaches the answer: it becomes one `error.internal` line.
   */
  waitUntil(work: Promise<unknown>): void;
}

/** What a route's preflight hook reads (plan 11d). */
export interface PreflightContext {
  request: Request;
  url: URL;
  /** The Origin of the preflight. It is not `baseURL` and not in `trustedOrigins`. */
  origin: string;
  ip: string | null;
  /** The config of this request, as `RouteContext.config` (plan 12h). */
  config: ResolvedConfig;
}

// The rule lives beside routeKeyOf, so the OpenAPI entry reads it without the router.
export { PARAM_SEGMENT_RE };

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /**
   * The entry of ROUTES that this route serves (plan 11g). The route list
   * test holds it to the method and the path. It is optional on the type, so
   * a test stub with a path outside ROUTES needs none (ruling 3). Every core
   * route sets it, and the route list test refuses a core route without it.
   */
  key?: RouteKey;
  /**
   * The path of the route that this one serves again (plan 12i Task 12):
   * the callback of a provider with a `redirectURI`. Its `key` is that
   * route's key. An alias is no entry of ROUTES, and the route list test
   * holds each alias to the config.
   */
  aliasOf?: string;
  /**
   * Skip the Origin check on this POST. Only for a form that another site
   * posts: Apple's `response_mode=form_post`, and the end-session request of
   * a relying party (plan 12e). The route must bind the request to the
   * browser another way. The social routes use the binding cookie and the
   * state row. The end-session route ends a session only for a valid hint of
   * it, or for a yes posted from `baseURL`.
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
function routerError(
  code: RouterCode | typeof HOST_CODE | typeof BODY_CODE | typeof BUSY_CODE | typeof TIMEOUT_CODE,
): Response {
  return json({ error: code }, ERRORS[code]);
}

/**
 * The config of the request's host (plan 12i Task 18), or null for a host
 * outside a `baseURL` list. Only `request.url` takes part, never a header.
 */
function hostConfig(config: ResolvedConfig, url: URL): ResolvedConfig | null {
  const entry = pickBase(config, url);
  return entry === null ? null : atBase(config, entry);
}

/**
 * Credentialed CORS for one trusted origin. `Vary: Origin` keeps a cache from
 * serving it to another. The router exposes the trace header (ruling 1 point
 * 11 of plan 12h). So a browser app can show the id to a person who asks for
 * support.
 */
function cors(res: Response, origin: string): Response {
  res.headers.set("access-control-allow-origin", origin);
  res.headers.set("access-control-allow-credentials", "true");
  res.headers.set("access-control-expose-headers", TRACE_HEADER);
  res.headers.append("vary", "Origin");
  return res;
}

/**
 * The error code of a redirect, or null: the mark of `authErrorRedirect` or
 * `errorRedirect`. The router reads no parameter of the Location. A client
 * chooses a sign-in `next`, and `safeNext` keeps its query. So a Location
 * can hold `auth_error` or `error` with no failure (rulings 16 and 19 of plan
 * 12h). The answer recorder of the tests reads the same rule.
 */
export function redirectCode(res: Response): string | null {
  return REDIRECT_ERROR.get(res) ?? null;
}

/**
 * The outcome of an answer (plan 12h Task 4). A redirect with the code of
 * `redirectCode` is a client error. The code is the error of a JSON answer,
 * or the code of that redirect.
 */
export function outcomeOf(res: Response): { outcome: Outcome; code: string | null } {
  const status = res.status;
  const fromBody = ANSWER_CODE.get(res) ?? null;
  if (status >= 300 && status < 400) {
    const param = redirectCode(res);
    return param === null
      ? { outcome: "redirect", code: fromBody }
      : { outcome: "client_error", code: param };
  }
  if (status >= 500) return { outcome: "server_error", code: fromBody };
  if (status === 401 || status === 403) return { outcome: "denied", code: fromBody };
  if (status === 429) return { outcome: "limited", code: fromBody };
  if (status >= 400) return { outcome: "client_error", code: fromBody };
  return { outcome: "ok", code: fromBody };
}

/** The code of an event, kept only when it passes the kind `code`. */
function eventCode(code: string | null): { code?: string } {
  if (code === null) return {};
  const kept = validateEvent("request", { code }).fields.code;
  return typeof kept === "string" ? { code: kept } : {};
}

/**
 * The answer with the trace header. Every route of core builds its own
 * Response, so the headers are mutable here, as `cors` and the cookie move
 * need them to be. A Response with immutable headers makes the set throw. So
 * each call runs inside an error boundary of the router (fix wave of plan 12h,
 * Low 5).
 */
function withTrace(res: Response, traceId: string): Response {
  res.headers.set(TRACE_HEADER, traceId);
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

/** A mounted route and the values of its parameter segments. */
export interface RouteMatch {
  route: Route;
  params: Readonly<Record<string, string>>;
}

const NO_PARAMS: Readonly<Record<string, string>> = Object.freeze({});

/** A route path with a parameter segment, split on `/` with `basePath`. */
interface ShapedRoute {
  route: Route;
  segments: readonly string[];
}

/** One path can match both: each literal pair is equal, and each literal beside a parameter fits it. */
function overlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i] ?? "";
    if (x.startsWith(":")) return y.startsWith(":") || PARAM_SEGMENT_RE.test(y);
    return y.startsWith(":") ? PARAM_SEGMENT_RE.test(x) : x === y;
  });
}

/**
 * The one route matcher of the router and of its gate (plan 12d ruling 4).
 * An exact route wins. Else a route whose path holds `:<name>` segments
 * matches a path of the same segment count. Each literal must be equal, and
 * each parameter segment must fit `PARAM_SEGMENT_RE`. The URL parser removes the
 * dot segments, so a parameter never holds `.` or `..` as a segment. Two
 * routes of one method that one path can match throw at construction.
 */
export function createRouteMatcher(
  config: ResolvedConfig,
  routes: readonly Route[],
): (method: string, pathname: string) => RouteMatch | null {
  const exact = new Map<string, Route>();
  const shaped: ShapedRoute[] = [];
  for (const route of routes) {
    const path = `${config.basePath}${route.path}`;
    const segments = path.split("/");
    const key = `${route.method} ${path}`;
    const hasParam = segments.some((s) => s.startsWith(":"));
    const clash = hasParam
      ? shaped.some((o) => o.route.method === route.method && overlap(o.segments, segments))
      : exact.has(key);
    if (clash) throw new Error(`two routes match ${route.method} ${route.path}`);
    if (hasParam) shaped.push({ route, segments });
    else exact.set(key, route);
  }
  return (method, pathname) => {
    const hit = exact.get(`${method} ${pathname}`);
    if (hit) return { route: hit, params: NO_PARAMS };
    const parts = pathname.split("/");
    for (const { route, segments } of shaped) {
      if (route.method !== method || segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const fits = segments.every((want, i) => {
        const got = parts[i] ?? "";
        if (!want.startsWith(":")) return want === got;
        params[want.slice(1)] = got;
        return PARAM_SEGMENT_RE.test(got);
      });
      if (fits) return { route, params: Object.freeze(params) };
    }
    return null;
  };
}

/** The safe methods of RFC 9110 section 9.2.1. The gate passes them, because they change nothing. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The Origin and Fetch Metadata rules of each method but `GET`, `HEAD`, and
 * `OPTIONS`, before any handler: the 403 of the router, or null.
 * `PUT`, `PATCH`, and `DELETE` get the rules of a POST (plan 12d). The gate
 * finds the route through the router's own matcher, so a parameter route
 * keeps its flags. A route with `allowCrossSiteForm` passes. An
 * Origin on a `clientOrigin` route passes to the handler (plan 11d): a
 * trusted Origin passes there as before plan 12b, and a foreign one passes
 * only as a web origin of the named client. That route reads no cookie, so
 * the Fetch Metadata rule protects nothing on it. No Origin keeps both rules.
 * A path with no core route gets both rules. So a package that serves its
 * own POST paths beside core (the Better Auth shim) checks them as core
 * does, through `crossSiteRefusal` (plan 12a fix wave, final review F1).
 * A host outside a `baseURL` list gets 421 `host_not_allowed` for each
 * method, before the rules (plan 12i Task 18). The Origin rule reads the
 * entry of the request's host.
 */
export function createPostGate(
  config: ResolvedConfig,
  routes: readonly Route[],
): (request: Request) => Response | null {
  const matchRoute = createRouteMatcher(config, routes);
  return (request) => {
    const url = new URL(request.url);
    const host = hostConfig(config, url);
    if (host === null) return routerError(HOST_CODE);
    if (SAFE_METHODS.has(request.method)) return null;
    const route = matchRoute(request.method, url.pathname)?.route;
    if (route?.allowCrossSiteForm) return null;
    const origin = request.headers.get("origin");
    if (route?.clientOrigin && origin !== null) return null;
    const trusted = origin !== null && originTrusted(host, origin);
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
 * The match is `createRouteMatcher`: the exact table, then the parameter
 * routes in mount order. A connection lives in the database, so its routes
 * cannot be mounted one per connection (plan 12d). An `OPTIONS` from a
 * trusted origin gets 204 with the CORS headers. Any other `OPTIONS` gets 403.
 * Every response to a trusted origin carries the CORS headers. The Origin
 * rule covers `POST`, `PUT`, `PATCH`, and `DELETE`: a request whose Origin
 * header is present and not trusted gets 403 before any handler runs. One
 * with no Origin is a non-browser client and passes. One that
 * `fetchMetadataRefuses` names gets the same 403 (plan 12b). A host outside a
 * `baseURL` list gets 421 `host_not_allowed` before any of this (plan 12i
 * Task 18); the request's config holds the entry of its host. A route with `clientOrigin` checks a
 * foreign Origin itself, and a route with `preflight` answers a foreign
 * preflight itself (plan 11d). An impersonation session gets 403
 * `impersonation_session` at each route of `IMPERSONATION_REFUSED`, after
 * the Origin rules and before the handler (plan 12f).
 */
export function createRouter(
  config: ResolvedConfig,
  routes: Route[],
  gate: (request: Request) => Response | null = createPostGate(config, routes),
): (request: Request, options?: HandleOptions) => Promise<Response> {
  const matchRoute = createRouteMatcher(config, routes);
  // The routes that answer a foreign origin's preflight themselves (plan 11d).
  const preflights = new Map(
    routes.filter((r) => r.preflight).map((r) => [`${config.basePath}${r.path}`, r]),
  );
  const trustTraceparent = config.observeConfig?.trustTraceparent === true;
  return async (request, options) => {
    const started = config.clock.now().getTime();
    const url = new URL(request.url);
    // An OPTIONS request names the route at its path: the POST, else the GET.
    const match =
      request.method === "OPTIONS"
        ? (matchRoute("POST", url.pathname) ?? matchRoute("GET", url.pathname))
        : matchRoute(request.method, url.pathname);
    const route = match?.route;
    const routeKey = route?.key ?? "unmatched";
    // A client id only under trustTraceparent (spec 31 item 5). An invalid or all-zero header is ignored.
    const parent = trustTraceparent ? parseTraceparent(request.headers.get("traceparent")) : null;
    const minted = mintTrace();
    const traceId = parent?.traceId ?? minted.traceId;
    // The handler's own call reads the IP again inside the error boundary, so a throw there answers 500.
    let ip: string | null = null;
    try {
      ip = config.clientIp(request);
    } catch {}
    // The entry of the request's host (plan 12i Task 18). A host outside the list runs no handler.
    const host = hostConfig(config, url);
    const scoped: ResolvedConfig = {
      ...(host ?? config),
      observe: config.observe.scope({
        traceId,
        spanId: minted.spanId,
        parentSpanId: parent?.parentSpanId ?? null,
        route: routeKey,
        ip,
        userAgent: request.headers.get("user-agent"),
      }),
    };
    // The work after the answer (ruling 23 of plan 12i). Its rejection is caught
    // here, so a detached promise never rejects with no handler.
    const waitUntil = (work: Promise<unknown>): void => {
      const kept = work.catch((e: unknown) => {
        scoped.observe.emit({
          name: "error.internal",
          method: request.method,
          route: routeKey,
          errorName: e,
        });
      });
      options?.waitUntil?.(kept);
    };
    const res =
      host === null
        ? withTrace(routerError(HOST_CODE), traceId)
        : await answer(scoped, request, url, match, traceId, waitUntil);
    const { outcome, code } = outcomeOf(res);
    // The user of the session that the handler resolved, so an operator ties a refusal to an account (plan 12n).
    const userId = resolvedUserOf(request);
    scoped.observe.emit({
      name: "request",
      method: request.method,
      status: res.status,
      outcome,
      ...eventCode(code),
      durationMs: Math.max(0, config.clock.now().getTime() - started),
      ...(userId === undefined ? {} : { userId }),
    });
    const via = route?.key === undefined ? undefined : SIGN_IN_ROUTES[route.key];
    if (
      via !== undefined &&
      request.method !== "OPTIONS" &&
      (outcome === "client_error" || outcome === "denied" || outcome === "limited")
    )
      scoped.observe.emit({
        name: "sign_in",
        method: via,
        // The provider is the third part of the path of a social route, or of the route an alias serves.
        ...(via === "social" && route
          ? { provider: (route.aliasOf ?? route.path).split("/")[2] }
          : {}),
        outcome: "failure",
        ...eventCode(code),
      });
    return res;
  };

  /** The answer of one request with the trace header, before the events. */
  async function answer(
    scoped: ResolvedConfig,
    request: Request,
    url: URL,
    match: RouteMatch | null,
    traceId: string,
    waitUntil: RouteContext["waitUntil"],
  ): Promise<Response> {
    const origin = request.headers.get("origin");
    const trusted = origin !== null && originTrusted(scoped, origin);
    if (request.method === "OPTIONS") {
      // A browser on another origin asks before a credentialed request. Only
      // a trusted origin gets an answer it can use.
      if (!trusted)
        return (
          (origin !== null && (await foreign(scoped, request, origin, traceId))) ||
          withTrace(refused(), traceId)
        );
      const preflight = cors(
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
      return withTrace(preflight, traceId);
    }
    // The one error boundary of a request (plan 11g). A throw of the handler,
    // of the bag write, of the cookie move, of the CORS write, or of the
    // trace header answers `internal` with one log line. A `BodyTooLarge` of a
    // body read answers 413 `body_too_large` (rulings 43 and 46 of the 12j lane),
    // and a `BodyBusy` 503 `body_busy` with `Retry-After` (ruling 51). A
    // `BodyTimeout` answers 408 `body_timeout` (ruling 59). The bag write of
    // multi-session (plan 12i Task 11) runs after every handler, so no
    // sign-in route can skip it.
    try {
      const res = await moveLegacyCookie(
        scoped,
        request,
        await withSessionBag(
          scoped,
          request,
          await dispatch(scoped, request, url, match, waitUntil),
        ),
      );
      return withTrace(trusted ? cors(res, origin) : res, traceId);
    } catch (e) {
      // A body past the cap of its route is the client's fault, not an error of core: 413, no log line.
      if (e instanceof BodyTooLarge) {
        const res = routerError(BODY_CODE);
        return withTrace(trusted ? cors(res, origin) : res, traceId);
      }
      // The large reads of the isolate hold their budget: a load of the moment, not an error of core.
      if (e instanceof BodyBusy) {
        const res = routerError(BUSY_CODE);
        res.headers.set("retry-after", String(BODY_BUSY_RETRY_SECONDS));
        return withTrace(trusted ? cors(res, origin) : res, traceId);
      }
      // A client that stalled its body past a deadline: its fault, not an error of core.
      if (e instanceof BodyTimeout) {
        const res = routerError(TIMEOUT_CODE);
        return withTrace(trusted ? cors(res, origin) : res, traceId);
      }
      // The route key, never the raw path: a client chooses the path (ruling 1
      // point 3 of plan 12h). The app sets the error name, so the kind filters it (plan 9c).
      scoped.observe.emit({
        name: "error.internal",
        method: request.method,
        route: match?.route.key ?? "unmatched",
        errorName: e,
      });
      const res = routerError("internal");
      return withTrace(trusted ? cors(res, origin) : res, traceId);
    }
  }

  function refused(): Response {
    return routerError("origin_not_trusted");
  }

  /** A route's own answer to a foreign preflight, or null. A throw is logged and answers 500, as in the boundary above. */
  async function foreign(
    scoped: ResolvedConfig,
    request: Request,
    origin: string,
    traceId: string,
  ): Promise<Response | null> {
    const url = new URL(request.url);
    const route = preflights.get(url.pathname);
    if (!route?.preflight) return null;
    try {
      const res = await route.preflight({
        request,
        url,
        origin,
        ip: config.clientIp(request),
        config: scoped,
      });
      return res && withTrace(res, traceId);
    } catch (e) {
      scoped.observe.emit({
        name: "error.internal",
        method: "OPTIONS",
        route: route.key ?? "unmatched",
        errorName: e,
      });
      return withTrace(routerError("internal"), traceId);
    }
  }

  async function dispatch(
    scoped: ResolvedConfig,
    request: Request,
    url: URL,
    match: RouteMatch | null,
    waitUntil: RouteContext["waitUntil"],
  ): Promise<Response> {
    if (!match) return routerError("not_found");
    const refusal = gate(request);
    if (refusal) return refusal;
    // The impersonation step (plan 12f): after the match, before the handler.
    const impersonated =
      match.route.key && (await impersonationRefusal(scoped, request, match.route.key));
    if (impersonated) return impersonated;
    // The anonymous step (plan 12i Task 6): beside the impersonation step, in its form.
    const anonymous = match.route.key && (await anonymousRefusal(scoped, request, match.route.key));
    if (anonymous) return anonymous;
    // A body read of the handler takes the cap of this route (ruling 46 of the 12j lane).
    bindBodyRoute(request, match.route.key);
    // A large read counts on the share of its client: the IP until a session names the user (ruling 59).
    const ip = config.clientIp(request);
    bindBodyClient(request, ipBodyClient(ip));
    return match.route.handler({
      request,
      url,
      config: scoped,
      ip,
      now: config.clock.now(),
      params: match.params,
      waitUntil,
    });
  }
}
