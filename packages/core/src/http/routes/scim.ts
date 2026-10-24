import type { ResolvedConfig } from "../../config.js";
import { NS_SCIM_ERROR, SCIM_MEDIA, scimError, scimJson } from "../../engine/scim/answer.js";
import {
  listResponse,
  resourceTypes,
  scimSchemas,
  serviceProviderConfig,
} from "../../engine/scim/discovery.js";
import {
  scimCreateGroup,
  scimDeleteGroup,
  scimGetGroup,
  scimListGroups,
  scimPatchGroup,
  scimReplaceGroup,
} from "../../engine/scim/groups.js";
import {
  authenticateScim,
  createScimToken,
  listScimTokens,
  revokeScimToken,
  type ScimCaller,
  scimTokenOrganization,
} from "../../engine/scim/tokens.js";
import {
  type ScimResult,
  scimCreateUser,
  scimDeleteUser,
  scimGetUser,
  scimListUsers,
  scimPatchUser,
  scimReplaceUser,
} from "../../engine/scim/users.js";
import { withSecrets } from "../../observe/observer.js";
import { readCappedBytes } from "../../primitives/read-capped.js";
import type { ScimScope } from "../../schema.js";
import { holdsBadText } from "../body-text.js";
import { scimTokenCreateBody, scimTokenIdBody, scimTokenListQuery } from "../contract/scim.js";
import { json } from "../json.js";
import type { RouteKey } from "../route-list.js";
import type { Route, RouteContext } from "../router.js";
import { managedBody, managedCall, readQuery } from "./sso.js";

// The answer form lives on the engine side (review l2 of plan 12d Task 9b); the routes export it too.
export { NS_SCIM_ERROR, SCIM_MEDIA, scimError, scimJson };

/** The largest SCIM request body: 1 MB. */
export const SCIM_BODY_MAX = 1_048_576;

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
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, response: scimError(400, "the body is not JSON", "invalidSyntax") };
  }
  // The port refuses a NUL or a lone surrogate in a where value (plan 12g), so the reader refuses it first.
  if (holdsBadText(value))
    return {
      ok: false,
      response: scimError(400, "the body holds a NUL or a lone surrogate", "invalidValue"),
    };
  return { ok: true, value };
}

/**
 * True for the attribute name `password`, also in the URN form that ends in
 * `:password`. A SCIM attribute name has no case (RFC 7643 section 2.1).
 */
function namesPassword(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "password" || lower.endsWith(":password");
}

/**
 * Each password of a SCIM body (ruling 60 P2 of plan 12d): the value of a
 * key `password` at any depth, and the value of a PATCH operation whose
 * path is `password`. The URN form of the key or the path counts too
 * (ruling 81 l1). Core stores none of them, and each event of the request
 * scrubs them.
 */
export function passwordsOf(body: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [body];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== "object" || value === null) continue;
    const entries = Object.entries(value);
    const path = entries.find(([k]) => k.toLowerCase() === "path")?.[1];
    for (const [key, item] of entries) {
      const named =
        namesPassword(key) ||
        (key.toLowerCase() === "value" && typeof path === "string" && namesPassword(path));
      if (named && typeof item === "string") out.push(item);
      else stack.push(item);
    }
  }
  return out;
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
export function scimRoute(spec: ScimRouteSpec): Route {
  return {
    method: spec.method,
    path: spec.path,
    key: spec.key,
    async handler(request) {
      // Each event of the request scrubs its bearer token, then each password of its body (plan 12d on 12h).
      const bearer = /^Bearer\s+(\S+)$/i.exec(
        request.request.headers.get("authorization") ?? "",
      )?.[1];
      let ctx: RouteContext = { ...request, config: withSecrets(request.config, [bearer]) };
      const auth = await authenticateScim(ctx.config, ctx.request, ctx.ip);
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
      ctx = { ...ctx, config: withSecrets(ctx.config, passwordsOf(read.value)) };
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
 * The Response of a SCIM answer. A 204 holds no body and no type (RFC 7644
 * section 3.6), and is never cached either.
 */
export function scimAnswer(result: ScimResult): Response {
  if (result.status === 204)
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  return scimJson(result.body, result.status, result.headers ?? {});
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
    scimRoute({ method: "GET", path, key, scope: "any", body: false, handle });
  const users = (
    method: Route["method"],
    path: string,
    key: RouteKey,
    scope: ScimScope,
    body: boolean,
    run: (ctx: RouteContext, caller: ScimCaller, value: unknown) => Promise<ScimResult>,
  ) =>
    scimRoute({
      method,
      path,
      key,
      scope,
      body,
      handle: async (ctx, caller, value) => scimAnswer(await run(ctx, caller, value)),
    });
  const ifMatch = (ctx: RouteContext) => ctx.request.headers.get("if-match");
  const refused = (method: "GET" | "POST", path: string, key: RouteKey) =>
    scimRoute({ method, path, key, scope: "any", body: false, handle: notSupported });
  return [
    {
      method: "GET",
      path: "/scim/tokens",
      key: "GET /scim/tokens",
      handler: (ctx) =>
        managedCall(
          ctx.config,
          ctx,
          async (c) => readQuery(c.url, scimTokenListQuery),
          async (q) => q.organizationId,
          (actor, q) => listScimTokens(ctx.config, actor, q),
          (tokens) => json({ tokens }),
        ),
    },
    {
      method: "POST",
      path: "/scim/tokens/create",
      key: "POST /scim/tokens/create",
      handler: (ctx) =>
        managedCall(
          ctx.config,
          ctx,
          managedBody(scimTokenCreateBody),
          async (b) => b.organizationId,
          (actor, b) => createScimToken(ctx.config, actor, b, meta(ctx)),
          (created) => json(created),
        ),
    },
    {
      method: "POST",
      path: "/scim/tokens/revoke",
      key: "POST /scim/tokens/revoke",
      handler: (ctx) =>
        managedCall(
          ctx.config,
          ctx,
          managedBody(scimTokenIdBody),
          (b) => scimTokenOrganization(ctx.config, b.id),
          (actor, b) => revokeScimToken(ctx.config, actor, b, meta(ctx)),
          (value) => json(value),
        ),
    },
    discovery("/scim/v2/ServiceProviderConfig", "GET /scim/v2/ServiceProviderConfig", async (ctx) =>
      scimJson(serviceProviderConfig(ctx.config)),
    ),
    discovery("/scim/v2/ResourceTypes", "GET /scim/v2/ResourceTypes", async (ctx) =>
      discoveryList(ctx, resourceTypes(ctx.config)),
    ),
    discovery("/scim/v2/ResourceTypes/:id", "GET /scim/v2/ResourceTypes/:id", async (ctx) =>
      discoveryOne(ctx, resourceTypes(ctx.config)),
    ),
    discovery("/scim/v2/Schemas", "GET /scim/v2/Schemas", async (ctx) =>
      discoveryList(ctx, scimSchemas(ctx.config)),
    ),
    discovery("/scim/v2/Schemas/:id", "GET /scim/v2/Schemas/:id", async (ctx) =>
      discoveryOne(ctx, scimSchemas(ctx.config)),
    ),
    // The Users of plan 12d Task 10, each through the builder: the token, the scope, the body.
    users("GET", "/scim/v2/Users", "GET /scim/v2/Users", "scim.users.read", false, (ctx, c) =>
      scimListUsers(ctx.config, c, ctx.url),
    ),
    users("POST", "/scim/v2/Users", "POST /scim/v2/Users", "scim.users.write", true, (ctx, c, b) =>
      scimCreateUser(ctx.config, c, b),
    ),
    users(
      "GET",
      "/scim/v2/Users/:id",
      "GET /scim/v2/Users/:id",
      "scim.users.read",
      false,
      (ctx, c) => scimGetUser(ctx.config, c, ctx.params.id ?? "", ctx.url),
    ),
    users(
      "PUT",
      "/scim/v2/Users/:id",
      "PUT /scim/v2/Users/:id",
      "scim.users.write",
      true,
      (ctx, c, b) => scimReplaceUser(ctx.config, c, ctx.params.id ?? "", b, ifMatch(ctx)),
    ),
    users(
      "PATCH",
      "/scim/v2/Users/:id",
      "PATCH /scim/v2/Users/:id",
      "scim.users.write",
      true,
      (ctx, c, b) => scimPatchUser(ctx.config, c, ctx.params.id ?? "", b, ifMatch(ctx)),
    ),
    users(
      "DELETE",
      "/scim/v2/Users/:id",
      "DELETE /scim/v2/Users/:id",
      "scim.users.write",
      false,
      (ctx, c) => scimDeleteUser(ctx.config, c, ctx.params.id ?? "", ifMatch(ctx)),
    ),
    // The Groups of plan 12d Task 11. A PATCH answers 204 unless the query asks for
    // attributes (Behavior 4), so the route hands the URL on.
    users("GET", "/scim/v2/Groups", "GET /scim/v2/Groups", "scim.groups.read", false, (ctx, c) =>
      scimListGroups(ctx.config, c, ctx.url),
    ),
    users(
      "POST",
      "/scim/v2/Groups",
      "POST /scim/v2/Groups",
      "scim.groups.write",
      true,
      (ctx, c, b) => scimCreateGroup(ctx.config, c, b),
    ),
    users(
      "GET",
      "/scim/v2/Groups/:id",
      "GET /scim/v2/Groups/:id",
      "scim.groups.read",
      false,
      (ctx, c) => scimGetGroup(ctx.config, c, ctx.params.id ?? "", ctx.url),
    ),
    users(
      "PUT",
      "/scim/v2/Groups/:id",
      "PUT /scim/v2/Groups/:id",
      "scim.groups.write",
      true,
      (ctx, c, b) => scimReplaceGroup(ctx.config, c, ctx.params.id ?? "", b, ifMatch(ctx)),
    ),
    users(
      "PATCH",
      "/scim/v2/Groups/:id",
      "PATCH /scim/v2/Groups/:id",
      "scim.groups.write",
      true,
      (ctx, c, b) => scimPatchGroup(ctx.config, c, ctx.params.id ?? "", b, ifMatch(ctx), ctx.url),
    ),
    users(
      "DELETE",
      "/scim/v2/Groups/:id",
      "DELETE /scim/v2/Groups/:id",
      "scim.groups.write",
      false,
      (ctx, c) => scimDeleteGroup(ctx.config, c, ctx.params.id ?? "", ifMatch(ctx)),
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
