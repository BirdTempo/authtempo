import type { z } from "zod";
import type { OperatorScope, ResolvedConfig } from "../../config.js";
import { rotateKey } from "../../engine/jwt.js";
import {
  matchOperatorSecret,
  type OperatorActor,
  requireOperatorUser,
  requireScope,
} from "../../engine/operator/guards.js";
import { startImpersonation, stopImpersonation } from "../../engine/operator/impersonation.js";
import { operatorApi } from "../../engine/operator/index.js";
import { rewrapSecrets, secretsStatus } from "../../engine/secrets.js";
import {
  renewedSessionCookie,
  resolveSession,
  sessionCookieToken,
  sessionFromRequest,
} from "../../engine/sessions.js";
import { ipKey } from "../../limiter/ip-key.js";
import type { Observer } from "../../observe/observer.js";
import {
  OPERATOR_PER_IP,
  OPERATOR_SECRETS_PER_IP,
  OPERATOR_USERS_PER_IP,
  OPERATOR_USERS_PER_SECRET,
} from "../../operator-secret.js";
import { readSessionToken } from "../../primitives/credentials.js";
import { fail, ok, type Result } from "../../result.js";
import { SCHEMA_VERSION } from "../../schema.js";
import { VERSION } from "../../version.js";
import { isJsonRequest } from "../body.js";
import {
  auditQuery,
  banBody,
  createAdminBody,
  endAllBody,
  factorDisableBody,
  impersonateBody,
  impersonateStopBody,
  platformRoleBody,
  rewrapBody,
  searchQuery,
  userQuery,
  userReasonBody,
  usersQuery,
} from "../contract/operator.js";
import { clearSessionCookie, readCookie, sessionCookie } from "../cookies.js";
import { actorCookieName } from "../impersonation-rules.js";
import { json, readJson, respond } from "../json.js";
import type { RoutePath } from "../route-list.js";
import type { Route, RouteContext } from "../router.js";
import { unauthorized } from "../session-route.js";

/** Why an operator route answers 401: the reason code of its log line. */
export type UnauthorizedReason =
  | "secret_mismatch"
  | "secret_and_session"
  | "secret_not_accepted"
  | "no_session";

/**
 * One log line per 401 of an operator route (spec 9), in the form of the
 * guard refusals: the route and the reason code. The line holds no secret,
 * no header, no IP, and no address.
 */
function logUnauthorized(observe: Observer, route: string, reason: UnauthorizedReason): void {
  observe.emit({ name: "operator.route_unauthorized", route, reason });
}

/**
 * The one check of the operator secret, for every operator route of 11c
 * and 11c2: `matchOperatorSecret` plus a scope test (plan 12f). Null when
 * the secret matches an entry with `scope`; `scope` null needs a match
 * only. No match answers 401 and writes one log line; a match with no
 * scope answers 403 `operator_required`.
 */
async function operatorAuthorized(
  config: ResolvedConfig,
  ctx: RouteContext,
  route: string,
  scope: OperatorScope | null,
): Promise<Response | null> {
  const entry = await matchOperatorSecret(config, ctx.request);
  if (entry === null) {
    logUnauthorized(ctx.config.observe, route, "secret_mismatch");
    return json({ error: "unauthorized" }, 401);
  }
  if (scope === null) return null;
  const allowed = requireScope({ kind: "secret", name: entry.name, scopes: entry.scopes }, scope);
  return allowed.ok ? null : json({ error: allowed.code }, allowed.status);
}

/** The parsed body of a rewrap, or null for a body that is not a limit and a cursor. */
async function readRewrapBody(
  request: Request,
): Promise<{ limit?: number; after?: string } | null> {
  const text = await request.text();
  let raw: unknown = {};
  if (text !== "") {
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
  }
  const parsed = rewrapBody.safeParse(raw);
  if (!parsed.success) return null;
  const { limit, after } = parsed.data;
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(after === undefined ? {} : { after }),
  };
}

/** The body of a stop: `{}` for an empty body, else the parsed JSON, or null for a bad body. */
async function readStopBody(request: Request): Promise<{ reason?: string } | null> {
  const text = await request.text();
  let raw: unknown = {};
  if (text !== "") {
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
  }
  const parsed = impersonateStopBody.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.reason === undefined ? {} : { reason: parsed.data.reason };
}

/** Whole seconds from now to `at`, at least 0: the Max-Age of a cookie that ends at `at`. */
function secondsUntil(config: ResolvedConfig, at: Date): number {
  return Math.max(0, Math.floor((at.getTime() - config.clock.now().getTime()) / 1000));
}

/**
 * The impersonation routes (plan 12f Task 11, spec 26 item 9). Each needs
 * the session of the caller. A request with an operator secret and no
 * session answers 401, and so does a request with both (plan 12f deviation
 * 5). The start moves the operator's token into the actor cookie. It sets
 * the session cookie to the new token. Both cookies get the Max-Age of the
 * new session. A bearer caller gets the token in the body and no cookie.
 * The stop ends the session and clears the actor cookie. It sets the
 * session cookie back to the operator's token while that session lives,
 * else it clears the session cookie. Each 401 writes one log line (spec 9).
 */
function impersonationRoutes(config: ResolvedConfig): Route[] {
  if (!config.operator?.impersonation) return [];
  const { sameSite } = config.cookie;
  const actorCookie = actorCookieName(config);
  const userAgent = (ctx: RouteContext) => ctx.request.headers.get("user-agent");
  const withSecret = (ctx: RouteContext) =>
    /^Operator\s/i.test(ctx.request.headers.get("authorization") ?? "");
  const refuse = (ctx: RouteContext, route: string, reason: UnauthorizedReason) => {
    logUnauthorized(ctx.config.observe, route, reason);
    return unauthorized();
  };
  return [
    {
      method: "POST",
      path: "/operator/impersonate",
      key: "POST /operator/impersonate",
      async handler(ctx) {
        const operator = await sessionFromRequest(config, ctx.request);
        const token = readSessionToken(config, ctx.request);
        if (withSecret(ctx))
          return refuse(ctx, "POST /operator/impersonate", "secret_not_accepted");
        if (!operator || token === null)
          return refuse(ctx, "POST /operator/impersonate", "no_session");
        const body = await readJson(ctx.request, impersonateBody);
        if (!body.ok) return respond(body);
        const r = await startImpersonation(
          config,
          {
            operator,
            userId: body.value.userId,
            reason: body.value.reason,
            ip: ctx.ip,
            userAgent: userAgent(ctx),
          },
          "POST /operator/impersonate",
        );
        if (!r.ok) return respond(r);
        const { session, auditId } = r.value;
        const expiresAt = session.expiresAt.toISOString();
        if (sessionCookieToken(config, ctx.request) === null)
          return json({ token: r.value.token, expiresAt, auditId });
        const res = json({ expiresAt, auditId });
        const maxAge = secondsUntil(config, session.expiresAt);
        res.headers.append(
          "set-cookie",
          sessionCookie(config.cookieName, r.value.token, maxAge, sameSite),
        );
        res.headers.append("set-cookie", sessionCookie(actorCookie, token, maxAge, sameSite));
        return res;
      },
    },
    {
      method: "POST",
      path: "/operator/impersonate/stop",
      key: "POST /operator/impersonate/stop",
      async handler(ctx) {
        const resolved = await sessionFromRequest(config, ctx.request);
        if (withSecret(ctx))
          return refuse(ctx, "POST /operator/impersonate/stop", "secret_not_accepted");
        if (!resolved) return refuse(ctx, "POST /operator/impersonate/stop", "no_session");
        const body = await readStopBody(ctx.request);
        if (body === null) return json({ error: "invalid_body" }, 400);
        const r = await stopImpersonation(config, {
          session: resolved,
          ...body,
          ip: ctx.ip,
          userAgent: userAgent(ctx),
        });
        if (!r.ok) return respond(r);
        if (sessionCookieToken(config, ctx.request) === null)
          return json({ auditId: r.value.auditId, restored: false });
        // The operator's own session, when it still lives: the actor cookie holds its token.
        const own = readCookie(ctx.request, actorCookie);
        const back = own === null ? null : await resolveSession(config, own);
        const res = json({ auditId: r.value.auditId, restored: back !== null });
        res.headers.append(
          "set-cookie",
          back !== null && own !== null
            ? sessionCookie(
                config.cookieName,
                own,
                secondsUntil(config, back.session.expiresAt),
                sameSite,
              )
            : clearSessionCookie(config.cookieName, sameSite),
        );
        res.headers.append("set-cookie", clearSessionCookie(actorCookie, sameSite));
        return res;
      },
    },
  ];
}

/**
 * The operator routes. The four secret routes of plans 11c and 11c2 exist
 * only with an operator secret entry. With `operator.users` and no secret,
 * they are a tool that is off, so they answer 404 (ruling 22 of plan 12f,
 * spec 26 item 7). The routes of the user, session, and audit tools exist only
 * with `operator.users` (`toolRoutes`). The secret is not an API token: no
 * user owns it, and no session reaches it. `keys/rotate` exists only with `jwtMint`: its one
 * action rotates the signing key. The three routes of 11c2 answer counts
 * and key names, never a sealed value, a hash, or a config value. Each
 * route runs its limiter first, so every call counts, also one with no
 * header. Plan 12f: `keys/rotate` needs the scope keys, the secret routes
 * need the scope secrets, and the info route needs any entry, because it
 * gives no value.
 */
export function operatorRoutes(config: ResolvedConfig): Route[] {
  if (!config.operator) return [];
  // The impersonation needs no secret entry: a platform operator starts it with a session.
  return [...secretRoutes(config), ...toolRoutes(config), ...impersonationRoutes(config)];
}

/** The four secret routes of plans 11c and 11c2, or none when the config holds no secret entry. */
function secretRoutes(config: ResolvedConfig): Route[] {
  if (!config.operator || config.operator.secrets.length === 0) return [];
  const rotate: Route[] = config.jwtMint
    ? [
        {
          method: "POST",
          path: "/operator/keys/rotate",
          key: "POST /operator/keys/rotate",
          async handler(ctx) {
            if (!(await config.limiter.allow(`operator:ip:${ipKey(ctx.ip)}`, OPERATOR_PER_IP)))
              return json({ error: "rate_limited" }, 429);
            const refused = await operatorAuthorized(
              config,
              ctx,
              "POST /operator/keys/rotate",
              "keys",
            );
            if (refused) return refused;
            // The answer `{ kid }` names the new signing key; the old key verifies for 24 hours and signs nothing.
            return json(await rotateKey(config));
          },
        },
      ]
    : [];
  return [
    ...rotate,
    {
      method: "GET",
      path: "/operator/secrets/status",
      key: "GET /operator/secrets/status",
      async handler(ctx) {
        if (
          !(await config.limiter.allow(
            `operator-secrets:ip:${ipKey(ctx.ip)}`,
            OPERATOR_SECRETS_PER_IP,
          ))
        )
          return json({ error: "rate_limited" }, 429);
        const refused = await operatorAuthorized(
          config,
          ctx,
          "GET /operator/secrets/status",
          "secrets",
        );
        if (refused) return refused;
        return json(await secretsStatus(config));
      },
    },
    {
      method: "POST",
      path: "/operator/secrets/rewrap",
      key: "POST /operator/secrets/rewrap",
      async handler(ctx) {
        if (
          !(await config.limiter.allow(
            `operator-secrets:ip:${ipKey(ctx.ip)}`,
            OPERATOR_SECRETS_PER_IP,
          ))
        )
          return json({ error: "rate_limited" }, 429);
        const refused = await operatorAuthorized(
          config,
          ctx,
          "POST /operator/secrets/rewrap",
          "secrets",
        );
        if (refused) return refused;
        const body = await readRewrapBody(ctx.request);
        if (body === null) return json({ error: "invalid_body" }, 400);
        return respond(await rewrapSecrets(config, body));
      },
    },
    {
      method: "GET",
      path: "/operator/info",
      key: "GET /operator/info",
      async handler(ctx) {
        if (
          !(await config.limiter.allow(
            `operator-secrets:ip:${ipKey(ctx.ip)}`,
            OPERATOR_SECRETS_PER_IP,
          ))
        )
          return json({ error: "rate_limited" }, 429);
        const refused = await operatorAuthorized(config, ctx, "GET /operator/info", null);
        if (refused) return refused;
        return json({
          core: VERSION,
          schemaVersion: SCHEMA_VERSION,
          configKeys: config.configKeys,
        });
      },
    },
  ];
}

/** `Authorization: Operator …`, any case: the request names the operator secret as its credential. */
const OPERATOR_SCHEME = /^Operator(\s|$)/i;

/** The actor of one request, and the Set-Cookie of a session caller's sliding refresh. */
export interface OperatorCaller {
  actor: OperatorActor;
  renewed: string | null;
}

/**
 * The actor of a request to a route of the user, session, and audit tools
 * (plan 12f, spec 26 items 7 and 12). A request with the operator scheme
 * counts on `operator-users:ip:<ip>` first, so every secret call counts,
 * right or wrong. Then a session cookie or a `ts_` bearer beside it answers
 * 401 `unauthorized` (deviation 5): the request has no single actor. Then
 * the secret must match an entry, else 401. Then the entry counts on
 * `operator-users:secret:<name>`, so a stolen secret has one count for all
 * addresses (ruling 38). A request with no operator
 * scheme needs a session, else 401, and then `requireOperatorUser`, which
 * counts on `operator:user:<userId>`. A user actor exists only through that
 * guard. The scope check of a secret is the engine's, at each entry.
 * Each 401 writes one log line (spec 9).
 */
export async function readOperatorActor(
  config: ResolvedConfig,
  ctx: RouteContext,
  route: string,
): Promise<Result<OperatorCaller>> {
  const request = ctx.request;
  if (OPERATOR_SCHEME.test(request.headers.get("authorization") ?? "")) {
    if (!(await config.limiter.allow(`operator-users:ip:${ipKey(ctx.ip)}`, OPERATOR_USERS_PER_IP)))
      return fail("rate_limited");
    if (readSessionToken(config, request) !== null) {
      logUnauthorized(ctx.config.observe, route, "secret_and_session");
      return fail("unauthorized");
    }
    const entry = await matchOperatorSecret(config, request);
    if (entry === null) {
      logUnauthorized(ctx.config.observe, route, "secret_mismatch");
      return fail("unauthorized");
    }
    if (
      !(await config.limiter.allow(
        `operator-users:secret:${entry.name}`,
        OPERATOR_USERS_PER_SECRET,
      ))
    )
      return fail("rate_limited");
    return ok({ actor: { kind: "secret", name: entry.name, scopes: entry.scopes }, renewed: null });
  }
  const resolved = await sessionFromRequest(config, request);
  if (!resolved) {
    logUnauthorized(ctx.config.observe, route, "no_session");
    return fail("unauthorized");
  }
  const user = await requireOperatorUser(config, resolved, route);
  if (!user.ok) return user;
  return ok({ actor: user.value, renewed: renewedSessionCookie(config, request, resolved) });
}

/**
 * The query of a read, parsed by its contract schema. A repeated key fails
 * `invalid_body`, as a repeated form field does in `readBody`: the schema
 * never sees a silent first or last value.
 */
function readQuery<T>(url: URL, schema: z.ZodType<T>): Result<T> {
  const raw: Record<string, string> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (key in raw) return fail("invalid_body");
    raw[key] = value;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : fail("invalid_body");
}

/** A page size of a query, as the number the engine takes. */
function limitOf(limit: string | undefined): { limit?: number } {
  return limit === undefined ? {} : { limit: Number(limit) };
}

/** The value under one key: the CLI reads `{ user }` (plan 12f Task 12). */
function under<K extends string, V>(key: K, r: Result<V>): Result<Record<K, V>> {
  return r.ok ? ok({ [key]: r.value } as Record<K, V>) : r;
}

/**
 * The routes of the user, session, and audit tools (plan 12f, spec 26 item
 * 7), only with `operator.users`. Each route reads the actor first. Then it
 * reads its query or its JSON body with the contract schema. A write with
 * another content type, or with none, answers `invalid_body`. Then it calls
 * one entry of `auth.api.operator` with the caller's IP and user agent. A session
 * caller's POST keeps the Origin rule and the Fetch Metadata rule of the
 * router. A secret caller sends no cookie, and a POST with no Origin passes.
 * The impersonation routes are plan 12f Task 11.
 */
function toolRoutes(config: ResolvedConfig): Route[] {
  if (!config.operator?.users) return [];
  const api = operatorApi(config);
  const send = (res: Response, renewed: string | null) => {
    if (renewed) res.headers.append("set-cookie", renewed);
    return res;
  };
  const read = <T, V, P extends RoutePath<"GET">>(
    path: P,
    schema: z.ZodType<T>,
    run: (actor: OperatorActor, query: T) => Promise<Result<V>>,
  ): Route => ({
    method: "GET",
    path,
    key: `GET ${path}`,
    async handler(ctx) {
      const caller = await readOperatorActor(config, ctx, `GET ${path}`);
      if (!caller.ok) return respond(caller);
      const query = readQuery(ctx.url, schema);
      if (!query.ok) return send(respond(query), caller.value.renewed);
      return send(respond(await run(caller.value.actor, query.value)), caller.value.renewed);
    },
  });
  const write = <T, V, P extends RoutePath<"POST">>(
    path: P,
    schema: z.ZodType<T>,
    run: (
      actor: OperatorActor,
      body: T,
      meta: { ip: string | null; userAgent: string | null },
    ) => Promise<Result<V>>,
  ): Route => ({
    method: "POST",
    path,
    key: `POST ${path}`,
    async handler(ctx) {
      const caller = await readOperatorActor(config, ctx, `POST ${path}`);
      if (!caller.ok) return respond(caller);
      // JSON only (ruling 38): a JSON body forces a preflight. A text/plain
      // body or a body with no content type is a simple request with none.
      const body = isJsonRequest(ctx.request)
        ? await readJson(ctx.request, schema)
        : fail("invalid_body");
      if (!body.ok) return send(respond(body), caller.value.renewed);
      const meta = { ip: ctx.ip, userAgent: ctx.request.headers.get("user-agent") };
      return send(respond(await run(caller.value.actor, body.value, meta)), caller.value.renewed);
    },
  });
  return [
    read("/operator/users", usersQuery, (actor, q) =>
      api.users.list({
        actor,
        ...(q.after === undefined ? {} : { after: q.after }),
        ...limitOf(q.limit),
      }),
    ),
    read("/operator/users/search", searchQuery, (actor, q) =>
      api.users.search({
        actor,
        ...(q.email === undefined ? {} : { email: q.email }),
        ...(q.emailPrefix === undefined ? {} : { emailPrefix: q.emailPrefix }),
        ...(q.id === undefined ? {} : { id: q.id }),
        ...(q.after === undefined ? {} : { after: q.after }),
        ...limitOf(q.limit),
      }),
    ),
    read("/operator/users/get", userQuery, async (actor, q) =>
      under("user", await api.users.get({ actor, userId: q.userId })),
    ),
    write("/operator/users/ban", banBody, (actor, b, meta) =>
      api.users.ban({
        actor,
        userId: b.userId,
        reason: b.reason,
        ...(b.until === undefined ? {} : { until: b.until }),
        ...meta,
      }),
    ),
    write("/operator/users/unban", userReasonBody, (actor, b, meta) =>
      api.users.unban({ actor, userId: b.userId, reason: b.reason, ...meta }),
    ),
    write("/operator/users/platform-role", platformRoleBody, (actor, b, meta) =>
      (b.grant ? api.platformRole.grant : api.platformRole.revoke)({
        actor,
        userId: b.userId,
        reason: b.reason,
        ...meta,
      }),
    ),
    write("/operator/users/second-factor/disable", factorDisableBody, (actor, b, meta) =>
      api.secondFactor.disable({
        actor,
        userId: b.userId,
        reason: b.reason,
        proof: b.proof,
        ...meta,
      }),
    ),
    // A secret actor only: the engine answers operator_required to a user actor.
    write("/operator/users/create-admin", createAdminBody, (actor, b, meta) =>
      api.createAdmin({
        actor,
        email: b.email,
        ...(b.name === undefined ? {} : { name: b.name }),
        reason: b.reason,
        ...meta,
      }),
    ),
    write("/operator/sessions/end-user", userReasonBody, (actor, b, meta) =>
      api.sessions.endUser({ actor, userId: b.userId, reason: b.reason, ...meta }),
    ),
    write("/operator/sessions/end-all", endAllBody, (actor, b, meta) =>
      api.sessions.endAll({
        actor,
        reason: b.reason,
        ...(b.limit === undefined ? {} : { limit: b.limit }),
        ...meta,
      }),
    ),
    read("/operator/audit", auditQuery, (actor, q) =>
      api.audit.list({
        actor,
        ...(q.targetUserId === undefined ? {} : { targetUserId: q.targetUserId }),
        ...(q.after === undefined ? {} : { after: q.after }),
        ...limitOf(q.limit),
      }),
    ),
  ];
}
