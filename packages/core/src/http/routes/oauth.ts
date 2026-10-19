import { CAPTCHA_HEADER } from "../../captcha.js";
import type { ResolvedConfig } from "../../config.js";
import { issuerOf } from "../../engine/jwt.js";
import {
  type AuthorizeStep,
  authorizeStep,
  decideAuthorize,
  devicePagePath,
  deviceSignIn,
} from "../../engine/oauth-authorize.js";
import {
  type AuthedClient,
  authenticateClient,
  namesClient,
} from "../../engine/oauth-client-auth.js";
import {
  findClient,
  ORIGIN_CHECK_PER_IP,
  redirectOrigins,
  registerClient,
  registeredClient,
} from "../../engine/oauth-clients.js";
import { CREDENTIALS_GRANT, credentialsGrant } from "../../engine/oauth-credentials.js";
import {
  DEVICE_GRANT,
  DEVICE_START_PER_IP,
  type DeviceStep,
  decideDevice,
  normalizeUserCode,
  pollDevice,
  startDevice,
  USER_CODE_RE,
} from "../../engine/oauth-device.js";
import {
  deviceStartDpop,
  dpopAlgs,
  readDpopToken,
  resourceProofHolds,
  routeUrl,
  tokenDpop,
} from "../../engine/oauth-dpop.js";
import { listGrants, revokeGrant } from "../../engine/oauth-grants.js";
import { introspect, introspectLimited } from "../../engine/oauth-introspect.js";
import { type OAuthResult, oauthFail } from "../../engine/oauth-result.js";
import {
  exchangeCode,
  refreshGrant,
  resolveAccessToken,
  revokeToken,
  type TokenAnswer,
  tokenLimited,
  userinfoClaims,
} from "../../engine/oauth-token.js";
import { readBearer, renewedSessionCookie, sessionFromRequest } from "../../engine/sessions.js";
import { INVALID_CLIENT_NO_HEADER, OAUTH_ERRORS, type OAuthErrorCode } from "../../errors.js";
import { ipKey } from "../../limiter/ip-key.js";
import type { OAuthClientRow } from "../../schema.js";
import { revokeGrantBody } from "../contract/oauth.js";
import { consentPagePolicy, noScriptPagePolicy, pageHeaders } from "../csp.js";
import { DEVICE_WARNING, type DevicePageInput } from "../device-page.js";
import { json, readJson, respond } from "../json.js";
import { authErrorUrl, redirect } from "../redirect.js";
import { originTrusted, type Route, type RouteContext } from "../router.js";
import { safeNext } from "../safe-next.js";
import { signInPageResponse } from "../sign-in-response.js";
import { authorizationServerMetadata, PUBLIC_METADATA_HEADERS } from "../well-known.js";

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
 * and passes; a browser on an origin that is not trusted gets 403. The one
 * exception is `POST /oauth/token` (plan 11d): it answers a web origin of
 * the client that its form names, with CORS and no credentials, and a
 * preflight of `?client_id=` of a registered client from such an origin.
 */
export function oauthRoutes(config: ResolvedConfig): Route[] {
  const oauth = config.oauth;
  if (!oauth) return [];
  const routes: Route[] = [];
  if (oauth.dynamic)
    routes.push({
      method: "POST",
      path: "/oauth/register",
      key: "POST /oauth/register",
      async handler(ctx) {
        // The bearer is the initial access token while its hash is set (RFC 7591 section 3).
        const bearer = readBearer(ctx.request);
        const metadata = await readObject(ctx.request);
        const r = await registerClient(config, { metadata, ip: ctx.ip, bearer });
        if (!r.ok && r.error === "invalid_token")
          return json({ error: "invalid_token" }, 401, {
            "www-authenticate": 'Bearer error="invalid_token"',
          });
        return oauthJson(r, 201);
      },
    });
  /**
   * True for the device page as the sign-in step names it (ruling 44): the
   * path alone, or with a user code of the `XXXX-XXXX` form. No other query.
   */
  const deviceNext = (next: string): boolean => {
    if (!oauth.device) return false;
    const path = devicePagePath(config, null);
    if (next === path) return true;
    const prefix = `${path}?user_code=`;
    return next.startsWith(prefix) && USER_CODE_RE.test(next.slice(prefix.length));
  };
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
      key: "GET /oauth/authorize",
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
      key: "POST /oauth/authorize",
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
      key: "GET /oauth/sign-in",
      async handler(ctx) {
        const next = ctx.url.searchParams.get("next") ?? "";
        if (
          !(next.startsWith(`${config.basePath}/oauth/authorize?`) || deviceNext(next)) ||
          safeNext(next) !== next
        )
          return redirect(authErrorUrl(config, "invalid_request"));
        return signInPageResponse(config, next);
      },
    },
  );
  /** RFC 6749 section 5.1: an answer with a token carries no-store and no-cache. */
  const noCache = (res: Response): Response => {
    res.headers.set("pragma", "no-cache");
    return res;
  };
  const tokenAnswer = (r: OAuthResult<TokenAnswer>): Response => noCache(oauthJson(r));
  /** CORS for a client's own web origin (plan 11d): the exact origin, no credentials, and Vary for every cache. */
  const clientCors = (res: Response, origin: string): Response => {
    res.headers.set("access-control-allow-origin", origin);
    res.headers.append("vary", "Origin");
    return res;
  };
  /**
   * The client takes CORS from `origin`: a public client, from the origin of
   * one of its redirect URIs. A secret in a browser is not a secret (plan 12e).
   */
  const corsClient = (client: OAuthClientRow | null, origin: string) =>
    client !== null &&
    client.authMethod === "none" &&
    redirectOrigins(client.redirectUris).has(origin);
  const originChecked = async (ip: string | null) =>
    config.limiter.allow(`oauth-token-origin:ip:${ipKey(ip)}`, ORIGIN_CHECK_PER_IP);
  /**
   * A refusal of the token or the revoke route. RFC 6749 section 5.2: after
   * an `Authorization` header, `invalid_client` is 401 with the Basic
   * challenge, which RFC 7235 section 3.1 asks of every 401. With no header
   * it is 400 with no challenge, so no browser shows a sign-in dialog.
   */
  const clientRefused = (
    request: Request,
    r: { ok: false; error: OAuthErrorCode; status: number },
  ) => {
    if (r.error !== "invalid_client") return json({ error: r.error }, r.status);
    if (request.headers.has("authorization"))
      return json({ error: r.error }, r.status, {
        "www-authenticate": `Basic realm="${issuerOf(config)}"`,
      });
    return json({ error: r.error }, INVALID_CLIENT_NO_HEADER);
  };
  const GRANTS = new Set([
    "authorization_code",
    "refresh_token",
    CREDENTIALS_GRANT,
    ...(oauth.device ? [DEVICE_GRANT] : []),
  ]);
  /**
   * The grant of a form; the answer of the endpoint before any CORS header.
   * The client auth runs before the grant, so a failed auth spends nothing.
   * `client` is the row of `client_id` that the origin check read, so the
   * auth does not read it again.
   */
  const grantAnswer = async (
    request: Request,
    form: URLSearchParams | null,
    ip: string | null,
    client?: OAuthClientRow,
  ) => {
    if (!form) return tokenAnswer(oauthFail("invalid_request"));
    const grant = form.get("grant_type") ?? "";
    if (!GRANTS.has(grant)) return tokenAnswer(oauthFail("unsupported_grant_type"));
    if (await tokenLimited(config, ip)) return tokenAnswer(oauthFail("rate_limited"));
    const authed = await authenticateClient(config, request, form, client);
    if (!authed.ok) {
      // The token route's pragma of RFC 6749 section 5.1, as tokenAnswer sets it.
      const refused = clientRefused(request, authed);
      refused.headers.set("pragma", "no-cache");
      return refused;
    }
    // RFC 9449 section 5: the proof is checked and spent before the grant, so a bad proof spends no code.
    const dpop = await tokenDpop(config, request, authed.value.client);
    if (!dpop.ok) return tokenAnswer(dpop);
    if (grant === "authorization_code")
      return tokenAnswer(
        await exchangeCode(config, {
          code: form.get("code") ?? "",
          codeVerifier: form.get("code_verifier"),
          client: authed.value,
          redirectUri: form.get("redirect_uri") ?? "",
          resource: form.get("resource"),
          dpop: dpop.value,
        }),
      );
    if (grant === DEVICE_GRANT)
      return tokenAnswer(
        await pollDevice(config, {
          deviceCode: form.get("device_code") ?? "",
          client: authed.value,
          dpop: dpop.value,
        }),
      );
    if (grant === CREDENTIALS_GRANT)
      return tokenAnswer(
        await credentialsGrant(config, {
          client: authed.value,
          scope: form.get("scope"),
          resource: form.get("resource"),
          dpop: dpop.value,
        }),
      );
    return tokenAnswer(
      await refreshGrant(config, {
        refreshToken: form.get("refresh_token") ?? "",
        client: authed.value,
        scope: form.get("scope"),
        resource: form.get("resource"),
        dpop: dpop.value,
      }),
    );
  };
  /**
   * A 401 or 403 of userinfo with its challenges. RFC 9449 section 7.2: the
   * scheme of the request carries the error, and the other scheme is named
   * beside it. A request with no credential gets no error in either.
   */
  const userinfoRefused = (
    status: 401 | 403,
    scheme: "Bearer" | "DPoP" | null,
    error: "invalid_token" | "invalid_dpop_proof" | "insufficient_scope",
  ) => {
    const algs = dpopAlgs(config);
    const params =
      error === "insufficient_scope" ? `error="${error}", scope="openid"` : `error="${error}"`;
    const challenge =
      scheme === "DPoP"
        ? `DPoP ${params}, ${algs}`
        : scheme === "Bearer"
          ? `Bearer ${params}, DPoP ${algs}`
          : `Bearer, DPoP ${algs}`;
    // The body names the code of the challenge (ruling 31 of plan 12e).
    return json({ error }, status, { "www-authenticate": challenge });
  };
  const userinfo = async (ctx: RouteContext): Promise<Response> => {
    const request = ctx.request;
    const dpopToken = readDpopToken(request);
    if (dpopToken !== null) {
      // RFC 9449 section 7.1: a bound token with a proof of its key.
      const r = await resolveAccessToken(config, dpopToken);
      if (r?.kind !== "oauth" || r.access.dpopJkt === null)
        return userinfoRefused(401, "DPoP", "invalid_token");
      // The public URL of this route, not the request URL (ruling 31 of plan 12e).
      const url = routeUrl(config, "/oauth/userinfo");
      const bound = { token: dpopToken, jkt: r.access.dpopJkt };
      if (!(await resourceProofHolds(config, request, url, bound)))
        return userinfoRefused(401, "DPoP", "invalid_dpop_proof");
      const claims = userinfoClaims(r.access, r.subject);
      return claims ? json(claims) : userinfoRefused(403, "DPoP", "insufficient_scope");
    }
    const bearer = readBearer(request);
    // A client_credentials token names no user, so userinfo has no claims for it.
    const r = bearer ? await resolveAccessToken(config, bearer) : null;
    // RFC 9449 section 7.2: a bound token never passes as a Bearer token.
    const access = r?.kind === "oauth" && r.access.dpopJkt === null ? r : null;
    if (!access) return userinfoRefused(401, bearer ? "Bearer" : null, "invalid_token");
    const claims = userinfoClaims(access.access, access.subject);
    if (!claims) return userinfoRefused(403, "Bearer", "insufficient_scope");
    return json(claims);
  };
  routes.push(
    {
      method: "POST",
      path: "/oauth/token",
      key: "POST /oauth/token",
      // A foreign origin reaches the handler, which admits only the named client's own origins (plan 11d).
      clientOrigin: true,
      async preflight({ url, origin, request, ip }) {
        // A preflight has no body, so the client rides in the query. Only a registered
        // client, read by its id: a preflight never fetches a metadata document.
        if (request.headers.get("access-control-request-method") !== "POST") return null;
        if (!(await originChecked(ip)))
          return json({ error: "rate_limited" }, OAUTH_ERRORS.rate_limited);
        const client = await registeredClient(config, url.searchParams.get("client_id") ?? "");
        if (!corsClient(client, origin)) return null;
        return clientCors(
          new Response(null, {
            status: 204,
            headers: {
              "access-control-allow-methods": "POST",
              // CAPTCHA_HEADER: the same captcha header as the router's preflight (plan 12b).
              // dpop: a browser client sends its proof in this header (RFC 9449 section 4.1).
              "access-control-allow-headers": `content-type, ${CAPTCHA_HEADER}, dpop`,
              "access-control-max-age": "600",
            },
          }),
          origin,
        );
      },
      async handler(ctx) {
        const form = await formParams(ctx.request);
        const origin = ctx.request.headers.get("origin");
        // No Origin: the router applied the Origin rule and the Fetch Metadata rule. A trusted
        // Origin gets the router's credentialed CORS, as before plan 12b.
        // The router's config decides trust, so the handler and the router agree.
        if (origin === null || originTrusted(ctx.config, origin))
          return grantAnswer(ctx.request, form, ctx.ip);
        // A foreign origin: the check runs before the grant, so a refused origin spends no code and no token.
        if (!(await originChecked(ctx.ip)))
          return json({ error: "rate_limited" }, OAUTH_ERRORS.rate_limited);
        // findClient, not registeredClient: its lastSeenAt write keeps a used client
        // from the sweep. A refused probe can make that write too, at most once
        // per client per day, under the per-IP count above.
        const client = form ? await findClient(config, form.get("client_id") ?? "") : null;
        if (!client || !corsClient(client, origin))
          return json({ error: "origin_not_trusted" }, 403);
        return clientCors(await grantAnswer(ctx.request, form, ctx.ip, client), origin);
      },
    },
    {
      method: "POST",
      path: "/oauth/revoke",
      key: "POST /oauth/revoke",
      async handler(ctx) {
        const form = await formParams(ctx.request);
        if (!form) return oauthJson(oauthFail("invalid_request"));
        if (await tokenLimited(config, ctx.ip)) return oauthJson(oauthFail("rate_limited"));
        // RFC 7009 section 2.1: a client that names itself authenticates. With no
        // client named, revokeToken lets only a public client's token go.
        let client: AuthedClient | null = null;
        if (namesClient(ctx.request, form)) {
          const authed = await authenticateClient(config, ctx.request, form);
          if (!authed.ok) return clientRefused(ctx.request, authed);
          client = authed.value;
        }
        const r = await revokeToken(config, { token: form.get("token") ?? "", client });
        return r.ok ? json({}) : clientRefused(ctx.request, r);
      },
    },
    {
      // RFC 7662: a resource server asks whether a token is live. The client auth is that of the token route.
      method: "POST",
      path: "/oauth/introspect",
      key: "POST /oauth/introspect",
      async handler(ctx) {
        const form = await formParams(ctx.request);
        if (!form) return noCache(oauthJson(oauthFail("invalid_request")));
        if (await introspectLimited(config, ctx.ip))
          return noCache(oauthJson(oauthFail("rate_limited")));
        const authed = await authenticateClient(config, ctx.request, form);
        const r = authed.ok
          ? await introspect(config, {
              caller: authed.value,
              token: form.get("token"),
              hint: form.get("token_type_hint"),
            })
          : authed;
        return noCache(r.ok ? json(r.value) : clientRefused(ctx.request, r));
      },
    },
    { method: "GET", path: "/oauth/userinfo", key: "GET /oauth/userinfo", handler: userinfo },
    { method: "POST", path: "/oauth/userinfo", key: "POST /oauth/userinfo", handler: userinfo },
  );
  if (oauth.device) routes.push(...deviceRoutes(config, clientRefused, noCache));
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
      key: "GET /oauth/grants",
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
      key: "POST /oauth/grants/revoke",
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
    {
      method: "GET",
      path: "/.well-known/oauth-authorization-server",
      key: "GET /.well-known/oauth-authorization-server",
      handler: metadata,
    },
    {
      method: "GET",
      path: "/.well-known/openid-configuration",
      key: "GET /.well-known/openid-configuration",
      handler: metadata,
    },
  );
  return routes;
}

/**
 * The routes of the device grant (plan 12e, RFC 8628). They exist only while
 * `oauth.device` is on. The device asks at `/oauth/device_authorization`
 * with the client auth of the token route. The person uses `/oauth/device`.
 * The page has no script, and its POST needs this origin and a session.
 */
function deviceRoutes(
  config: ResolvedConfig,
  clientRefused: (
    request: Request,
    r: { ok: false; error: OAuthErrorCode; status: number },
  ) => Response,
  noCache: (res: Response) => Response,
): Route[] {
  const oauth = config.oauth;
  if (!oauth) return [];
  const action = devicePagePath(config, null);
  const page = (input: DevicePageInput): Response =>
    new Response(oauth.devicePage(input), {
      status: 200,
      headers: pageHeaders(config, noScriptPagePolicy(config)),
    });
  const stepPage = (step: Exclude<DeviceStep, { kind: "error" }>, email: string): Response => {
    if (step.kind === "done")
      return page({ step: "done", appName: config.appName, approved: step.approved });
    if (step.kind === "code")
      return page({
        step: "code",
        action,
        appName: config.appName,
        email,
        userCode: step.userCode,
        error: step.error,
      });
    const { row, client } = step;
    return page({
      step: "consent",
      action,
      appName: config.appName,
      email,
      clientName: client.name ?? client.id,
      clientId: client.id,
      userCode: step.userCode,
      scopes: row.scopes.map((name) => ({ name, description: oauth.scopes.get(name) ?? name })),
      resource: row.resource,
      otherResources: oauth.resources.filter((r) => r !== row.resource),
      warning: DEVICE_WARNING,
      // The form posts the code again with the decision: the server holds no other state.
      fields: { user_code: step.userCode },
    });
  };
  return [
    {
      method: "POST",
      path: "/oauth/device_authorization",
      key: "POST /oauth/device_authorization",
      async handler(ctx) {
        const form = await formParams(ctx.request);
        if (!form) return noCache(oauthJson(oauthFail("invalid_request")));
        const limitKey = `oauth-device:ip:${ipKey(ctx.ip)}`;
        if (!(await config.limiter.allow(limitKey, DEVICE_START_PER_IP)))
          return noCache(oauthJson(oauthFail("rate_limited")));
        const authed = await authenticateClient(config, ctx.request, form);
        if (!authed.ok) return noCache(clientRefused(ctx.request, authed));
        const dpop = await deviceStartDpop(config, ctx.request);
        if (!dpop.ok) return noCache(oauthJson(dpop));
        return noCache(
          oauthJson(
            await startDevice(config, {
              client: authed.value,
              scope: form.get("scope"),
              resource: form.get("resource"),
              dpop: dpop.value,
            }),
          ),
        );
      },
    },
    {
      method: "GET",
      path: "/oauth/device",
      key: "GET /oauth/device",
      async handler(ctx) {
        // RFC 8628 section 3.3.1: the code of the URL fills the field, and the person still submits it.
        const raw = ctx.url.searchParams.get("user_code");
        const userCode = raw === null ? null : normalizeUserCode(raw);
        const session = await sessionFromRequest(config, ctx.request);
        if (!session) {
          const location = await deviceSignIn(config, userCode, ctx.ip);
          if (location === null) return json({ error: "rate_limited" }, OAUTH_ERRORS.rate_limited);
          return redirect(location);
        }
        return page({
          step: "code",
          action,
          appName: config.appName,
          email: session.user.email,
          userCode: userCode ?? "",
          error: null,
        });
      },
    },
    {
      method: "POST",
      path: "/oauth/device",
      key: "POST /oauth/device",
      async handler(ctx) {
        // The page posts from this origin only. The router admits a POST with no Origin; a person's form always sends one.
        if (ctx.request.headers.get("origin") !== config.baseURL)
          return json({ error: "origin_not_trusted" }, 403);
        const session = await sessionFromRequest(config, ctx.request);
        if (!session) return json({ error: "unauthorized" }, 401);
        const form = await formParams(ctx.request);
        if (!form) return json({ error: "invalid_request" }, OAUTH_ERRORS.invalid_request);
        const step = await decideDevice(config, {
          userCode: form.get("user_code") ?? "",
          decision: form.get("decision"),
          session,
          ip: ctx.ip,
        });
        if (step.kind === "error") return json({ error: step.error }, OAUTH_ERRORS[step.error]);
        return stepPage(step, session.user.email);
      },
    },
  ];
}
