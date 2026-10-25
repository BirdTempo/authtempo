import type { ResolvedSession } from "@authtempo/core";
import {
  type BindingWaitUntil,
  boundWaitUntil,
  checkGateOptions,
  DEFAULT_BASE_PATH,
  type GateAuth,
  handleOptions,
  isAuthPath,
  readGate,
  withSetCookie,
} from "@authtempo/core/bindings";
// SvelteKit 3.0.1 declares Handle in the hooks module only (types/index.d.ts, read 2026-10-15).
import type { Handle } from "@sveltejs/kit/hooks";

type RequestEvent = Parameters<Handle>[0]["event"];

/**
 * The SvelteKit binding of authtempo (plan 11d2). One `handle` hook mounts
 * core and reads the session. It imports nothing of SvelteKit at run time.
 */

declare global {
  namespace App {
    interface Locals {
      /** The session that `authHandle` read, or null. `locals.session` in a load or an action. */
      session: ResolvedSession | null;
    }
  }
}

/** The auth instance, or a function that makes it at the first request (so `vite build` reads no secret). */
export type AuthSource<A> = A | (() => A);

function resolveAuth<A extends object>(source: AuthSource<A>): A {
  return typeof source === "function" ? (source as () => A)() : source;
}

/**
 * The path as the router of SvelteKit 3.0.1 matches it (`decode_pathname` of
 * `src/utils/url.js`): `decodeURI` once on each part between "%25", so "%25"
 * and "%2F" stay escaped. A bad escape keeps the raw path; Kit answers that
 * request 400 with no page.
 */
function kitPath(pathname: string): string {
  try {
    return pathname.split("%25").map(decodeURI).join("%25");
  } catch {
    return pathname;
  }
}

export interface SvelteKitAuthOptions {
  auth: AuthSource<GateAuth>;
  /** True for a path that needs a session. Needs `signInPath`. */
  protect?: ((pathname: string) => boolean) | undefined;
  /** The sign-in page. The hook adds `?next=<path and query>`. */
  signInPath?: string | undefined;
  /**
   * The path under which core's routes reach this app. Default the base path
   * of the auth object (`auth.basePath`), then "/auth". Set it only for a proxy
   * that mounts core under another prefix.
   */
  basePath?: string | undefined;
  /**
   * The host's hook that keeps work alive after the answer (ruling 29 of
   * plan 12i). Default: the `waitUntil` of `event.platform.ctx`, then of
   * `event.platform.context`. @sveltejs/adapter-cloudflare 7.2.9 sets both
   * and marks `context` deprecated (ambient.d.ts:14, read 2026-10-25). But
   * adapter 7 takes Kit 2, and this binding takes Kit 3. Adapter 8.0.1, the
   * one for Kit 3, sets no platform (files/worker.js:90-93). So on Workers
   * with Kit 3, pass `waitUntil` of "cloudflare:workers". Without it, core
   * waits for the work before it answers and writes
   * `observe.wait_until_missing`, so the answer time can tell a known number.
   */
  waitUntil?: BindingWaitUntil<RequestEvent> | undefined;
}

/**
 * The ExecutionContext that a Cloudflare adapter puts in `event.platform`, or
 * undefined: `ctx` first, then the deprecated `context`.
 */
function platformContext(event: RequestEvent): unknown {
  const platform = event.platform as { ctx?: unknown; context?: unknown } | undefined;
  return platform?.ctx ?? platform?.context;
}

/**
 * The `handle` of `src/hooks.server.ts`. A request under the base path goes to
 * core. Every other request gets `locals.session`; a person with no session on
 * a protected path goes to the sign-in page; and the page's answer gets the
 * renewed cookie. Compose it with `sequence` of `@sveltejs/kit/hooks`.
 */
export function authHandle(options: SvelteKitAuthOptions): Handle {
  checkGateOptions(options);
  return async ({ event, resolve }) => {
    const auth = resolveAuth(options.auth);
    // The rule of the gate: the option, then core's own base path, then "/auth".
    // A copy of the basePath line of readGate (packages/core/src/bindings.ts:216):
    // keep the two equal, or the hook and the gate disagree on a path of core.
    const basePath = options.basePath ?? auth.basePath ?? DEFAULT_BASE_PATH;
    // The routed URL, not request.url: for a data request of a client-side
    // navigation, Kit strips /__data.json and the x-sveltekit-* query from event.url
    // only. event.url keeps the escapes, but Kit matches the path decoded once.
    const path = kitPath(event.url.pathname);
    // Core matches its routes on the raw path. A path that Kit decodes to a path
    // of core ("/%61uth/x") goes to core too, which answers 404: else the gate
    // skips protect for it and Kit runs a catch-all page.
    if (isAuthPath(event.url.pathname, basePath) || isAuthPath(path, basePath))
      return auth.handle(
        event.request,
        handleOptions(options.waitUntil, event, () => boundWaitUntil(platformContext(event))),
      );
    const routed = `${path}${event.url.search}`;
    // next comes from event.url, the page URL: a data request returns the person
    // to the page, and the decoded text never becomes next on its own.
    const gate = await readGate({ ...options, auth }, event.request, routed, event.url);
    if (gate.redirect) return gate.redirect;
    event.locals.session = gate.session;
    return withSetCookie(await resolve(event), gate.cookie);
  };
}
