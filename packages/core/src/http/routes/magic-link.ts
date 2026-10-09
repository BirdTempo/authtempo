import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { MAGIC_LINK_TOKEN_RE, requestMagicLink, verifyMagicLink } from "../../engine/magic-link.js";
import { publicSession, resolveSession } from "../../engine/sessions.js";
import { fail } from "../../result.js";
import { isJsonRequest, readBody } from "../body.js";
import { sessionCookie } from "../cookies.js";
import { formAction, pageHeaders } from "../csp.js";
import { json, readJson, respond } from "../json.js";
import { authErrorUrl, redirect, resolveNext } from "../redirect.js";
import type { Route } from "../router.js";

const requestBody = z.object({
  email: z.string().max(320),
  next: z.string().max(2048).optional(),
});

const verifyBody = z.object({ token: z.string().max(64) });

/**
 * Locks the page down: no script, no remote resource, no framing. The
 * inline style is the page's own. `form-action` names this origin, the
 * trusted web origins, and the handoff schemes, because Chromium applies
 * it to every redirect that follows the form post.
 */
function pagePolicy(config: ResolvedConfig): string {
  return `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction(config)}; base-uri 'none'; frame-ancestors 'none'`;
}

export function magicLinkRoutes(config: ResolvedConfig): Route[] {
  const verifyPath = `${config.basePath}/magic-link/verify`;
  const failed = (code: string) => redirect(authErrorUrl(config, code));
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
          headers: pageHeaders(config, pagePolicy(config)),
        });
      },
    },
    {
      method: "POST",
      path: "/magic-link/verify",
      async handler(ctx) {
        const jsonCaller = isJsonRequest(ctx.request);
        const body = await readBody(ctx.request, verifyBody);
        // A form with no token is a client bug, not a user error. The
        // person sees the same page they see for a bad link.
        if (!body.ok) return jsonCaller ? respond(fail("invalid_token")) : failed("invalid_token");
        const result = await verifyMagicLink(config, {
          token: body.value.token,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
        });
        if (!result.ok) return jsonCaller ? respond(result) : failed(result.code);
        const maxAge = config.session.ttlDays * 86_400;
        const cookie = sessionCookie(
          config.cookieName,
          result.value.token,
          maxAge,
          config.cookie.sameSite,
        );
        if (jsonCaller) {
          // One extra read, on the JSON path only. verifyMagicLink does not return the row.
          const resolved = await resolveSession(config, result.value.token);
          if (!resolved) return respond(fail("invalid_token"));
          return json(publicSession(resolved), 200, { "set-cookie": cookie });
        }
        const res = redirect(resolveNext(config, result.value.next));
        res.headers.set("set-cookie", cookie);
        return res;
      },
    },
  ];
}
