import type { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import {
  renewedSessionCookie,
  sessionFromRequest,
  sessionMaxAgeSeconds,
} from "../../engine/sessions.js";
import {
  connectionOrganization,
  createConnection,
  deleteConnection,
  listConnections,
  updateConnection,
} from "../../engine/sso/connections.js";
import { discoverSso } from "../../engine/sso/discover.js";
import {
  addDomain,
  deleteDomain,
  domainOrganization,
  listDomains,
  updateDomain,
  verifyDomain,
} from "../../engine/sso/domains.js";
import { requireSsoManager, type SsoActor } from "../../engine/sso/guard.js";
import { completeSsoOidc, startSso } from "../../engine/sso/oidc.js";
import { fail, ok, type Result } from "../../result.js";
import { isJsonRequest, readBody } from "../body.js";
import {
  connectionCreateBody,
  connectionIdBody,
  connectionListQuery,
  connectionUpdateBody,
  discoverBody,
  domainAddBody,
  domainIdBody,
  domainListQuery,
  domainUpdateBody,
} from "../contract/sso.js";
import {
  bindingCookieName,
  clearOauthCookie,
  oauthCookie,
  readCookie,
  sessionCookie,
} from "../cookies.js";
import { noScriptPagePolicy, pageHeaders } from "../csp.js";
import { json, readJson, respond } from "../json.js";
import { authErrorUrl, redirect, resolveNext } from "../redirect.js";
import type { RoutePath } from "../route-list.js";
import type { Route, RouteContext } from "../router.js";
import { challengePageUrl, trustTokenOf } from "../session-answer.js";
import { ssoContinuePage } from "../sso-continue-page.js";

/**
 * The calls of one person to the SSO manager routes: 30 per 15 minutes.
 * A setup is a few calls; a stolen session gets few writes.
 */
export const SSO_MANAGE_PER_USER = { seconds: 900, max: 30 };

/** The life of the binding cookie: the life of the state row. */
const BIND_MAX_AGE_SECONDS = 600;

/** One query string read by its schema. A repeated key answers `invalid_body`. */
export function readQuery<T>(url: URL, schema: z.ZodType<T>): Result<T> {
  const raw: Record<string, string> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (key in raw) return fail("invalid_body");
    raw[key] = value;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : fail("invalid_body");
}

/**
 * The steps of one manager route before the act (plan 12d Tasks 2, 3, and
 * 9). They are the session, the count on `sso-manage:user:<userId>`, and the
 * input. Then the manager guard runs for the organization that
 * `organizationOf` names from the input. An id that names no row answers
 * `not_found`. The SSO routes and the SCIM token routes run these steps, so
 * the two cannot drift.
 */
export async function managedCall<T, V>(
  config: ResolvedConfig,
  ctx: RouteContext,
  input: (ctx: RouteContext) => Promise<Result<T>>,
  organizationOf: (input: T) => Promise<string | null>,
  run: (actor: SsoActor, input: T) => Promise<Result<V>>,
  answer: (value: V) => Response,
): Promise<Response> {
  const send = (res: Response, renewed: string | null) => {
    if (renewed) res.headers.append("set-cookie", renewed);
    return res;
  };
  const resolved = await sessionFromRequest(config, ctx.request);
  if (!resolved) return json({ error: "unauthorized" }, 401);
  const renewed = renewedSessionCookie(config, ctx.request, resolved);
  if (!(await config.limiter.allow(`sso-manage:user:${resolved.user.id}`, SSO_MANAGE_PER_USER)))
    return send(respond(fail("rate_limited")), renewed);
  const read = await input(ctx);
  if (!read.ok) return send(respond(read), renewed);
  const organizationId = await organizationOf(read.value);
  if (organizationId === null) return send(respond(fail("not_found")), renewed);
  const actor = await requireSsoManager(config, resolved, organizationId);
  if (!actor.ok) return send(respond(actor), renewed);
  const r = await run(actor.value, read.value);
  return send(r.ok ? answer(r.value) : respond(r), renewed);
}

/** The JSON body of a manager write by its schema. A manager write takes JSON only, so a browser sends a preflight. */
export function managedBody<T>(schema: z.ZodType<T>) {
  return async (ctx: RouteContext): Promise<Result<T>> =>
    isJsonRequest(ctx.request) ? readJson(ctx.request, schema) : fail("invalid_body");
}

/**
 * The SSO routes (plan 12d). Task 4 adds the sign-in: the discovery, and
 * the start and the callback of a connection. Tasks 2 and 3 add the manager
 * routes of the domain proof and the connections (spec 30 items 2 and 5).
 * They exist when `sso` is on. Each manager route runs `managedCall`. A
 * route with a domain or a connection id reads the organization of the row
 * first. A manager write takes JSON only, so a browser sends a preflight.
 * The sign-in routes take no session.
 */
export function ssoRoutes(config: ResolvedConfig): Route[] {
  if (!config.sso) return [];
  const meta = (ctx: RouteContext) => ({
    ip: ctx.ip,
    userAgent: ctx.request.headers.get("user-agent"),
  });
  const managed = <T, V>(
    ctx: RouteContext,
    input: (ctx: RouteContext) => Promise<Result<T>>,
    organizationOf: (input: T) => Promise<string | null>,
    run: (actor: SsoActor, input: T) => Promise<Result<V>>,
    answer: (value: V) => Response,
  ) => managedCall(config, ctx, input, organizationOf, run, answer);
  const body = managedBody;
  const byId = (input: { id: string }) => domainOrganization(config, input.id);
  const byConnection = (input: { id: string }) => connectionOrganization(config, input.id);
  const post = <T, V, P extends RoutePath<"POST">>(
    path: P,
    schema: z.ZodType<T>,
    organizationOf: (input: T) => Promise<string | null>,
    run: (actor: SsoActor, input: T, ctx: RouteContext) => Promise<Result<V>>,
    answer: (value: V) => Response,
  ): Route => ({
    method: "POST",
    path,
    key: `POST ${path}`,
    handler: (ctx) =>
      managed(ctx, body(schema), organizationOf, (actor, input) => run(actor, input, ctx), answer),
  });
  const bindName = bindingCookieName(config.cookieName);
  // The binding cookie of the SSO flows (plan 12d Task 4): the 12b cookie on its own path.
  const bindPath = `${config.basePath}/sso`;
  const unbound = (res: Response) => {
    res.headers.append("set-cookie", clearOauthCookie(bindName, bindPath));
    return res;
  };
  return [
    {
      method: "POST",
      path: "/sso/discover",
      key: "POST /sso/discover",
      async handler(ctx) {
        const jsonCaller = isJsonRequest(ctx.request);
        const body = await readBody(ctx.request, discoverBody);
        if (!body.ok) return jsonCaller ? respond(body) : redirect(authErrorUrl(config, body.code));
        const r = await discoverSso(config, { email: body.value.email, ip: ctx.ip });
        if (jsonCaller) return r.ok ? json(r.value) : respond(r);
        // A form: the code goes to the error page of the app, as a social failure does.
        if (!r.ok) return redirect(authErrorUrl(config, r.code));
        if (!r.value.sso) return redirect(authErrorUrl(config, "sso_not_configured"));
        // A page of this origin, not a 303. Chromium applies form-action to each
        // redirect after the post, so it would block the 302 of the start to the
        // IdP. A failure above goes to appURL, which is baseURL or a trusted origin.
        const next = body.value.next;
        const location =
          next === undefined ? r.value.start : `${r.value.start}?next=${encodeURIComponent(next)}`;
        return new Response(ssoContinuePage({ location, appName: config.appName }), {
          status: 200,
          headers: pageHeaders(config, noScriptPagePolicy(config)),
        });
      },
    },
    {
      method: "GET",
      path: "/sso/:connectionId/start",
      key: "GET /sso/:connectionId/start",
      async handler(ctx) {
        const r = await startSso(config, {
          connectionId: ctx.params.connectionId ?? "",
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
      method: "GET",
      path: "/sso/:connectionId/callback",
      key: "GET /sso/:connectionId/callback",
      async handler(ctx) {
        const q = ctx.url.searchParams;
        const r = await completeSsoOidc(config, {
          connectionId: ctx.params.connectionId ?? "",
          code: q.get("code"),
          state: q.get("state"),
          error: q.get("error"),
          bindToken: readCookie(ctx.request, bindName),
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
          // A GET callback is a top-level navigation, so a Lax trust cookie comes with it (plan 12c).
          trustDevice: trustTokenOf(config, ctx.request, undefined),
        });
        // Each answer ends the flow of this browser, so the binding cookie goes.
        if (!r.ok) return unbound(redirect(authErrorUrl(config, r.code)));
        if ("twoFactor" in r.value)
          return unbound(redirect(challengePageUrl(config, r.value.twoFactor.challenge)));
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
        return unbound(res);
      },
    },
    {
      method: "GET",
      path: "/sso/domains",
      key: "GET /sso/domains",
      handler: (ctx) =>
        managed(
          ctx,
          async (c) => readQuery(c.url, domainListQuery),
          async (q) => q.organizationId,
          (actor, q) => listDomains(config, actor, q),
          (domains) => json({ domains }),
        ),
    },
    post(
      "/sso/domains/add",
      domainAddBody,
      async (b) => b.organizationId,
      (actor, b, ctx) => addDomain(config, actor, { ...b, ...meta(ctx) }),
      (domain) => json({ domain }),
    ),
    post(
      "/sso/domains/verify",
      domainIdBody,
      byId,
      (actor, b, ctx) => verifyDomain(config, actor, { ...b, ...meta(ctx) }),
      (domain) => json({ domain }),
    ),
    post(
      "/sso/domains/update",
      domainUpdateBody,
      byId,
      (actor, b, ctx) =>
        updateDomain(config, actor, {
          id: b.id,
          ...(b.connectionId === undefined ? {} : { connectionId: b.connectionId }),
          ...(b.enforce === undefined ? {} : { enforce: b.enforce }),
          ...(b.includeSubdomains === undefined ? {} : { includeSubdomains: b.includeSubdomains }),
          ...meta(ctx),
        }),
      (domain) => json({ domain }),
    ),
    post(
      "/sso/domains/delete",
      domainIdBody,
      byId,
      (actor, b, ctx) => deleteDomain(config, actor, { ...b, ...meta(ctx) }),
      (value) => json(value),
    ),
    {
      method: "GET",
      path: "/sso/connections",
      key: "GET /sso/connections",
      handler: (ctx) =>
        managed(
          ctx,
          async (c) => readQuery(c.url, connectionListQuery),
          async (q) => q.organizationId,
          (actor, q) => listConnections(config, actor, q),
          (connections) => json({ connections }),
        ),
    },
    post(
      "/sso/connections/create",
      connectionCreateBody,
      async (b) => b.organizationId,
      (actor, b, ctx) => createConnection(config, actor, b, meta(ctx)),
      (connection) => json({ connection }),
    ),
    post(
      "/sso/connections/update",
      connectionUpdateBody,
      byConnection,
      (actor, b, ctx) => updateConnection(config, actor, b, meta(ctx)),
      (connection) => json({ connection }),
    ),
    post(
      "/sso/connections/delete",
      connectionIdBody,
      byConnection,
      (actor, b, ctx) => deleteConnection(config, actor, b, meta(ctx)),
      (value) => json(value),
    ),
  ];
}
