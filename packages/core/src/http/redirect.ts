import type { ResolvedConfig } from "../config.js";

/** A 302 that no cache keeps. Every auth redirect carries a secret or a result. */
export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

/**
 * The absolute URL a browser lands on after a sign-in. An app path goes
 * to `appURL`. A path under `basePath` stays on `baseURL`: that is how a
 * pending handoff rides through every sign-in method as a plain `next`.
 */
export function resolveNext(config: ResolvedConfig, next: string): string {
  const base = next.startsWith(`${config.basePath}/`) ? config.baseURL : config.appURL;
  return `${base}${next}`;
}

export function authErrorUrl(config: ResolvedConfig, code: string): string {
  return `${config.appURL}/?auth_error=${code}`;
}
