import type { ResolvedConfig } from "../config.js";

/**
 * A 302 that no cache keeps. Every auth redirect carries a secret or a
 * result. A 303 answers a form post, so the browser follows with a GET.
 */
export function redirect(location: string, status: 302 | 303 = 302): Response {
  return new Response(null, { status, headers: { location, "cache-control": "no-store" } });
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

/** The query parameter of the app URL that a browser flow failure lands on (plan 11d: the client reads it). */
export const AUTH_ERROR_PARAM = "auth_error";

export function authErrorUrl(config: ResolvedConfig, code: string): string {
  return `${config.appURL}/?${AUTH_ERROR_PARAM}=${code}`;
}

/**
 * The code of each failure redirect that carries it in an `error` parameter
 * (ruling 16 of plan 12h). The router reads it for the `request` event. The
 * `error` parameter of any other Location is no failure: a sign-in `next`
 * can hold one.
 */
export const REDIRECT_ERROR = new WeakMap<Response, string>();

/**
 * A failure redirect that names its code in an `error` parameter of
 * `location`: an authorize redirect to a registered `redirect_uri`, or the
 * form page of a core route.
 */
export function errorRedirect(location: string, code: string): Response {
  const res = redirect(location);
  REDIRECT_ERROR.set(res, code);
  return res;
}
