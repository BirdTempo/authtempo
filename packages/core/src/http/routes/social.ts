import type { ResolvedConfig } from "../../config.js";
import { anonymousCaller } from "../../engine/anonymous.js";
import { ID_TOKEN_PROVIDERS, idTokenNonce, signInWithIdToken } from "../../engine/id-token.js";
import { socialMethod } from "../../engine/last-method.js";
import { sessionCookieToken, sessionMaxAgeSeconds } from "../../engine/sessions.js";
import { completeSocial, startLink, startSocial } from "../../engine/social.js";
import type { Result } from "../../result.js";
import { isJsonRequest, readBody } from "../body.js";
import { callbackBody, idTokenBody, idTokenNonceBody, linkBody } from "../contract/social.js";
import {
  bindingCookieName,
  clearOauthCookie,
  oauthCookie,
  readCookie,
  sessionCookie,
} from "../cookies.js";
import { json, readJson, respond } from "../json.js";
import { authErrorRedirect, redirect, resolveNext } from "../redirect.js";
import type { Route, RouteContext } from "../router.js";
import {
  challengePageUrl,
  signedInResponse,
  trustTokenOf,
  twoFactorJson,
  withLastMethod,
} from "../session-answer.js";
import { sent, unauthorized, withSession } from "../session-route.js";

const BIND_MAX_AGE_SECONDS = 600;

interface CallbackParams {
  code: string | null;
  state: string | null;
  error: string | null;
  user: string | null;
}

/**
 * The social routes. A provider with a `redirectURI` (plan 12i Task 12) gets
 * one more route: its override path, with the callback's method and
 * handler, marked `aliasOf`. The path is checked at construction, so it
 * shadows no route. Its binding cookie lives on that path, where the
 * provider returns the browser.
 */
export function socialRoutes(config: ResolvedConfig): Route[] {
  const bindName = bindingCookieName(config.cookieName);
  return config.social.providers.flatMap((provider): Route[] => {
    const callbackPath = `/social/${provider.name}/callback`;
    const bindPath = provider.redirectURI
      ? new URL(provider.redirectURI).pathname
      : `${config.basePath}/social`;
    // The appURL of the request's entry of baseURL (plan 12i Task 18).
    const failed = (ctx: RouteContext, code: string) => {
      const res = authErrorRedirect(ctx.config, code);
      // An invalid_token answer keeps the binding cookie: a state of another
      // tab, or no state, consumes no row of this browser's flow. A link
      // refused for its session spent its state, and the cookie expires.
      // An in-flight flow in another tab keeps its cookie.
      if (code !== "invalid_token") {
        res.headers.append("set-cookie", clearOauthCookie(bindName, bindPath));
      }
      return res;
    };
    const callback: Route = {
      method: provider.callbackMethod,
      path: callbackPath,
      // Apple's POST callback is its own entry of ROUTES (plan 11a).
      key:
        provider.callbackMethod === "POST"
          ? "POST /social/apple/callback"
          : "GET /social/:provider/callback",
      // Apple posts from appleid.apple.com. The state row and the binding
      // cookie tie that post to the browser that started the flow.
      allowCrossSiteForm: provider.callbackMethod === "POST",
      async handler(ctx) {
        return callbackAnswer(ctx);
      },
    };
    const alias: Route[] = provider.redirectURI
      ? [
          {
            ...callback,
            path: new URL(provider.redirectURI).pathname.slice(config.basePath.length),
            aliasOf: callbackPath,
          },
        ]
      : [];
    async function callbackAnswer(ctx: RouteContext): Promise<Response> {
      const params = await callbackParams(ctx.request, ctx.url);
      const r = await completeSocial(ctx.config, {
        provider: provider.name,
        ...params,
        bindToken: readCookie(ctx.request, bindName),
        ip: ctx.ip,
        userAgent: ctx.request.headers.get("user-agent"),
        // A GET callback is a top-level navigation, so a Lax trust cookie
        // comes with it. Apple's cross-site form post carries none; the
        // challenge page then offers the trusted device (plan 12c).
        trustDevice: trustTokenOf(ctx.config, ctx.request, undefined),
        // The cookie only: a provider's redirect carries no bearer header (plan 12a).
        sessionToken: sessionCookieToken(ctx.config, ctx.request),
        anonymous: await anonymousCaller(ctx.config, ctx.request),
      });
      if (!r.ok) return failed(ctx, r.code);
      if ("linked" in r.value) {
        // A link (plan 12a): the session does not change, so no session cookie.
        // The state is spent, so the binding cookie goes.
        const res = redirect(resolveNext(ctx.config, r.value.next));
        res.headers.append("set-cookie", clearOauthCookie(bindName, bindPath));
        return res;
      }
      if ("twoFactor" in r.value) {
        // A user with the second factor on (plan 12c): no session cookie.
        // The state is spent, so the binding cookie goes.
        const res = redirect(challengePageUrl(ctx.config, r.value.twoFactor.challenge));
        res.headers.append("set-cookie", clearOauthCookie(bindName, bindPath));
        return res;
      }
      const res = redirect(resolveNext(ctx.config, r.value.next));
      res.headers.append(
        "set-cookie",
        sessionCookie(
          ctx.config.cookieName,
          r.value.token,
          sessionMaxAgeSeconds(ctx.config),
          ctx.config.cookie.sameSite,
        ),
      );
      res.headers.append("set-cookie", clearOauthCookie(bindName, bindPath));
      return withLastMethod(ctx.config, ctx.request, res, socialMethod(provider.name));
    }
    return [
      {
        method: "GET",
        path: `/social/${provider.name}/start`,
        key: "GET /social/:provider/start",
        async handler(ctx) {
          const r = await startSocial(ctx.config, {
            provider: provider.name,
            next: ctx.url.searchParams.get("next") ?? undefined,
            data: ctx.url.searchParams.get("data") ?? undefined,
            ip: ctx.ip,
            anonymous: await anonymousCaller(ctx.config, ctx.request),
          });
          if (!r.ok) return authErrorRedirect(ctx.config, r.code);
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
        key: "POST /social/:provider/link",
        async handler(ctx) {
          const s = await withSession(ctx.config, ctx.request);
          if (!s) return unauthorized();
          const jsonCaller = isJsonRequest(ctx.request);
          const failure = (r: Extract<Result<unknown>, { ok: false }>) =>
            sent(jsonCaller ? respond(r) : authErrorRedirect(ctx.config, r.code), s.renewed);
          const body = await readBody(ctx.request, linkBody);
          if (!body.ok) return failure(body);
          const r = await startLink(ctx.config, {
            provider: provider.name,
            session: s.resolved,
            next: body.value.next,
            data: body.value.data,
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
      callback,
      ...alias,
      ...idTokenRoutes(config, provider.name, provider.kind === "oidc" && !!provider.idToken),
    ];
  });
}

/**
 * The ID-token route of `google` and `apple` (plan 12i Task 10). JSON in,
 * JSON out: Google One Tap's callback and Apple's native sheet give the app
 * the token, and the app posts it. The router's Origin rule is the CSRF
 * guard, so core takes no form post and no `g_csrf_token`.
 */
function idTokenRoutes(config: ResolvedConfig, name: string, serves: boolean): Route[] {
  if (!serves || !config.social.idToken || !ID_TOKEN_PROVIDERS.includes(name)) return [];
  return [
    {
      method: "POST",
      path: `/social/${name}/id-token/nonce`,
      key: "POST /social/:provider/id-token/nonce",
      async handler(ctx) {
        const body = await readJson(ctx.request, idTokenNonceBody);
        if (!body.ok) return respond(body);
        const r = await idTokenNonce(ctx.config, { provider: name, ip: ctx.ip });
        if (!r.ok) return respond(r);
        return json({ nonce: r.value.nonce, expiresAt: r.value.expiresAt.toISOString() });
      },
    },
    {
      method: "POST",
      path: `/social/${name}/id-token`,
      key: "POST /social/:provider/id-token",
      async handler(ctx) {
        const body = await readJson(ctx.request, idTokenBody);
        if (!body.ok) return respond(body);
        const r = await signInWithIdToken(ctx.config, {
          provider: name,
          idToken: body.value.idToken,
          nonce: body.value.nonce,
          name: body.value.name,
          next: body.value.next,
          trustDevice: trustTokenOf(ctx.config, ctx.request, body.value.trustDevice),
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
          anonymous: await anonymousCaller(ctx.config, ctx.request),
        });
        if (!r.ok) return respond(r);
        // The challenge row keeps the method, and its verify sets the cookie (plan 12i Task 12).
        if ("twoFactor" in r.value) return twoFactorJson(r.value);
        const method = socialMethod(name);
        return withLastMethod(
          ctx.config,
          ctx.request,
          signedInResponse(ctx.config, r.value, method),
          method,
        );
      },
    },
  ];
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
