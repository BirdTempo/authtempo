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

/**
 * The origin of the request: the Host header, with Fastify's protocol. A Host
 * that does not parse ("a b") falls back to the origin of core's baseURL,
 * then to http://localhost, so the binding never answers a 500 of its own.
 */
function originOf(request: FastifyRequest, baseURL: string | undefined): string {
  // Fastify 5: request.host is the Host header with its port.
  for (const base of [request.host ? `${request.protocol}://${request.host}` : "", baseURL]) {
    if (!base) continue;
    try {
      return new URL(base).origin;
    } catch {
      // Not an origin: try the next one.
    }
  }
  return "http://localhost";
}

/** The full URL of the request, for core: core reads the URL itself. */
function urlOf(request: FastifyRequest, baseURL: string | undefined): string {
  return `${originOf(request, baseURL)}${targetOf(request)}`;
}

function headersOf(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

/** find-my-way's decode: one decodeURI that keeps "%25". A bad escape stays as it came. */
function decodePath(path: string): string {
  try {
    return decodeURI(path.replaceAll("%25", "%2525"));
  } catch {
    // A bad escape: the router answers 400 before any hook runs.
    return path;
  }
}

/**
 * The path that Fastify's router matches, the query, and every form that the
 * router can match for the path. The steps are the ones of find-my-way 9.10.0
 * (lib/url-sanitizer.js and Router.prototype.find, read 2026-10-15): cut at
 * the first "?" or "#" (and ";" with useSemicolonDelimiter), decode once with
 * decodeURI but keep "%25", then merge duplicate slashes
 * (ignoreDuplicateSlashes) and cut the last slash (ignoreTrailingSlash).
 *
 * The binding reads none of these options. Fastify takes each one from
 * `routerOptions` when the app set it there, else from the deprecated field
 * of the same name (buildRouterOptions of lib/route.js), and initialConfig
 * does not show that choice. So `forms` holds the path with and without each
 * step, and the hook protects a path when the rule holds for one form.
 */
function routedPath(request: FastifyRequest): { path: string; search: string; forms: string[] } {
  const target = targetOf(request);
  const end = target.slice(1).search(/[?#]/) + 1;
  const raw = end > 0 ? target.slice(0, end) : target;
  const search = end > 0 && target[end] === "?" ? (target.slice(end).split("#")[0] ?? "") : "";
  const semicolon = raw.indexOf(";", 1);
  const cuts = semicolon > 0 ? [raw, raw.slice(0, semicolon)] : [raw];
  const forms = new Set<string>();
  for (const cut of cuts) {
    const decoded = decodePath(cut);
    const merged = decoded.replace(/\/\/+/g, "/");
    for (const form of [decoded, merged]) {
      forms.add(form);
      if (form.length > 1 && form.endsWith("/")) forms.add(form.slice(0, -1));
    }
  }
  return { path: decodePath(raw), search, forms: [...forms] };
}

/** The web Request of a Fastify request of `authRoutes`: the full URL, every header, and the raw body. */
export function toWebRequest(request: FastifyRequest, baseURL?: string): Request {
  const headers = headersOf(request);
  const method = request.method.toUpperCase();
  const body = request.body;
  if (method === "GET" || method === "HEAD" || !(body instanceof Uint8Array))
    return new Request(urlOf(request, baseURL), { method, headers });
  // A copy on its own ArrayBuffer: the body type of fetch takes no shared buffer.
  return new Request(urlOf(request, baseURL), {
    method,
    headers,
    body: new Uint8Array(body),
  });
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
  auth: AuthSource<
    Pick<Auth, "handle"> & {
      readonly basePath?: string | undefined;
      readonly baseURL?: string | undefined;
    }
  >;
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
      handler: async (request, reply) => {
        const auth = resolve(options.auth);
        return sendWebResponse(reply, await auth.handle(toWebRequest(request, auth.baseURL)));
      },
    });
  };
  return plugin;
}

export interface FastifySessionOptions {
  /** `baseURL` is optional: with it, a Host header that does not parse falls back to its origin. */
  auth: AuthSource<GateAuth & { readonly baseURL?: string | undefined }>;
  /**
   * True for a path that needs a session. Needs `signInPath`. It gets the
   * path exactly as Fastify's router matched it, each other form that the
   * router can match with its options, and each form in lower case.
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
    const { path, search, forms } = routedPath(request);
    // Fail closed: the rule runs on each form that the router can match. And
    // find-my-way compares case with toLowerCase of the path when caseSensitive
    // is false, so the rule also runs on each form in lower case.
    const holds = (p: string) =>
      protect !== undefined && [p, ...forms].some((f) => protect(f) || protect(f.toLowerCase()));
    const auth = resolve(options.auth);
    const gateOptions = { ...options, auth, protect: protect && holds };
    // The gate reads the cookie and the bearer from the headers: no body.
    const gateRequest = new Request(urlOf(request, auth.baseURL), {
      headers: headersOf(request),
    });
    // The gate judges the matched path as it is: the object form (core 94bf48b)
    // has no split at "?" and no drop of "#". find-my-way keeps "%3F" and "%23"
    // escaped, so the path holds neither; the object form does not rely on it.
    const gate = await readGate(gateOptions, gateRequest, { pathname: path, search });
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
