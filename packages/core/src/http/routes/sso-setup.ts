import type { ResolvedConfig } from "../../config.js";
import { setupRefused } from "../../engine/sso/setup-events.js";
import {
  openSetupSession,
  requireSetupSession,
  SETUP_PAGE_PER_IP,
} from "../../engine/sso/setup-session.js";
import { ipKey } from "../../limiter/ip-key.js";
import { limit } from "../../limiter/limit.js";
import { fail } from "../../result.js";
import type { SsoSetupLinkRow, SsoSetupSessionRow } from "../../schema.js";
import { isJsonRequest, readBody } from "../body.js";
import { escapeHtml } from "../confirm-page.js";
import { setupOpenBody, setupPageQuery } from "../contract/sso.js";
import { noScriptPagePolicy, pageHeaders } from "../csp.js";
import { json, respond } from "../json.js";
import { ROUTES, type RouteKey } from "../route-list.js";
import type { Route, RouteContext } from "../router.js";
import { readQuery } from "./sso.js";

/**
 * The closed list of the setup session (plan 13a Task 3, spec 6.1 item 6).
 * Each entry is a route key that takes the setup cookie as its credential,
 * and no route outside this list reads that cookie. `setupSessionRoute` is
 * the one way to build such a route, and it refuses a key that is not
 * here. So a new route is closed to a setup session by default: it needs
 * a line in this list, and the test of this list holds it to `ROUTES`.
 * The last entry is the test start of a draft (Task 7). It is one route
 * with two callers, so its handler reads this list for the `test=1` query.
 */
export const SETUP_SESSION_ROUTES: readonly string[] = Object.freeze([
  "POST /sso/setup/domains/add",
  "POST /sso/setup/domains/verify",
  "POST /sso/setup/connection",
  "POST /sso/setup/scim-token",
  "POST /sso/setup/handback",
  "GET /sso/setup/status",
  "GET /sso/:connectionId/start?test=1",
]);

/** What a handler of a setup session route gets: the live link and the live session of its cookie. */
export interface SetupCaller {
  link: SsoSetupLinkRow;
  session: SsoSetupSessionRow;
}

/**
 * Builds one route that a setup session calls. The route key must be in
 * `SETUP_SESSION_ROUTES`, else the build throws, so no route takes the
 * cookie by accident. `requireSetupSession` runs before the handler and
 * before any body read. Each refusal answers 401 `unauthorized`, the answer
 * of a request with no credential. The router builds the Origin and Fetch
 * Metadata rules around it as for each POST.
 */
export function setupSessionRoute(
  key: RouteKey,
  handler: (ctx: RouteContext, caller: SetupCaller) => Promise<Response>,
): Route {
  const entry = ROUTES.find((r) => `${r.method} ${r.path}` === key);
  if (!entry || !SETUP_SESSION_ROUTES.includes(key))
    throw new Error(`authtempo: ${key} is not on the closed list of the setup session`);
  return {
    method: entry.method,
    path: entry.path,
    key,
    async handler(ctx) {
      const caller = await requireSetupSession(ctx.config, ctx.request);
      if (!caller.ok) return respond(caller);
      return handler(ctx, caller.value);
    },
  };
}

/**
 * The confirm page of a setup link. It reads no row and writes none, so a
 * mail scanner that fetches the link opens nothing (spec 6.1 item 5). The
 * person presses the button, and the browser posts the token to the open.
 * No script, so a scanner that runs JavaScript opens nothing either.
 */
function confirmPage(config: ResolvedConfig, token: string): string {
  const action = escapeHtml(`${config.basePath}/sso/setup/open`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin">
<meta name="robots" content="noindex">
<title>Set up single sign-on</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; background: #f6f6f6; color: #111; }
main { background: #fff; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 4px rgba(0,0,0,0.12); text-align: center; max-width: 24rem; }
button { font: inherit; padding: 0.75rem 1.5rem; border: 0; border-radius: 0.375rem; background: #111; color: #fff; cursor: pointer; }
</style>
</head>
<body>
<main>
<h1>Set up single sign-on</h1>
<p>Press the button to start. Start only if a person of your company gave you this link.</p>
<form method="post" action="${action}">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit">Start</button>
</form>
</main>
</body>
</html>
`;
}

/**
 * The page after a form open. Task 9 replaces it with the first page of the
 * setup. The link goes to the status route by a top-level GET, which carries
 * the cookie of `SameSite=Lax`.
 */
function openedPage(config: ResolvedConfig): string {
  const next = escapeHtml(`${config.basePath}/sso/setup/status`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin">
<meta name="robots" content="noindex">
<title>Set up single sign-on</title>
</head>
<body>
<main>
<h1>The setup is open</h1>
<p><a href="${next}">Continue</a></p>
</main>
</body>
</html>
`;
}

/**
 * The routes of the setup link for its IT admin (plan 13a Task 3). They
 * exist when `sso.setup` is on. The routes of the setup session itself are
 * built with `setupSessionRoute` by the tasks that own them.
 */
export function ssoSetupRoutes(config: ResolvedConfig): Route[] {
  if (!config.sso || !config.sso.setup) return [];
  return [
    {
      method: "GET",
      path: "/sso/setup",
      key: "GET /sso/setup",
      handler: async (ctx) => {
        const query = readQuery(ctx.url, setupPageQuery);
        if (!query.ok) return respond(query);
        // The page reads no row, but each view costs a render: it counts on its own key.
        if (!(await limit(ctx.config, "setup-page:ip", ipKey(ctx.ip), SETUP_PAGE_PER_IP))) {
          setupRefused(ctx.config, "page_ip_limit");
          return respond(fail("rate_limited"));
        }
        return new Response(confirmPage(ctx.config, query.value.token), {
          status: 200,
          headers: pageHeaders(ctx.config, noScriptPagePolicy(ctx.config)),
        });
      },
    },
    {
      method: "POST",
      path: "/sso/setup/open",
      key: "POST /sso/setup/open",
      handler: async (ctx) => {
        const body = await readBody(ctx.request, setupOpenBody);
        if (!body.ok) return respond(body);
        const opened = await openSetupSession(ctx.config, body.value.token, {
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
        });
        if (!opened.ok) return respond(opened);
        const headers = { "set-cookie": opened.value.cookie };
        if (isJsonRequest(ctx.request)) return json({ linkId: opened.value.linkId }, 200, headers);
        return new Response(openedPage(ctx.config), {
          status: 200,
          headers: { ...pageHeaders(ctx.config, noScriptPagePolicy(ctx.config)), ...headers },
        });
      },
    },
  ];
}
