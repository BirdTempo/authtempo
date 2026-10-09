import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { completeSocial, startSocial } from "../../engine/social.js";
import { readBody } from "../body.js";
import { clearOauthCookie, oauthCookie, readCookie, sessionCookie } from "../cookies.js";
import { redirect } from "../redirect.js";
import type { Route } from "../router.js";

const BIND_MAX_AGE_SECONDS = 600;

/** Apple posts these as a form. Every field is optional; the engine rules on what is missing. */
const callbackBody = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(128).optional(),
  error: z.string().max(256).optional(),
  user: z.string().max(4096).optional(),
  id_token: z.string().max(8192).optional(),
});

interface CallbackParams {
  code: string | null;
  state: string | null;
  error: string | null;
  user: string | null;
}

export function socialRoutes(config: ResolvedConfig): Route[] {
  const bindName = `${config.cookieName}_oauth`;
  const bindPath = `${config.basePath}/social`;
  const failed = (code: string) => {
    const res = redirect(`${config.baseURL}/?auth_error=${code}`);
    // An invalid_token answer means no row was consumed for this browser.
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
        if (!r.ok) return redirect(`${config.baseURL}/?auth_error=${r.code}`);
        const res = redirect(r.value.location);
        res.headers.set(
          "set-cookie",
          oauthCookie(bindName, r.value.bindToken, bindPath, BIND_MAX_AGE_SECONDS),
        );
        return res;
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
        });
        if (!r.ok) return failed(r.code);
        const res = redirect(`${config.baseURL}${r.value.next}`);
        res.headers.append(
          "set-cookie",
          sessionCookie(
            config.cookieName,
            r.value.token,
            config.session.ttlDays * 86_400,
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
