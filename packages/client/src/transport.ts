import { ERRORS } from "@tempo-auth/core/errors";
import { type ClientResult, fail, ok } from "./result.js";

export interface TransportOptions {
  /** The API origin, for example `https://api.example.com`. No trailing slash. */
  baseURL: string;
  /** The mount path of the auth routes. Default `/auth`. */
  basePath?: string;
  /** The fetch to use. Default `globalThis.fetch`. Tests inject one. */
  fetch?: typeof fetch;
  /** The bearer token of a native or desktop app. A browser app leaves it out and the cookie carries the session. */
  token?: () => string | null | Promise<string | null>;
  /** Default `include`, so the browser sends the session cookie to the API origin. */
  credentials?: RequestCredentials;
}

export type Call = <T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Promise<ClientResult<T>>;

function isKnownCode(code: unknown): code is keyof typeof ERRORS {
  return typeof code === "string" && Object.hasOwn(ERRORS, code);
}

/**
 * One function behind every operation. It never throws for an answer: a
 * rejected fetch is `network`, an unreadable body is `unexpected`, and a
 * known error code passes through with its status.
 */
export function createTransport(options: TransportOptions): Call {
  const basePath = options.basePath ?? "/auth";
  const doFetch = options.fetch ?? globalThis.fetch;
  const credentials = options.credentials ?? "include";
  return async <T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<ClientResult<T>> => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const token = options.token ? await options.token() : null;
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await doFetch(`${options.baseURL}${basePath}${path}`, {
        method,
        headers,
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
    const code = (parsed as { error?: unknown } | null)?.error;
    return isKnownCode(code) ? fail(code, res.status) : fail("unexpected", res.status);
  };
}
