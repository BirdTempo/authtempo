import { Readable } from "node:stream";
import type { Auth, ResolvedSession } from "@authtempo/core";
import { checkGateOptions, type GateAuth, readGate } from "@authtempo/core/bindings";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  RequestHandler,
} from "express";
import parseurl from "parseurl";

/**
 * The Express binding of authtempo (plan 11d2), for Express 5 on Node. It is
 * the one binding that imports Node: Express runs on Node's http.
 */

/** The auth instance, or a function that makes it at the first request. */
export type AuthSource<A> = A | (() => A);

function resolve<A extends object>(source: AuthSource<A>): A {
  return typeof source === "function" ? (source as () => A)() : source;
}

/**
 * The raw path and query of the request line, read by parseurl, the parser of
 * Express's router: one text for the binding and the router. No resolution of
 * "." or "..", no decode. A line in absolute form ("GET http://other.example/account")
 * gives its path only, so the origin of a URL of the binding is always the
 * app's. "//account" stays a path, not a host. A target that is not a path,
 * such as "*", is judged as "/", and the router matches no route for it.
 * No test sends a line such as "GET http://evil.example\account/7" or
 * "GET http:/account": Node refuses these request lines with 400 before Express
 * runs, and parseurl keeps the binding and the router on one text, so such a
 * test guards no promise (review-11d2-task3, l7).
 */
function pathOf(req: ExpressRequest): string {
  const path = parseurl.original(req)?.path ?? "/";
  return path.startsWith("/") ? path : "/";
}

/** The part of the auth object that gives the fallback origin. */
type BaseURLSource = { readonly baseURL?: string | undefined };

/**
 * The app's own origin: the protocol and the Host header. A Host header that
 * does not parse ("a b") falls back to the origin of `auth.baseURL`, then to
 * "http://localhost", so a bad Host gets no 500 from the binding.
 */
function originOf(req: ExpressRequest, auth: BaseURLSource): string {
  try {
    return new URL(`${req.protocol}://${req.get("host") ?? "localhost"}`).origin;
  } catch {
    return auth.baseURL ? new URL(auth.baseURL).origin : "http://localhost";
  }
}

/** The URL on the app's own origin, with the raw path of the request line. */
function urlOf(req: ExpressRequest, auth: BaseURLSource): string {
  return `${originOf(req, auth)}${pathOf(req)}`;
}

/**
 * The forms of a path that `protect` tests. Express matches without case by
 * default, on the app and on each Router, and the hex digits of an escape
 * too: the path, its lower case, and its lower case with upper-case hex.
 */
function caseForms(path: string): string[] {
  const lower = path.toLowerCase();
  return [path, lower, lower.replace(/%[0-9a-f]{2}/g, (m) => m.toUpperCase())];
}

function headersOf(req: ExpressRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

/**
 * The body again in its content type, when a parser of Express ran first.
 * Express 5 leaves req.body undefined until a parser runs.
 */
function parsedBody(req: ExpressRequest, headers: Headers): string | null {
  const body: unknown = req.body;
  if (body === undefined) return null;
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if ((headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded"))
    return new URLSearchParams(body as Record<string, string>).toString();
  return JSON.stringify(body);
}

/**
 * The web Request of an Express request: the full URL, every header, and the
 * body. `auth.baseURL` gives the origin when the Host header does not parse.
 */
export function toWebRequest(req: ExpressRequest, auth: BaseURLSource = {}): Request {
  const headers = headersOf(req);
  const method = req.method.toUpperCase();
  const url = urlOf(req, auth);
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  const parsed = parsedBody(req, headers);
  if (parsed !== null) {
    // The parser read the stream; the length of the text written again can differ.
    headers.delete("content-length");
    return new Request(url, { method, headers, body: parsed });
  }
  return new Request(url, {
    method,
    headers,
    // node:stream/web's ReadableStream and the global one are one class at run time.
    body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
    duplex: "half",
  } as RequestInit);
}

/** Writes a web Response to Express: the status, every header, each Set-Cookie line, and the body. */
export async function sendWebResponse(res: ExpressResponse, response: Response): Promise<void> {
  res.status(response.status);
  for (const [name, value] of response.headers)
    if (name !== "set-cookie") res.setHeader(name, value);
  // Append each line: a Set-Cookie line of an earlier middleware stays on the answer.
  for (const cookie of response.headers.getSetCookie()) res.append("set-cookie", cookie);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** The handler of the routes of core: `app.use("/auth", authHandler(auth))`. */
export function authHandler(
  auth: AuthSource<Pick<Auth, "handle"> & BaseURLSource>,
): RequestHandler {
  return async (req, res) => {
    const instance = resolve(auth);
    await sendWebResponse(res, await instance.handle(toWebRequest(req, instance)));
  };
}

export interface ExpressSessionOptions {
  /** `baseURL` gives the origin when the Host header does not parse. */
  auth: AuthSource<GateAuth & BaseURLSource>;
  /** True for a path that needs a session. Needs `signInPath`. */
  protect?: ((pathname: string) => boolean) | undefined;
  /** The sign-in page. The middleware adds `?next=<path and query>`. */
  signInPath?: string | undefined;
  /** The base path of core's routes. Default: the base path of the auth object, then "/auth". */
  basePath?: string | undefined;
}

/**
 * Sets `res.locals.session` for every request except the routes of core,
 * sends a person with no session on a protected path to the sign-in page, and
 * adds the renewed cookie to the answer.
 */
export function authSession(options: ExpressSessionOptions): RequestHandler {
  checkGateOptions(options);
  const protect = options.protect;
  return async (req, res, next) => {
    // The gate reads the URL and the headers only: no body.
    const auth = resolve(options.auth);
    const request = new Request(urlOf(req, auth), { headers: headersOf(req) });
    // The routed text: Express's router matches the raw path of the request line, with
    // no decode. It matches without case by default, so the gate fails closed: a path
    // is protected when any of its case forms is.
    const gate = await readGate(
      {
        ...options,
        protect: protect && ((p: string) => caseForms(p).some((form) => protect(form))),
        auth,
      },
      request,
      pathOf(req),
    );
    const location = gate.redirect?.headers.get("location");
    if (location) {
      res.redirect(307, location);
      return;
    }
    res.locals.session = gate.session;
    if (gate.cookie) res.append("set-cookie", gate.cookie);
    next();
  };
}

/** The session that `authSession` set, or null. */
export function getSession(res: ExpressResponse): ResolvedSession | null {
  return (res.locals.session as ResolvedSession | null | undefined) ?? null;
}
