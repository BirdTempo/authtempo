import type { Auth, ResolvedSession } from "@authtempo/core";
import {
  checkGateOptions,
  DEFAULT_BASE_PATH,
  type GateAuth,
  readGate,
} from "@authtempo/core/bindings";
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
} from "fastify";

/**
 * The Fastify binding of authtempo (plan 11d2), for Fastify 5 on Node.
 * `authRoutes` mounts core; `authSession` reads the session in an onRequest hook.
 */

declare module "fastify" {
  interface FastifyRequest {
    /** The session that `authSession` read, or null. Not `session`: @fastify/session owns that name. */
    authSession: ResolvedSession | null;
  }
}

/** The auth instance, or a function that makes it at the first request. */
export type AuthSource<A> = A | (() => A);

function resolve<A extends object>(source: AuthSource<A>): A {
  return typeof source === "function" ? (source as () => A)() : source;
}

/** The request target with no scheme and host: find-my-way routes the path of an absolute-form target. */
function targetOf(request: FastifyRequest): string {
  const url = request.url;
  if (url.startsWith("/")) return url;
  const rest = /^https?:\/\/[^/?#]*(.*)$/is.exec(url)?.[1] ?? url;
  return rest.startsWith("/") ? rest : `/${rest}`;
}

function originOf(request: FastifyRequest): string {
  // Fastify 5: request.host is the Host header with its port.
  return `${request.protocol}://${request.host || "localhost"}`;
}

/** The full URL of the request, for core: core reads the URL itself. */
function urlOf(request: FastifyRequest): string {
  return `${originOf(request)}${targetOf(request)}`;
}

function headersOf(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

interface RouterOptions {
  ignoreTrailingSlash?: boolean | undefined;
  ignoreDuplicateSlashes?: boolean | undefined;
  useSemicolonDelimiter?: boolean | undefined;
}

/**
 * The router options in force. Fastify 5.12.5 takes each one from
 * `routerOptions`, then from the deprecated field of the same name
 * (buildRouterOptions of lib/route.js). The type of `routerOptions` lacks
 * `useSemicolonDelimiter`, so the binding names the three fields it reads.
 * The binding does not read `caseSensitive`: it folds case itself (see authSession).
 */
function routerOptionsOf(request: FastifyRequest): RouterOptions {
  const config = request.server.initialConfig;
  const own: RouterOptions = config.routerOptions ?? {};
  return {
    ignoreTrailingSlash: own.ignoreTrailingSlash ?? config.ignoreTrailingSlash,
    ignoreDuplicateSlashes: own.ignoreDuplicateSlashes ?? config.ignoreDuplicateSlashes,
    useSemicolonDelimiter: own.useSemicolonDelimiter ?? config.useSemicolonDelimiter,
  };
}

/**
 * The path that Fastify's router matches, and the query. The steps are the
 * ones of find-my-way 9.10.0 (lib/url-sanitizer.js and Router.prototype.find,
 * read 2026-10-15): cut at the first "?" or "#" (and ";" with
 * useSemicolonDelimiter), decode once with decodeURI but keep "%25", then
 * apply ignoreDuplicateSlashes and ignoreTrailingSlash. The case stays as it came.
 * A bad escape stays as it came: the router answers 400 before any hook runs.
 */
function routedPath(request: FastifyRequest): { path: string; search: string } {
  const options = routerOptionsOf(request);
  const target = targetOf(request);
  const cut = options.useSemicolonDelimiter ? /[?#;]/ : /[?#]/;
  const end = target.slice(1).search(cut) + 1;
  let path = end > 0 ? target.slice(0, end) : target;
  const search = end > 0 && target[end] === "?" ? (target.slice(end).split("#")[0] ?? "") : "";
  try {
    path = decodeURI(path.replaceAll("%25", "%2525"));
  } catch {
    // A bad escape: the router does not route it.
  }
  if (options.ignoreDuplicateSlashes) path = path.replace(/\/\/+/g, "/");
  if (options.ignoreTrailingSlash && path.length > 1 && path.endsWith("/"))
    path = path.slice(0, -1);
  return { path, search };
}

/**
 * The routed path and query, as text for the third argument of readGate.
 * The gate parses it as a URL, and a URL parser changes a path that
 * find-my-way keeps as it is: it drops a "." or ".." segment, reads "\" as
 * "/", reads "%2e" as ".", and drops a tab. "/account/.." runs the route
 * "/account/:tab", and "/account/x\..\..\auth" runs "/account/*". So each
 * segment is escaped with encodeURIComponent, and each dot of a dot segment
 * is escaped twice: the parser then changes nothing. `protect` gets the
 * routed path itself (see authSession).
 */
function gateTarget(path: string, search: string): string {
  const kept = path
    .split("/")
    .map((segment) =>
      segment === "." || segment === ".."
        ? segment.replaceAll(".", "%252E")
        : encodeURIComponent(segment),
    )
    .join("/");
  return `${kept}${search}`;
}

/** The web Request of a Fastify request of `authRoutes`: the full URL, every header, and the raw body. */
export function toWebRequest(request: FastifyRequest): Request {
  const headers = headersOf(request);
  const method = request.method.toUpperCase();
  const body = request.body;
  if (method === "GET" || method === "HEAD" || !(body instanceof Uint8Array))
    return new Request(urlOf(request), { method, headers });
  // A copy on its own ArrayBuffer: the body type of fetch takes no shared buffer.
  return new Request(urlOf(request), { method, headers, body: new Uint8Array(body) });
}

/** Writes a web Response to Fastify: the status, every header, each Set-Cookie line, and the body. */
export async function sendWebResponse(
  reply: FastifyReply,
  response: Response,
): Promise<FastifyReply> {
  reply.code(response.status);
  for (const [name, value] of response.headers)
    if (name !== "set-cookie") reply.header(name, value);
  // reply.header adds each Set-Cookie line: a line of an earlier hook stays on the answer.
  for (const cookie of response.headers.getSetCookie()) reply.header("set-cookie", cookie);
  return reply.send(Buffer.from(await response.arrayBuffer()));
}

export interface FastifyRoutesOptions {
  auth: AuthSource<Pick<Auth, "handle"> & { readonly basePath?: string | undefined }>;
  /**
   * The base path of core's routes. Default: the base path of the auth
   * object, then "/auth". The route is made at registration: with a function
   * in `auth`, the default is "/auth", so set `basePath` for another one.
   */
  basePath?: string | undefined;
}

/**
 * The routes of core: `await app.register(authRoutes({ auth }))`. In the
 * plugin's own scope no parser of Fastify runs, so core reads the body as it came.
 */
export function authRoutes(options: FastifyRoutesOptions): FastifyPluginAsync {
  checkGateOptions({ basePath: options.basePath });
  const own = typeof options.auth === "function" ? undefined : options.auth.basePath;
  const basePath = options.basePath ?? own ?? DEFAULT_BASE_PATH;
  const plugin: FastifyPluginAsync = async (instance) => {
    instance.removeAllContentTypeParsers();
    instance.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body),
    );
    instance.route({
      method: ["GET", "POST", "OPTIONS"],
      url: `${basePath}/*`,
      handler: async (request, reply) =>
        sendWebResponse(reply, await resolve(options.auth).handle(toWebRequest(request))),
    });
  };
  return plugin;
}

export interface FastifySessionOptions {
  auth: AuthSource<GateAuth>;
  /**
   * True for a path that needs a session. Needs `signInPath`. It gets the
   * path that Fastify's router matches: decoded once, with the router's options.
   */
  protect?: ((pathname: string) => boolean) | undefined;
  /** The sign-in page. The hook adds `?next=<path and query>`. */
  signInPath?: string | undefined;
  /** The base path of core's routes. Default: the base path of the auth object, then "/auth". */
  basePath?: string | undefined;
}

/**
 * The onRequest hook: `app.addHook("onRequest", authSession({ auth }))`. It
 * sets `request.authSession`, sends a person with no session on a protected
 * path to the sign-in page, and adds the renewed cookie to the answer.
 */
export function authSession(options: FastifySessionOptions): onRequestAsyncHookHandler {
  checkGateOptions(options);
  const { protect } = options;
  return async (request, reply) => {
    const { path, search } = routedPath(request);
    // The rule sees the routed path as it is, with no step of the URL parser.
    // It also sees the path in lower case, so the gate fails closed when the
    // router ignores case (caseSensitive: false). `next` keeps the request's case.
    const gateOptions = {
      ...options,
      auth: resolve(options.auth),
      protect: protect && (() => protect(path) || protect(path.toLowerCase())),
    };
    // The gate reads the cookie and the bearer from the headers: no body.
    const gateRequest = new Request(urlOf(request), { headers: headersOf(request) });
    // The gate judges the routed path, not the raw URL (readGate's third argument).
    const gate = await readGate(gateOptions, gateRequest, gateTarget(path, search));
    const location = gate.redirect?.headers.get("location");
    if (location) return reply.redirect(location, 307);
    request.authSession = gate.session;
    if (gate.cookie) reply.header("set-cookie", gate.cookie);
    return undefined;
  };
}

/** The session that `authSession` set, or null. */
export function getSession(request: FastifyRequest): ResolvedSession | null {
  return request.authSession ?? null;
}
