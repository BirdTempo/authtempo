import { Readable } from "node:stream";
import type { Auth, ResolvedSession } from "@authtempo/core";
import { checkGateOptions, type GateAuth, readGate } from "@authtempo/core/bindings";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  RequestHandler,
} from "express";

/**
 * The Express binding of authtempo (plan 11d2), for Express 5 on Node. It is
 * the one binding that imports Node: Express runs on Node's http.
 */

/** The auth instance, or a function that makes it at the first request. */
export type AuthSource<A> = A | (() => A);

function resolve<A extends object>(source: AuthSource<A>): A {
  return typeof source === "function" ? (source as () => A)() : source;
}

function urlOf(req: ExpressRequest): string {
  return `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`;
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

/** The web Request of an Express request: the full URL, every header, and the body. */
export function toWebRequest(req: ExpressRequest): Request {
  const headers = headersOf(req);
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return new Request(urlOf(req), { method, headers });
  const parsed = parsedBody(req, headers);
  if (parsed !== null) {
    // The parser read the stream; the length of the text written again can differ.
    headers.delete("content-length");
    return new Request(urlOf(req), { method, headers, body: parsed });
  }
  return new Request(urlOf(req), {
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
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** The handler of the routes of core: `app.use("/auth", authHandler(auth))`. */
export function authHandler(auth: AuthSource<Pick<Auth, "handle">>): RequestHandler {
  return async (req, res) => {
    await sendWebResponse(res, await resolve(auth).handle(toWebRequest(req)));
  };
}

export interface ExpressSessionOptions {
  auth: AuthSource<GateAuth>;
  /** True for a path that needs a session. Needs `signInPath`. */
  protect?: ((pathname: string) => boolean) | undefined;
  /** The sign-in page. The middleware adds `?next=<path and query>`. */
  signInPath?: string | undefined;
  /** The `basePath` of core. Default "/auth". */
  basePath?: string | undefined;
}

/**
 * Sets `res.locals.session` for every request except the routes of core,
 * sends a person with no session on a protected path to the sign-in page, and
 * adds the renewed cookie to the answer.
 */
export function authSession(options: ExpressSessionOptions): RequestHandler {
  checkGateOptions(options);
  return async (req, res, next) => {
    // The gate reads the URL and the headers only: no body.
    const request = new Request(urlOf(req), { headers: headersOf(req) });
    const gate = await readGate({ ...options, auth: resolve(options.auth) }, request);
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
