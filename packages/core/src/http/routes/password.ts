import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { type PasswordSession, passwordSignUp } from "../../engine/password.js";
import { publicSession } from "../../engine/sessions.js";
import { sessionCookie } from "../cookies.js";
import { json, readJson, respond } from "../json.js";
import type { Route } from "../router.js";

const signUpBody = z.object({
  email: z.string().max(320),
  // The engine refuses more than 128 code points; this cap only bounds the body.
  password: z.string().max(1024),
  name: z.string().max(200).optional(),
});

/** No route without a `password` config, so the router answers 404. */
export function passwordRoutes(config: ResolvedConfig): Route[] {
  if (!config.password) return [];
  /** `{ token, user, session }` with the session cookie: a browser keeps the cookie, a native app keeps the token. */
  const signedIn = (v: PasswordSession): Response =>
    json(
      { token: v.token, ...publicSession({ user: v.user, session: v.session, refreshed: false }) },
      200,
      {
        "set-cookie": sessionCookie(
          config.cookieName,
          v.token,
          config.session.ttlDays * 86_400,
          config.cookie.sameSite,
        ),
      },
    );
  return [
    {
      method: "POST",
      path: "/password/sign-up",
      async handler(ctx) {
        const body = await readJson(ctx.request, signUpBody);
        if (!body.ok) return respond(body);
        const r = await passwordSignUp(config, {
          email: body.value.email,
          password: body.value.password,
          name: body.value.name,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
        });
        return r.ok ? signedIn(r.value) : respond(r);
      },
    },
  ];
}
