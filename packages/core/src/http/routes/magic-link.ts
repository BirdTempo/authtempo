import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { MAGIC_LINK_TOKEN_RE, requestMagicLink, verifyMagicLink } from "../../engine/magic-link.js";
import { readBody } from "../body.js";
import { sessionCookie } from "../cookies.js";
import { readJson, respond } from "../json.js";
import type { Route } from "../router.js";

const requestBody = z.object({
  email: z.string().max(320),
  next: z.string().max(2048).optional(),
});

const verifyBody = z.object({ token: z.string().max(64) });

/**
 * Locks the page down: no script, no remote resource, the form may post
 * to this origin only, no framing. The inline style is the page's own.
 * Chromium applies `form-action` to the redirect that follows the form
 * post as well. Today the redirect goes to `baseURL`, which is 'self'.
 * Plan 5 redirects to the app origin or an app scheme, so it must widen
 * `form-action` to those `trustedOrigins` and prove it in a real browser.
 */
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

export function magicLinkRoutes(config: ResolvedConfig): Route[] {
  const verifyPath = `${config.basePath}/magic-link/verify`;
  const failed = (code: string) => redirect(`${config.baseURL}/?auth_error=${code}`);
  return [
    {
      method: "POST",
      path: "/magic-link/request",
      async handler(ctx) {
        const body = await readJson(ctx.request, requestBody);
        if (!body.ok) return respond(body);
        return respond(
          await requestMagicLink(config, {
            email: body.value.email,
            next: body.value.next,
            ip: ctx.ip,
          }),
        );
      },
    },
    {
      // A mail scanner or link preview fetches this. It must change nothing:
      // no storage read, no limiter call, no cookie. The person presses the
      // button, and the browser posts the token to the route below.
      method: "GET",
      path: "/magic-link/verify",
      async handler(ctx) {
        const token = ctx.url.searchParams.get("token") ?? "";
        if (!MAGIC_LINK_TOKEN_RE.test(token)) return failed("invalid_token");
        const html = config.magicLink.confirmPage({ action: verifyPath, token });
        return new Response(html, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-robots-tag": "noindex",
            "content-security-policy": PAGE_CSP,
          },
        });
      },
    },
    {
      method: "POST",
      path: "/magic-link/verify",
      async handler(ctx) {
        const body = await readBody(ctx.request, verifyBody);
        // A form with no token is a client bug, not a user error. The
        // person sees the same page they see for a bad link.
        if (!body.ok) return failed("invalid_token");
        const result = await verifyMagicLink(config, {
          token: body.value.token,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
        });
        if (!result.ok) return failed(result.code);
        const maxAge = config.session.ttlDays * 86_400;
        const res = redirect(`${config.baseURL}${result.value.next}`);
        res.headers.set("set-cookie", sessionCookie(config.cookieName, result.value.token, maxAge));
        return res;
      },
    },
  ];
}
