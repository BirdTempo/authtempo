import type { z } from "zod";
import { isRecordVerify, takeLargeReadCounted, takeSsoManageCounted } from "../../compat-seams.js";
import type { ResolvedConfig } from "../../config.js";
import type { SignInChallenge } from "../../engine/second-factor.js";
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
  verifyDomainWith,
} from "../../engine/sso/domains.js";
import { requireSsoManager, type SsoActor } from "../../engine/sso/guard.js";
import { completeSsoOidc, startSso } from "../../engine/sso/oidc.js";
import type { SsoSignedIn } from "../../engine/sso/resolve.js";
import { completeSaml, SAML_FORM_MAX, spMetadata } from "../../engine/sso/saml-sp.js";
import { limit } from "../../limiter/limit.js";
import { fail, ok, type Result } from "../../result.js";
import { isJsonRequest, readBody } from "../body.js";
import {
  BODY_CAP_FLOOR,
  BodyBusy,
  BodyTooLarge,
  bindBodyClient,
  bodyCapOfRequest,
  largeReadCanStart,
  parseBodyForm,
  readBodyBytes,
} from "../body-cap.js";
import { holdsBadText } from "../body-text.js";
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
import { authErrorRedirect, redirect, resolveNext } from "../redirect.js";
import { routeKeyOf } from "../route-key.js";
import type { RoutePath } from "../route-list.js";
import type { Route, RouteContext } from "../router.js";
import { challengePageUrl, trustTokenOf } from "../session-answer.js";
import { ssoContinuePage } from "../sso-continue-page.js";

/**
 * The calls of one person to the SSO manager routes: 30 per 15 minutes.
 * A setup is a few calls; a stolen session gets few writes.
 */
export const SSO_MANAGE_PER_USER = { seconds: 900, max: 30 };

/** Counts one SSO manager write of the user on its limit. True when the write is within the limit. */
export function ssoManageAllowed(config: ResolvedConfig, userId: string): Promise<boolean> {
  return limit(config, "sso-manage:user", userId, SSO_MANAGE_PER_USER);
}

/**
 * The large body reads of one person at the SSO connection writes: 6 per
 * hour, counted at the start of each read, after `sso-manage:user` (ruling
 * 69 of the 12j lane). A read past the limit answers 429 before any byte.
 * A read that cannot start answers 503 before this count, and spends none
 * (ruling 72 Minor 1).
 *
 * The derivation, done 2026-10-30. One read holds the user half of the body
 * budget for at most 32 s (`LARGE_READ_USER_MIN_RATE`), and a user runs one
 * read at a time (`LARGE_READS_PER_USER`). So one account holds that half at
 * most 6 times 32 s, 192 s, in each hour. A setup of one connection is one
 * create and a few updates.
 */
export const SSO_LARGE_READ_PER_USER = { seconds: 3600, max: 6 };

/**
 * The large body reads of every person of the deployment at the SSO
 * connection writes: 60 per hour, counted after `sso-large-read:user`, so a
 * read past the limit of its user spends none of this count (ruling 72 Low 2
 * of the 12j lane). A read past it answers 429 before any byte.
 *
 * The derivation, done 2026-10-30. It is 6 reads of one person
 * (`SSO_LARGE_READ_PER_USER`) times 10 admins who set up SSO in one hour.
 * One read holds the user half of the body budget for at most 32 s, so the
 * reads of all accounts together hold it at most 60 times 32 s, 1920 s, in
 * a window. Before this bound, 19 free accounts, at 6 times 32 s each, held
 * the half for the whole hour. The limiter counts in fixed windows: a
 * window opens at the first count, and its count starts again when it ends.
 * So up to 120 reads can start in a short span across the end of a window.
 * The bound has a cost: 10 accounts can spend it with small writes, and
 * then every SSO connection write answers 429 until the window ends. The
 * limits page states both residuals.
 */
export const SSO_LARGE_READ_PER_DEPLOYMENT = { seconds: 3600, max: 60 };

/** The one subject of `sso-large-read:deployment`: one count for the deployment. */
const DEPLOYMENT_SUBJECT = "all";

/**
 * Counts one large body read of the user at an SSO connection write: on the
 * limit of the user, then on the limit of the deployment (ruling 72 Low 2).
 * A read past the limit of its user does not count on the deployment. True
 * when the read is within both limits.
 */
export async function ssoLargeReadAllowed(
  config: ResolvedConfig,
  userId: string,
): Promise<boolean> {
  if (!(await limit(config, "sso-large-read:user", userId, SSO_LARGE_READ_PER_USER))) return false;
  return limit(
    config,
    "sso-large-read:deployment",
    DEPLOYMENT_SUBJECT,
    SSO_LARGE_READ_PER_DEPLOYMENT,
  );
}

/** The life of the binding cookie: the life of the state row. */
const BIND_MAX_AGE_SECONDS = 600;

/** One query string read by its schema. A repeated key, a NUL, or a lone surrogate answers `invalid_body`. */
export function readQuery<T>(url: URL, schema: z.ZodType<T>): Result<T> {
  const raw: Record<string, string> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (key in raw) return fail("invalid_body");
    raw[key] = value;
  }
  // The port refuses a NUL or a lone surrogate in a where value (plan 12g).
  if (holdsBadText(raw)) return fail("invalid_body");
  const parsed = schema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : fail("invalid_body");
}

/**
 * The steps of one manager route before the act (plan 12d Tasks 2, 3, and
 * 9). They are the session, the count on `sso-manage:user:<userId>`, and the
 * input. Then the manager guard runs for the organization that
 * `organizationOf` names from the input. An id that names no row answers
 * `not_found`. The SSO routes and the SCIM token routes run these steps, so
 * the two cannot drift. A write that a compat package counted before its
 * own read (`countSsoManageWrite`) is not counted again (ruling 51 Minor 1
 * of the 12j lane). After the session, a body read counts on the share of
 * the user (ruling 59). A route whose cap is above the floor also counts
 * the read on `sso-large-read:user` before any byte (ruling 69). Before
 * any count, a large read that cannot start (`largeReadCanStart`) answers
 * 503 `body_busy`, so a client that sends again after `Retry-After` spends
 * no count of the hour (ruling 72 Minor 1).
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
  // After the session, a large read counts on the share of the user, not of the IP (ruling 59).
  const client = `user:${resolved.user.id}`;
  bindBodyClient(ctx.request, client);
  const cap = bodyCapOfRequest(ctx.request);
  const large = cap > BODY_CAP_FLOOR;
  // A large read that cannot start answers 503 before any count, so a retry spends none (ruling 72).
  if (large && !largeReadCanStart(client, cap, ctx.request.headers.get("content-length")))
    throw new BodyBusy();
  const renewed = renewedSessionCookie(config, ctx.request, resolved);
  const counted = takeSsoManageCounted(ctx.request, resolved.user.id);
  if (!counted && !(await ssoManageAllowed(config, resolved.user.id)))
    return send(respond(fail("rate_limited")), renewed);
  // A large read counts at its start. When the compat package counted it before its own read,
  // core takes the outcome of that count and counts no more (rulings 69 and 72).
  if (large) {
    const shim = takeLargeReadCounted(ctx.request, resolved.user.id);
    if (
      shim === "refused" ||
      (shim === null && !(await ssoLargeReadAllowed(config, resolved.user.id)))
    )
      return send(respond(fail("rate_limited")), renewed);
  }
  const read = await input(ctx);
  if (!read.ok) return send(respond(read), renewed);
  const organizationId = await organizationOf(read.value);
  if (organizationId === null) return send(respond(fail("not_found")), renewed);
  const route = routeKeyOf(ctx.request.method, ctx.url.pathname.slice(config.basePath.length));
  const actor = await requireSsoManager(config, resolved, organizationId, route);
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
 * The form of an ACS post, at most `SAML_FORM_MAX` bytes. A body past the
 * cap, a body read before, a body that is not UTF-8, a form of more than
 * `FORM_PAIRS_MAX` pairs, a NUL or a lone surrogate, or another media type
 * gives an empty form. `completeSaml` refuses an empty form at the step
 * `form`. The read holds its bytes against the budget of the large reads,
 * and past it the router answers `body_busy` (ruling 51 of the 12j lane).
 * `completeSaml` calls it only after the ACS limit and the SAML check
 * (ruling 59).
 */
async function acsForm(request: Request): Promise<URLSearchParams> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return new URLSearchParams();
  let bytes: Uint8Array | null;
  try {
    bytes = await readBodyBytes(request, SAML_FORM_MAX);
  } catch (e) {
    if (e instanceof BodyTooLarge) return new URLSearchParams();
    throw e;
  }
  if (bytes === null) return new URLSearchParams();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new URLSearchParams();
  }
  // More than FORM_PAIRS_MAX pairs gives an empty form before the parse (ruling 51 of the 12j lane).
  const form = parseBodyForm(text);
  if (form === null) return new URLSearchParams();
  // A NUL or a lone surrogate gives an empty form too (plan 12g, holdsBadText).
  return holdsBadText([...form]) ? new URLSearchParams() : form;
}

/**
 * The SSO routes (plan 12d). Task 4 adds the sign-in: the discovery, and
 * the start and the callback of a connection. Tasks 2 and 3 add the manager
 * routes of the domain proof and the connections (spec 30 items 2 and 5).
 * Task 8 adds the SAML ACS and the SP metadata of a connection.
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
  ) => managedCall(ctx.config, ctx, input, organizationOf, run, answer);
  const body = managedBody;
  const byId = (input: { id: string }, ctx: RouteContext) =>
    domainOrganization(ctx.config, input.id);
  const byConnection = (input: { id: string }, ctx: RouteContext) =>
    connectionOrganization(ctx.config, input.id);
  const post = <T, V, P extends RoutePath<"POST">>(
    path: P,
    schema: z.ZodType<T>,
    organizationOf: (input: T, ctx: RouteContext) => Promise<string | null>,
    run: (actor: SsoActor, input: T, ctx: RouteContext) => Promise<Result<V>>,
    answer: (value: V) => Response,
  ): Route => ({
    method: "POST",
    path,
    key: `POST ${path}`,
    handler: (ctx) =>
      managed(
        ctx,
        body(schema),
        (input) => organizationOf(input, ctx),
        (actor, input) => run(actor, input, ctx),
        answer,
      ),
  });
  const bindName = bindingCookieName(config.cookieName);
  // The binding cookie of the SSO flows (plan 12d Task 4): the 12b cookie on its own path.
  const bindPath = `${config.basePath}/sso`;
  const unbound = (res: Response) => {
    res.headers.append("set-cookie", clearOauthCookie(bindName, bindPath));
    return res;
  };
  // The answer of the OIDC callback and of the SAML ACS. Each answer ends
  // the flow of this browser, so the binding cookie goes.
  const signedInAnswer = (
    config: ResolvedConfig,
    r: Result<SsoSignedIn | SignInChallenge>,
  ): Response => {
    if (!r.ok) return unbound(authErrorRedirect(config, r.code));
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
  };
  return [
    {
      method: "POST",
      path: "/sso/discover",
      key: "POST /sso/discover",
      async handler(ctx) {
        const jsonCaller = isJsonRequest(ctx.request);
        const body = await readBody(ctx.request, discoverBody);
        if (!body.ok) return jsonCaller ? respond(body) : authErrorRedirect(ctx.config, body.code);
        // The start of a JSON answer and of the form page both carry `next`.
        const r = await discoverSso(ctx.config, {
          email: body.value.email,
          next: body.value.next,
          ip: ctx.ip,
        });
        if (jsonCaller) return r.ok ? json(r.value) : respond(r);
        // A form: the code goes to the error page of the app, as a social failure does.
        if (!r.ok) return authErrorRedirect(ctx.config, r.code);
        if (!r.value.sso) return authErrorRedirect(ctx.config, "sso_not_configured");
        // A page of this origin, not a 303. Chromium applies form-action to each
        // redirect after the post, so it would block the 302 of the start to the
        // IdP. A failure above goes to appURL, which is baseURL or a trusted origin.
        return new Response(
          ssoContinuePage({ location: r.value.start, appName: ctx.config.appName }),
          {
            status: 200,
            headers: pageHeaders(ctx.config, noScriptPagePolicy(ctx.config)),
          },
        );
      },
    },
    {
      method: "GET",
      path: "/sso/:connectionId/start",
      key: "GET /sso/:connectionId/start",
      async handler(ctx) {
        const r = await startSso(ctx.config, {
          connectionId: ctx.params.connectionId ?? "",
          next: ctx.url.searchParams.get("next") ?? undefined,
          ip: ctx.ip,
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
      method: "GET",
      path: "/sso/:connectionId/callback",
      key: "GET /sso/:connectionId/callback",
      async handler(ctx) {
        const q = ctx.url.searchParams;
        const r = await completeSsoOidc(ctx.config, {
          connectionId: ctx.params.connectionId ?? "",
          code: q.get("code"),
          state: q.get("state"),
          error: q.get("error"),
          bindToken: readCookie(ctx.request, bindName),
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
          // A GET callback is a top-level navigation, so a Lax trust cookie comes with it (plan 12c).
          trustDevice: trustTokenOf(ctx.config, ctx.request, undefined),
        });
        return signedInAnswer(ctx.config, r);
      },
    },
    {
      method: "POST",
      path: "/sso/:connectionId/acs",
      key: "POST /sso/:connectionId/acs",
      // The IdP posts the form cross-site, as Apple's callback; the request row and the binding cookie bind it.
      allowCrossSiteForm: true,
      async handler(ctx) {
        const r = await completeSaml(ctx.config, {
          connectionId: ctx.params.connectionId ?? "",
          // The read runs after the limit and the SAML check of completeSaml (ruling 59 of the 12j lane).
          readForm: () => acsForm(ctx.request),
          bindToken: readCookie(ctx.request, bindName),
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
          // A cross-site form post carries no Lax trust cookie; the challenge page then offers the trusted device (plan 12c).
          trustDevice: trustTokenOf(ctx.config, ctx.request, undefined),
        });
        return signedInAnswer(ctx.config, r);
      },
    },
    {
      method: "GET",
      path: "/sso/:connectionId/metadata",
      key: "GET /sso/:connectionId/metadata",
      async handler(ctx) {
        const row = await ctx.config.storage.findOne("ssoConnection", [
          { field: "id", op: "eq", value: ctx.params.connectionId ?? "" },
        ]);
        // An owner sets up the IdP before the connection is on, so `enabled` does not count here.
        if (row?.kind !== "saml" || ctx.config.sso?.saml === null)
          return respond(fail("sso_not_configured"));
        return new Response(spMetadata(ctx.config, row), {
          status: 200,
          headers: { "content-type": "application/samlmetadata+xml" },
        });
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
          (actor, q) => listDomains(ctx.config, actor, q),
          (domains) => json({ domains }),
        ),
    },
    post(
      "/sso/domains/add",
      domainAddBody,
      async (b) => b.organizationId,
      (actor, b, ctx) => addDomain(ctx.config, actor, { ...b, ...meta(ctx) }),
      (domain) => json({ domain }),
    ),
    post(
      "/sso/domains/verify",
      domainIdBody,
      byId,
      // A request that verifyDomainByRecord marked asks for the compat package's record (plan 12d Task 14).
      (actor, b, ctx) =>
        verifyDomainWith(
          ctx.config,
          actor,
          { ...b, ...meta(ctx) },
          isRecordVerify(ctx.request) ? "compat" : "own",
        ),
      (domain) => json({ domain }),
    ),
    post(
      "/sso/domains/update",
      domainUpdateBody,
      byId,
      (actor, b, ctx) =>
        updateDomain(ctx.config, actor, {
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
      (actor, b, ctx) => deleteDomain(ctx.config, actor, { ...b, ...meta(ctx) }),
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
          (actor, q) => listConnections(ctx.config, actor, q),
          (connections) => json({ connections }),
        ),
    },
    post(
      "/sso/connections/create",
      connectionCreateBody,
      async (b) => b.organizationId,
      (actor, b, ctx) => createConnection(ctx.config, actor, b, meta(ctx)),
      (connection) => json({ connection }),
    ),
    post(
      "/sso/connections/update",
      connectionUpdateBody,
      byConnection,
      (actor, b, ctx) => updateConnection(ctx.config, actor, b, meta(ctx)),
      (connection) => json({ connection }),
    ),
    post(
      "/sso/connections/delete",
      connectionIdBody,
      byConnection,
      (actor, b, ctx) => deleteConnection(ctx.config, actor, b, meta(ctx)),
      (value) => json(value),
    ),
  ];
}
