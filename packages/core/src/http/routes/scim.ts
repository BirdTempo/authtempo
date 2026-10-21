import type { ResolvedConfig } from "../../config.js";
import {
  listResponse,
  resourceTypes,
  scimSchemas,
  serviceProviderConfig,
} from "../../engine/scim/discovery.js";
import {
  authenticateScim,
  createScimToken,
  listScimTokens,
  revokeScimToken,
  type ScimCaller,
  scimTokenOrganization,
} from "../../engine/scim/tokens.js";
import type { ScimType } from "../../errors.js";
import { readCappedBytes } from "../../primitives/read-capped.js";
import type { ScimScope } from "../../schema.js";
import { scimTokenCreateBody, scimTokenIdBody, scimTokenListQuery } from "../contract/scim.js";
import { json } from "../json.js";
import type { RouteKey } from "../route-list.js";
import type { Route, RouteContext } from "../router.js";
import { managedBody, managedCall, readQuery } from "./sso.js";

/** The media type of every SCIM answer (RFC 7644 section 3.1). */
export const SCIM_MEDIA = "application/scim+json";
export const NS_SCIM_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
/** The largest SCIM request body: 1 MB. */
export const SCIM_BODY_MAX = 1_048_576;

/** A SCIM answer: `application/scim+json`, never cached (a list holds personal data). */
export function scimJson(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": SCIM_MEDIA, "cache-control": "no-store" },
  });
}

/**
 * The SCIM error message (RFC 7644 section 3.12): the Error URN, the status
 * as a string, the `scimType` when one applies, and the detail. A SCIM
 * route answers this shape and never a code of `ERRORS`. No detail holds a
 * token, a hash, or a value of the request body.
 */
export function scimError(status: number, detail: string, scimType?: ScimType): Response {
  return scimJson(
    {
      schemas: [NS_SCIM_ERROR],
      status: String(status),
      ...(scimType === undefined ? {} : { scimType }),
      detail,
    },
    status,
  );
}

/** The media types that a SCIM body may carry; a parameter such as `charset` may follow. */
const BODY_MEDIA: ReadonlySet<string> = new Set([SCIM_MEDIA, "application/json"]);

/**
 * The JSON body of a SCIM request (plan 12d Task 9 Behavior 5). The type
 * must be `application/scim+json` or `application/json`, else 400
 * `invalidSyntax`. At most `SCIM_BODY_MAX` bytes through `readCappedBytes`,
 * else 413. A body that is not UTF-8 answers 400 `invalidSyntax`, as does
 * JSON that does not parse. So 413 means a long body only.
 */
export async function readScimBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type === undefined || !BODY_MEDIA.has(type))
    return {
      ok: false,
      response: scimError(
        400,
        "the body must be application/scim+json or application/json",
        "invalidSyntax",
      ),
    };
  const length = request.headers.get("content-length");
  const bytes = await readCappedBytes(
    new Response(request.body, length === null ? {} : { headers: { "content-length": length } }),
    SCIM_BODY_MAX,
    request.signal,
  );
  if (bytes === null)
    return {
      ok: false,
      response: scimError(413, `the body is more than ${SCIM_BODY_MAX} bytes`),
    };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, response: scimError(400, "the body is not UTF-8", "invalidSyntax") };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: scimError(400, "the body is not JSON", "invalidSyntax") };
  }
}

/** One SCIM route: its scope (`any` for discovery), and whether it reads a body. */
export interface ScimRouteSpec {
  method: Route["method"];
  path: string;
  key: RouteKey;
  scope: ScimScope | "any";
  body: boolean;
  handle(ctx: RouteContext, caller: ScimCaller, body: unknown): Promise<Response>;
}

/**
 * Builds one route under `/scim/v2` (plan 12d Task 9 Behavior 3). Every
 * SCIM route runs these steps in this order: the token (`authenticateScim`),
 * then the scope, then the body. A failed token answers 401 with
 * `WWW-Authenticate: Bearer realm="scim"`, or 429. A token without the
 * scope of the route answers 403 with no `scimType`. The body of a caller
 * with no token is never read. Tasks 10 and 11 mount their routes here.
 */
export function scimRoute(config: ResolvedConfig, spec: ScimRouteSpec): Route {
  return {
    method: spec.method,
    path: spec.path,
    key: spec.key,
    async handler(ctx) {
      const auth = await authenticateScim(config, ctx.request, ctx.ip);
      if (!auth.ok) {
        if (auth.status === 429) return scimError(429, "too many requests; try again later");
        const res = scimError(401, "the request needs a valid SCIM token as its bearer");
        res.headers.set("www-authenticate", 'Bearer realm="scim"');
        return res;
      }
      if (spec.scope !== "any" && !auth.caller.scopes.has(spec.scope))
        return scimError(403, `the token does not hold the scope ${spec.scope}`);
      if (!spec.body) return spec.handle(ctx, auth.caller, undefined);
      const read = await readScimBody(ctx.request);
      if (!read.ok) return read.response;
      return spec.handle(ctx, auth.caller, read.value);
    },
  };
}

/**
 * The discovery lists ignore the query parameters of RFC 7644 section
 * 3.4.2, as section 4 says. A filter answers 403, as section 4 asks, so a
 * client does not read the list as a match of its filter.
 */
function discoveryList(ctx: RouteContext, resources: readonly unknown[]): Response {
  if (ctx.url.searchParams.has("filter"))
    return scimError(403, "the discovery lists take no filter");
  return scimJson(listResponse(resources));
}

/** One discovery resource by id, or 404. */
function discoveryOne(ctx: RouteContext, resources: readonly Record<string, unknown>[]): Response {
  const id = ctx.params.id ?? "";
  const hit = resources.find((r) => r.id === id);
  return hit ? scimJson(hit) : scimError(404, "no resource of this endpoint has the id");
}

/** RFC 7644 section 3.12 names 501 for an operation that the server does not serve. */
function notSupported(): Promise<Response> {
  return Promise.resolve(scimError(501, "not supported by this server"));
}

/**
 * The SCIM routes (plan 12d Task 9): the token routes of an organization's
 * manager, and the base of the SCIM server under `/scim/v2`. They exist
 * when `scim` is on. The token routes run the steps of the SSO manager
 * routes (`managedCall`). Every `/scim/v2` route takes a SCIM token and no
 * session.
 */
export function scimRoutes(config: ResolvedConfig): Route[] {
  if (!config.scim) return [];
  const meta = (ctx: RouteContext) => ({
    ip: ctx.ip,
    userAgent: ctx.request.headers.get("user-agent"),
  });
  const discovery = (path: string, key: RouteKey, handle: ScimRouteSpec["handle"]) =>
    scimRoute(config, { method: "GET", path, key, scope: "any", body: false, handle });
  const refused = (method: "GET" | "POST", path: string, key: RouteKey) =>
    scimRoute(config, { method, path, key, scope: "any", body: false, handle: notSupported });
  return [
    {
      method: "GET",
      path: "/scim/tokens",
      key: "GET /scim/tokens",
      handler: (ctx) =>
        managedCall(
          config,
          ctx,
          async (c) => readQuery(c.url, scimTokenListQuery),
          async (q) => q.organizationId,
          (actor, q) => listScimTokens(config, actor, q),
          (tokens) => json({ tokens }),
        ),
    },
    {
      method: "POST",
      path: "/scim/tokens/create",
      key: "POST /scim/tokens/create",
      handler: (ctx) =>
        managedCall(
          config,
          ctx,
          managedBody(scimTokenCreateBody),
          async (b) => b.organizationId,
          (actor, b) => createScimToken(config, actor, b, meta(ctx)),
          (created) => json(created),
        ),
    },
    {
      method: "POST",
      path: "/scim/tokens/revoke",
      key: "POST /scim/tokens/revoke",
      handler: (ctx) =>
        managedCall(
          config,
          ctx,
          managedBody(scimTokenIdBody),
          (b) => scimTokenOrganization(config, b.id),
          (actor, b) => revokeScimToken(config, actor, b, meta(ctx)),
          (value) => json(value),
        ),
    },
    discovery("/scim/v2/ServiceProviderConfig", "GET /scim/v2/ServiceProviderConfig", async () =>
      scimJson(serviceProviderConfig(config)),
    ),
    discovery("/scim/v2/ResourceTypes", "GET /scim/v2/ResourceTypes", async (ctx) =>
      discoveryList(ctx, resourceTypes(config)),
    ),
    discovery("/scim/v2/ResourceTypes/:id", "GET /scim/v2/ResourceTypes/:id", async (ctx) =>
      discoveryOne(ctx, resourceTypes(config)),
    ),
    discovery("/scim/v2/Schemas", "GET /scim/v2/Schemas", async (ctx) =>
      discoveryList(ctx, scimSchemas(config)),
    ),
    discovery("/scim/v2/Schemas/:id", "GET /scim/v2/Schemas/:id", async (ctx) =>
      discoveryOne(ctx, scimSchemas(config)),
    ),
    // The refusals of the design's 9.5, and the two resource searches. Without the two,
    // a search of a directory meets a 404 that does not say "not supported".
    refused("POST", "/scim/v2/Bulk", "POST /scim/v2/Bulk"),
    refused("GET", "/scim/v2/Me", "GET /scim/v2/Me"),
    refused("POST", "/scim/v2/.search", "POST /scim/v2/.search"),
    refused("POST", "/scim/v2/Users/.search", "POST /scim/v2/Users/.search"),
    refused("POST", "/scim/v2/Groups/.search", "POST /scim/v2/Groups/.search"),
  ];
}
