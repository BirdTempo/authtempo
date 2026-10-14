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
 */
export async function fetchWithin(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  try {
    return await fetcher(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    const why =
      e instanceof Error && e.name === "TimeoutError" ? `no answer in ${ms / 1000} s` : "no answer";
    throw new HostError(`${init.method ?? "GET"} ${url}: ${why}`);
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A host of this machine: an http URL there is a dev server, not a deploy. */
export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname);
}

/** The base URL of a deployment: an http or https origin with no path, query, or credentials. */
export function baseOf(value: string | undefined): string {
  if (value === undefined)
    throw new UsageError("name the base URL of the deployment, such as https://api.example.com");
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new UsageError(`${value} must be an http or https origin with no path`);
  }
  if (
    (u.protocol !== "https:" && u.protocol !== "http:") ||
    u.pathname !== "/" ||
    u.search !== "" ||
    u.hash !== "" ||
    u.username !== "" ||
    u.password !== ""
  )
    throw new UsageError(`${value} must be an http or https origin with no path`);
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
