import { Stop, UsageError } from "./errors.js";

/** The fetch of a command or of a test. This file imports no Node.js module: src/checks.ts runs in workerd. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** A host that gives no HTTP answer in time: a stop, never a check result (spec 19). */
export class HostError extends Stop {
  constructor(message: string) {
    super(message);
    this.name = "HostError";
  }
}

/**
 * A request with a time limit. A network failure or a timeout throws a
 * HostError that names the method and the URL. The cause's message is not
 * printed: a driver or a proxy can echo a header in it.
 *
 * The request follows no redirect (review of plan 11c Task 3): a 307 to
 * another origin would let the other origin answer for the deployment. A
 * 3xx answer is a stop that names the status. `redirect: "manual"` gives the
 * 3xx answer in Node.js; a runtime that hides it gives an "opaqueredirect"
 * answer, which stops the same way.
 */
export async function fetchWithin(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetcher(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(ms) });
  } catch (e) {
    const why =
      e instanceof Error && e.name === "TimeoutError" ? `no answer in ${ms / 1000} s` : "no answer";
    throw new HostError(`${init.method ?? "GET"} ${url}: ${why}`);
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400))
    throw new HostError(
      `${init.method ?? "GET"} ${url} answered ${res.status}, a redirect: the CLI follows no redirect`,
    );
  return res;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A host of this machine: an http URL there is a dev server, not a deploy. */
export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname);
}

/**
 * A URL as a usage line may show it: the user part, with its password,
 * becomes *** (spec 19 item 5). A regex and not the URL parser, because the
 * line also names a value that does not parse.
 */
export function withoutCredentials(value: string): string {
  return value.replace(/^((?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/)?[^/?#]*@/, "$1***@");
}

/**
 * The base URL of a deployment: an https origin with no path, query, or
 * credentials. http is for a host of this machine only (review of plan 11c
 * Task 3): a command sends a secret to this origin, and plain http to another
 * host shows the secret to every network on the way. `allowHttp` is for
 * `check` only (review of plan 11c Task 8): it sends no secret, and it
 * reports a remote http base as the failure `base_not_https` (exit 1), so a
 * person sees the fault as a check result and not as a usage error.
 */
export function baseOf(value: string | undefined, o: { allowHttp?: boolean } = {}): string {
  if (value === undefined)
    throw new UsageError("name the base URL of the deployment, such as https://api.example.com");
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new UsageError(
      `${withoutCredentials(value)} must be an http or https origin with no path`,
    );
  }
  if (
    (u.protocol !== "https:" && u.protocol !== "http:") ||
    u.pathname !== "/" ||
    u.search !== "" ||
    u.hash !== "" ||
    u.username !== "" ||
    u.password !== ""
  )
    throw new UsageError(
      `${withoutCredentials(value)} must be an http or https origin with no path`,
    );
  if (u.protocol === "http:" && !isLocalHost(u.hostname) && o.allowHttp !== true)
    throw new UsageError(
      `${withoutCredentials(value)} must use https: http is for localhost, 127.0.0.1, or [::1] only`,
    );
  return u.origin;
}

/** `--base-path`: the `basePath` of the deployment, `/auth` by default, with the rule of core's config. */
export function basePathOf(value: string | undefined): string {
  const v = value ?? "/auth";
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(v) || v.endsWith("/"))
    throw new UsageError(
      "--base-path starts with / and does not end with /, as basePath in the config",
    );
  return v;
}

/** `--timeout`: whole seconds from 1 to 120, 10 by default (spec 19). Answers milliseconds. */
export function timeoutOf(value: string | undefined): number {
  if (value === undefined) return 10_000;
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1 || n > 120)
    throw new UsageError("--timeout is a whole number of seconds from 1 to 120");
  return n * 1000;
}
