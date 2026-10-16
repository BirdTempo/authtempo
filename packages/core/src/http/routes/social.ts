import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { sessionCookieToken, sessionMaxAgeSeconds } from "../../engine/sessions.js";
import { completeSocial, startLink, startSocial } from "../../engine/social.js";
import type { Result } from "../../result.js";
import { isJsonRequest, readBody } from "../body.js";
import {
  bindingCookieName,
  clearOauthCookie,
  oauthCookie,
  readCookie,
  sessionCookie,
} from "../cookies.js";
import { json, respond } from "../json.js";
import { authErrorUrl, redirect, resolveNext } from "../redirect.js";
import type { Route } from "../router.js";
import { challengePageUrl, trustTokenOf } from "../session-answer.js";
import { sent, unauthorized, withSession } from "../session-route.js";

const BIND_MAX_AGE_SECONDS = 600;

/** Apple posts these as a form. Every field is optional; the engine rules on what is missing. */
const callbackBody = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(128).optional(),
  error: z.string().max(256).optional(),
  user: z.string().max(4096).optional(),
  id_token: z.string().max(8192).optional(),
});

// Not strict: a form may carry the name of its button.
const linkBody = z.object({ next: z.string().max(2048).optional() });

interface CallbackParams {
  code: string | null;
  state: string | null;
  error: string | null;
  user: string | null;
}

export function socialRoutes(config: ResolvedConfig): Route[] {
  const bindName = bindingCookieName(config.cookieName);
  const bindPath = `${config.basePath}/social`;
  const failed = (code: string) => {
    const res = redirect(authErrorUrl(config, code));
    // An invalid_token answer keeps the binding cookie: a state of another
    // tab, or no state, consumes no row of this browser's flow. A link
    // refused for its session spent its state, and the cookie expires.
    // An in-flight flow in another tab keeps its cookie.
    if (code !== "invalid_token") {
      res.headers.append("set-cookie", clearOauthCookie(bindName, bindPath));
    }
    return res;
  };
  return config.social.providers.flatMap((provider): Route[] => [
    {
      method: "GET",
      path: `/social/${provider.name}/start`,
      async handler(ctx) {
        const r = await startSocial(config, {
          provider: provider.name,
          next: ctx.url.searchParams.get("next") ?? undefined,
          ip: ctx.ip,
        });
        if (!r.ok) return redirect(authErrorUrl(config, r.code));
        const res = redirect(r.value.location);
        res.headers.set(
          "set-cookie",
          oauthCookie(bindName, r.value.bindToken, bindPath, BIND_MAX_AGE_SECONDS),
        );
        return res;
      },
    },
    {
      // A POST, so the router's Origin rule applies: a link changes the account (plan 12a).
      method: "POST",
      path: `/social/${provider.name}/link`,
      async handler(ctx) {
        const s = await withSession(config, ctx.request);
        if (!s) return unauthorized();
        const jsonCaller = isJsonRequest(ctx.request);
        const failure = (r: Extract<Result<unknown>, { ok: false }>) =>
          sent(jsonCaller ? respond(r) : redirect(authErrorUrl(config, r.code)), s.renewed);
        const body = await readBody(ctx.request, linkBody);
        if (!body.ok) return failure(body);
        const r = await startLink(config, {
          provider: provider.name,
          session: s.resolved,
          next: body.value.next,
          ip: ctx.ip,
        });
        if (!r.ok) return failure(r);
        // JSON: the client navigates to `url`. A form: 303, so the browser follows with a GET.
        const res = jsonCaller
          ? json({ url: r.value.location })
          : new Response(null, {
              status: 303,
              headers: { location: r.value.location, "cache-control": "no-store" },
            });
        res.headers.append(
          "set-cookie",
          oauthCookie(bindName, r.value.bindToken, bindPath, BIND_MAX_AGE_SECONDS),
        );
        return sent(res, s.renewed);
      },
    },
    {
      method: provider.callbackMethod,
      path: `/social/${provider.name}/callback`,
      // Apple posts from appleid.apple.com. The state row and the binding
      // cookie tie that post to the browser that started the flow.
      allowCrossSiteForm: provider.callbackMethod === "POST",
      async handler(ctx) {
        const params = await callbackParams(ctx.request, ctx.url);
        const r = await completeSocial(config, {
          provider: provider.name,
          ...params,
          bindToken: readCookie(ctx.request, bindName),
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
          // A GET callback is a top-level navigation, so a Lax trust cookie
          // comes with it. Apple's cross-site form post carries none; the
          // challenge page then offers the trusted device (plan 12c).
          trustDevice: trustTokenOf(config, ctx.request, undefined),
          // The cookie only: a provider's redirect carries no bearer header (plan 12a).
          sessionToken: sessionCookieToken(config, ctx.request),
        });
        if (!r.ok) return failed(r.code);
        if ("linked" in r.value) {
          // A link (plan 12a): the session does not change, so no session cookie.
          // The state is spent, so the binding cookie goes.
          const res = redirect(resolveNext(config, r.value.next));
          res.headers.append("set-cookie", clearOauthCookie(bindName, bindPath));
          return res;
        }
        if ("twoFactor" in r.value) {
          // A user with the second factor on (plan 12c): no session cookie.
          // The state is spent, so the binding cookie goes.
          const res = redirect(challengePageUrl(config, r.value.twoFactor.challenge));
          res.headers.append("set-cookie", clearOauthCookie(bindName, bindPath));
          return res;
        }
        const res = redirect(resolveNext(config, r.value.next));
        res.headers.append(
          "set-cookie",
          sessionCookie(
            config.cookieName,
            r.value.token,
            sessionMaxAgeSeconds(config),
            config.cookie.sameSite,
          ),
        );
        res.headers.append("set-cookie", clearOauthCookie(bindName, bindPath));
        return res;
      },
    },
  ]);
}

async function callbackParams(request: Request, url: URL): Promise<CallbackParams> {
  if (request.method === "GET") {
    return {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      error: url.searchParams.get("error"),
      user: null,
    };
  }
  const body = await readBody(request, callbackBody);
  if (!body.ok) return { code: null, state: null, error: null, user: null };
  return {
    code: body.value.code ?? null,
    state: body.value.state ?? null,
    error: body.value.error ?? null,
    user: body.value.user ?? null,
  };
}
