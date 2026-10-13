import type { ResolvedConfig } from "../../config.js";
import {
  type AuthorizeStep,
  authorizeStep,
  decideAuthorize,
} from "../../engine/oauth-authorize.js";
import { registerClient } from "../../engine/oauth-clients.js";
import type { OAuthResult } from "../../engine/oauth-result.js";
import { sessionFromRequest } from "../../engine/sessions.js";
import { OAUTH_ERRORS } from "../../errors.js";
import { consentPagePolicy, pageHeaders } from "../csp.js";
import { json } from "../json.js";
import { authErrorUrl, redirect } from "../redirect.js";
import type { Route } from "../router.js";
import { safeNext } from "../safe-next.js";
import { signInPageResponse } from "../sign-in-response.js";

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
    const { request, client, user } = step;
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
      fields: {
        response_type: "code",
        client_id: request.clientId,
        redirect_uri: request.redirectUri,
        code_challenge: request.codeChallenge,
        code_challenge_method: "S256",
        scope: request.scopes.join(" "),
        resource: request.resource,
        ...(request.state !== null ? { state: request.state } : {}),
        ...(request.nonce !== null ? { nonce: request.nonce } : {}),
      },
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
        const decision = form.get("decision") ?? "";
        form.delete("decision");
        return stepResponse(
          await decideAuthorize(config, { params: form, decision, session, ip: ctx.ip }),
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
  return routes;
}
