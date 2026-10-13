import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import {
  type AuthorizeStep,
  authorizeStep,
  decideAuthorize,
} from "../../engine/oauth-authorize.js";
import { registerClient } from "../../engine/oauth-clients.js";
import { listGrants, revokeGrant } from "../../engine/oauth-grants.js";
import { type OAuthResult, oauthFail } from "../../engine/oauth-result.js";
import {
  exchangeCode,
  refreshGrant,
  resolveAccessToken,
  revokeToken,
  type TokenAnswer,
  userinfoClaims,
} from "../../engine/oauth-token.js";
import { readBearer, renewedSessionCookie, sessionFromRequest } from "../../engine/sessions.js";
import { OAUTH_ERRORS } from "../../errors.js";
import { consentPagePolicy, pageHeaders } from "../csp.js";
import { json, readJson, respond } from "../json.js";
import { authErrorUrl, redirect } from "../redirect.js";
import type { Route, RouteContext } from "../router.js";
import { safeNext } from "../safe-next.js";
import { signInPageResponse } from "../sign-in-response.js";
import { authorizationServerMetadata, PUBLIC_METADATA_HEADERS } from "../well-known.js";

/** A client id of either kind: a `cl_` id or a metadata document URL of at most 2048 characters. */
const revokeGrantBody = z.object({ clientId: z.string().min(1).max(2048) });

/** An OAuth answer: the value with `status`, or `{ error }` with the status of `OAUTH_ERRORS`. No cache keeps either. */
export function oauthJson<T>(r: OAuthResult<T>, status = 200): Response {
  return r.ok ? json(r.value, status) : json({ error: r.error }, r.status);
}

/** A JSON object body, or null. */
async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A form body whose fields each come once (RFC 6749 section 3.1), or null. */
async function formParams(request: Request): Promise<URLSearchParams | null> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(await request.text());
  } catch {
    return null;
  }
  for (const key of new Set(params.keys())) if (params.getAll(key).length > 1) return null;
  return params;
}

/**
 * The provider routes (plan 9g, spec 8.13). None exists while `oauth` is
 * off. The router's Origin rule applies: a native client sends no Origin
 * and passes; a browser on an origin that is not trusted gets 403.
 */
export function oauthRoutes(config: ResolvedConfig): Route[] {
  const oauth = config.oauth;
  if (!oauth) return [];
  const routes: Route[] = [];
  if (oauth.dynamic)
    routes.push({
      method: "POST",
      path: "/oauth/register",
      async handler(ctx) {
        const metadata = await readObject(ctx.request);
        if (!metadata) return json({ error: "invalid_client_metadata" }, 400);
        return oauthJson(await registerClient(config, { metadata, ip: ctx.ip }), 201);
      },
    });
  const stepResponse = (step: AuthorizeStep): Response => {
    if (step.kind === "error") return json({ error: step.error }, OAUTH_ERRORS[step.error]);
    if (step.kind !== "consent") return redirect(step.location);
    const { request, client, user, requestId } = step;
    const target = new URL(request.redirectUri);
    const html = oauth.consentPage({
      action: `${config.basePath}/oauth/authorize`,
      appName: config.appName,
      clientName: client.name ?? client.id,
      clientId: client.id,
      redirectTo:
        target.protocol === "https:" || target.protocol === "http:"
          ? target.origin
          : target.protocol,
      email: user.email,
      scopes: request.scopes.map((name) => ({ name, description: oauth.scopes.get(name) ?? name })),
      resource: request.resource,
      otherResources: oauth.resources.filter((r) => r !== request.resource),
      // The request stays on the server (plan 9h): the form posts its short id only.
      fields: { request_id: requestId },
    });
    return new Response(html, {
      status: 200,
      headers: pageHeaders(config, consentPagePolicy(config, request.redirectUri)),
    });
  };
  routes.push(
    {
      method: "GET",
      path: "/oauth/authorize",
      async handler(ctx) {
        const session = await sessionFromRequest(config, ctx.request);
        return stepResponse(
          await authorizeStep(config, { params: ctx.url.searchParams, session, ip: ctx.ip }),
        );
      },
    },
    {
      method: "POST",
      path: "/oauth/authorize",
      async handler(ctx) {
        // The consent form posts from this origin only. The router admits a
        // POST with no Origin, as from a script; a consent never comes from one.
        if (ctx.request.headers.get("origin") !== config.baseURL)
          return json({ error: "origin_not_trusted" }, 403);
        const session = await sessionFromRequest(config, ctx.request);
        if (!session) return json({ error: "unauthorized" }, 401);
        const form = await formParams(ctx.request);
        if (!form) return json({ error: "invalid_request" }, 400);
        return stepResponse(
          await decideAuthorize(config, {
            requestId: form.get("request_id") ?? "",
            decision: form.get("decision") ?? "",
            session,
            ip: ctx.ip,
          }),
        );
      },
    },
    {
      // The login step of the authorize request: core's sign-in page, landing back on it.
      method: "GET",
      path: "/oauth/sign-in",
      async handler(ctx) {
        const next = ctx.url.searchParams.get("next") ?? "";
        if (!next.startsWith(`${config.basePath}/oauth/authorize?`) || safeNext(next) !== next)
          return redirect(authErrorUrl(config, "invalid_request"));
        return signInPageResponse(config, next);
      },
    },
  );
  /** RFC 6749 section 5.1: a token answer carries no-store and no-cache. */
  const tokenAnswer = (r: OAuthResult<TokenAnswer>): Response => {
    const res = oauthJson(r);
    res.headers.set("pragma", "no-cache");
    return res;
  };
  const userinfo = async (ctx: RouteContext): Promise<Response> => {
    const bearer = readBearer(ctx.request);
    const access = bearer ? await resolveAccessToken(config, bearer) : null;
    if (!access)
      return json({ error: "invalid_token" }, 401, {
        "www-authenticate": 'Bearer error="invalid_token"',
      });
    const claims = userinfoClaims(access);
    if (!claims)
      return json({ error: "insufficient_scope" }, 403, {
        "www-authenticate": 'Bearer error="insufficient_scope", scope="openid"',
      });
    return json(claims);
  };
  routes.push(
    {
      method: "POST",
      path: "/oauth/token",
      async handler(ctx) {
        const form = await formParams(ctx.request);
        if (!form) return tokenAnswer(oauthFail("invalid_request"));
        const clientId = form.get("client_id") ?? "";
        const grant = form.get("grant_type");
        if (grant === "authorization_code")
          return tokenAnswer(
            await exchangeCode(config, {
              code: form.get("code") ?? "",
              codeVerifier: form.get("code_verifier") ?? "",
              clientId,
              redirectUri: form.get("redirect_uri") ?? "",
              resource: form.get("resource"),
              ip: ctx.ip,
            }),
          );
        if (grant === "refresh_token")
          return tokenAnswer(
            await refreshGrant(config, {
              refreshToken: form.get("refresh_token") ?? "",
              clientId,
              scope: form.get("scope"),
              resource: form.get("resource"),
              ip: ctx.ip,
            }),
          );
        return tokenAnswer(oauthFail("unsupported_grant_type"));
      },
    },
    {
      method: "POST",
      path: "/oauth/revoke",
      async handler(ctx) {
        const form = await formParams(ctx.request);
        if (!form) return oauthJson(oauthFail("invalid_request"));
        const r = await revokeToken(config, {
          token: form.get("token") ?? "",
          clientId: form.get("client_id"),
          ip: ctx.ip,
        });
        return r.ok ? json({}) : oauthJson(r);
      },
    },
    { method: "GET", path: "/oauth/userinfo", handler: userinfo },
    { method: "POST", path: "/oauth/userinfo", handler: userinfo },
  );
  // The grants of the signed-in person (plan 9g final fix wave, review I-1).
  // A session only, through `sessionFromRequest`: a `tk_` bearer and an
  // access token answer 401, so an agent cannot list or end grants. The
  // POST takes the router's Origin rule, as every session POST does.
  const withSession = async (ctx: RouteContext) => {
    const resolved = await sessionFromRequest(config, ctx.request);
    if (!resolved) return null;
    return { user: resolved.user, renewed: renewedSessionCookie(config, ctx.request, resolved) };
  };
  const send = (res: Response, renewed: string | null) => {
    if (renewed) res.headers.append("set-cookie", renewed);
    return res;
  };
  routes.push(
    {
      method: "GET",
      path: "/oauth/grants",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return json({ error: "unauthorized" }, 401);
        const r = await listGrants(config, { userId: s.user.id });
        return send(r.ok ? json({ grants: r.value }) : respond(r), s.renewed);
      },
    },
    {
      method: "POST",
      path: "/oauth/grants/revoke",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return json({ error: "unauthorized" }, 401);
        const body = await readJson(ctx.request, revokeGrantBody);
        if (!body.ok) return send(respond(body), s.renewed);
        return send(
          respond(await revokeGrant(config, { userId: s.user.id, clientId: body.value.clientId })),
          s.renewed,
        );
      },
    },
  );
  // The issuer's own well-known paths under basePath (RFC 8414 as consumerb's
  // clients read it, and OIDC Discovery). The protected-resource document has
  // no route here: it lives at the origin root (RFC 9728), so this path answers 404.
  const metadata = async (): Promise<Response> =>
    json(authorizationServerMetadata(config), 200, PUBLIC_METADATA_HEADERS);
  routes.push(
    { method: "GET", path: "/.well-known/oauth-authorization-server", handler: metadata },
    { method: "GET", path: "/.well-known/openid-configuration", handler: metadata },
  );
  return routes;
}
