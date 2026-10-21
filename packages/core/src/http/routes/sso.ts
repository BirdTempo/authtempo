import type { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { renewedSessionCookie, sessionFromRequest } from "../../engine/sessions.js";
import {
  addDomain,
  deleteDomain,
  domainOrganization,
  listDomains,
  updateDomain,
  verifyDomain,
} from "../../engine/sso/domains.js";
import { requireSsoManager, type SsoActor } from "../../engine/sso/guard.js";
import { fail, ok, type Result } from "../../result.js";
import { isJsonRequest } from "../body.js";
import { domainAddBody, domainIdBody, domainListQuery, domainUpdateBody } from "../contract/sso.js";
import { json, readJson, respond } from "../json.js";
import type { RoutePath } from "../route-list.js";
import type { Route, RouteContext } from "../router.js";

/**
 * The calls of one person to the SSO manager routes: 30 per 15 minutes.
 * A setup is a few calls; a stolen session gets few writes.
 */
export const SSO_MANAGE_PER_USER = { seconds: 900, max: 30 };

/** One query string read by its schema. A repeated key answers `invalid_body`. */
function readQuery<T>(url: URL, schema: z.ZodType<T>): Result<T> {
  const raw: Record<string, string> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (key in raw) return fail("invalid_body");
    raw[key] = value;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : fail("invalid_body");
}

/**
 * The SSO manager routes of the domain proof (plan 12d Task 2, spec 30
 * item 2). They exist when `sso` is on. Each takes a session, then counts on
 * `sso-manage:user:<userId>`, then reads its input, then runs the manager
 * guard for the organization of the act. A route with a domain id reads the
 * organization of the row first: an id that names no row answers
 * `not_found`. A write takes JSON only, so a browser sends a preflight.
 */
export function ssoRoutes(config: ResolvedConfig): Route[] {
  if (!config.sso) return [];
  const send = (res: Response, renewed: string | null) => {
    if (renewed) res.headers.append("set-cookie", renewed);
    return res;
  };
  const meta = (ctx: RouteContext) => ({
    ip: ctx.ip,
    userAgent: ctx.request.headers.get("user-agent"),
  });
  /**
   * The steps before the act: the session, the limiter, and the input.
   * `organizationOf` names the organization of the act from the input.
   */
  const managed = async <T, V>(
    ctx: RouteContext,
    input: (ctx: RouteContext) => Promise<Result<T>>,
    organizationOf: (input: T) => Promise<string | null>,
    run: (actor: SsoActor, input: T) => Promise<Result<V>>,
    answer: (value: V) => Response,
  ): Promise<Response> => {
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
  };
  const body =
    <T>(schema: z.ZodType<T>) =>
    async (ctx: RouteContext): Promise<Result<T>> =>
      isJsonRequest(ctx.request) ? readJson(ctx.request, schema) : fail("invalid_body");
  const byId = (input: { id: string }) => domainOrganization(config, input.id);
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
  return [
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
  ];
}
