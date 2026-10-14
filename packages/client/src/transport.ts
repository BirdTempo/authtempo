import { ERRORS } from "@authtempo/core/errors";
import type { RouteMethod, RoutePath } from "@authtempo/core/routes";
import { type ClientResult, fail, failWith, ok } from "./result.js";

export interface TransportOptions {
  /** The API origin, for example `https://api.example.com`. One trailing slash is stripped. */
  baseURL: string;
  /** The mount path of the auth routes. Default `/auth`. */
  basePath?: string | undefined;
  /** The fetch to use. Default `globalThis.fetch`. Tests inject one. */
  fetch?: typeof fetch | undefined;
  /** The bearer token of a native or desktop app. A browser app leaves it out and the cookie carries the session. */
  token?: (() => string | null | Promise<string | null>) | undefined;
  /** Default `include`, so the browser sends the session cookie to the API origin. */
  credentials?: RequestCredentials | undefined;
}

/** A query, sent apart from the path: a path is a `RoutePath` and holds no `?`. */
export type Query = Readonly<Record<string, string>>;

/**
 * One call to a route of core (plan 11d). The path is a `RoutePath` of the
 * method, so a path that core does not serve fails the compile. `headers`:
 * more request headers, for example the captcha token of plan 12b.
 */
export interface Call {
  <T>(
    method: "GET",
    path: RoutePath<"GET">,
    body?: undefined,
    query?: Query,
    headers?: Readonly<Record<string, string>>,
  ): Promise<ClientResult<T>>;
  <T>(
    method: "POST",
    path: RoutePath<"POST">,
    body?: unknown,
    query?: Query,
    headers?: Readonly<Record<string, string>>,
  ): Promise<ClientResult<T>>;
}

/** The call with an untyped path: the client's own calls take their path from `CLIENT_CALLS`, whose type is checked. */
export type RawCall = <T>(
  method: RouteMethod,
  path: string,
  body?: unknown,
  query?: Query,
  headers?: Readonly<Record<string, string>>,
) => Promise<ClientResult<T>>;

function isKnownCode(code: unknown): code is keyof typeof ERRORS {
  return typeof code === "string" && Object.hasOwn(ERRORS, code);
}

/**
 * The query string with `encodeURIComponent`, so a space is `%20` as before
 * plan 11d. `URLSearchParams` would write `+`.
 */
export function searchOf(query: Query | undefined): string {
  if (!query) return "";
  const pairs = Object.entries(query).map(
    ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
  );
  return pairs.length > 0 ? `?${pairs.join("&")}` : "";
}

/** The URL of a route: `baseURL` with one trailing slash removed, `basePath`, the path, and the query. The one copy of the URL rule. */
export function routeURL(options: TransportOptions, path: string, query?: Query): string {
  // A trailing slash on baseURL would build `//auth/session`, which the router answers with 404.
  const baseURL = options.baseURL.replace(/\/$/, "");
  const basePath = options.basePath ?? "/auth";
  return `${baseURL}${basePath}${path}${searchOf(query)}`;
}

/**
 * One function behind every operation. It never throws for an answer: a
 * rejected fetch is `network`, an unreadable body is `unexpected`, and a
 * known error code passes through with its status.
 */
export function createRawTransport(options: TransportOptions): RawCall {
  const doFetch = options.fetch ?? globalThis.fetch;
  const credentials = options.credentials ?? "include";
  return async <T>(
    method: RouteMethod,
    path: string,
    body?: unknown,
    query?: Query,
    headers?: Readonly<Record<string, string>>,
  ): Promise<ClientResult<T>> => {
    const sent: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) sent["content-type"] = "application/json";
    if (headers) Object.assign(sent, headers);
    const token = options.token ? await options.token() : null;
    if (token) sent.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await doFetch(routeURL(options, path, query), {
        method,
        headers: sent,
        credentials,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      return fail("network", 0);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return fail("unexpected", res.status);
    }
    if (res.ok) return ok(parsed as T);
    const answer = parsed as { error?: unknown; message?: unknown } | null;
    const code = answer?.error;
    if (!isKnownCode(code)) return fail("unexpected", res.status);
    // Only hook_refused carries a message (plan 9d): a message on another
    // code, as from a proxy, is dropped, so ClientFailure keeps its promise.
    return code === "hook_refused" && typeof answer?.message === "string"
      ? failWith(code, res.status, answer.message)
      : fail(code, res.status);
  };
}

/** The typed call for an app's own route call. */
export function createTransport(options: TransportOptions): Call {
  const call: Call = createRawTransport(options);
  return call;
}
