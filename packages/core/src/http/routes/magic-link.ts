import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { requestMagicLink, verifyMagicLink } from "../../engine/magic-link.js";
import { sessionCookie } from "../cookies.js";
import { readJson, respond } from "../json.js";
import type { Route } from "../router.js";

const requestBody = z.object({
  email: z.string().max(320),
  next: z.string().max(2048).optional(),
});

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

export function magicLinkRoutes(config: ResolvedConfig): Route[] {
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
      method: "GET",
      path: "/magic-link/verify",
      async handler(ctx) {
        const token = ctx.url.searchParams.get("token") ?? "";
        const result = await verifyMagicLink(config, {
          token,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
        });
        if (!result.ok) return redirect(`${config.baseURL}/?auth_error=${result.code}`);
        const maxAge = config.session.ttlDays * 86_400;
        const res = redirect(`${config.baseURL}${result.value.next}`);
        res.headers.set("set-cookie", sessionCookie(config.cookieName, result.value.token, maxAge));
        return res;
      },
    },
  ];
}
