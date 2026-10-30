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
import type { ScimScope } from "../../schema.js";
import {
  BODY_BUSY_RETRY_SECONDS,
  BODY_DEPTH_MAX,
  BodyBusy,
  BodyTimeout,
  BodyTooLarge,
  bodyReadable,
  jsonShapeFits,
  readBodyBytes,
} from "../body-cap.js";
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

/**
 * The most items of a SCIM body: each `[`, `{`, and `,` outside a string,
 * as for a route body (ruling 56 of the 12j lane). The scan runs before the
 * parse. Measured 2026-10-30 (Node 26, a heap of 128 MB, body-memory.test.ts):
 * before the scan, 1 MB of nesting kept 54 MB of heap, and 1 MB of `{}`
 * items 56 MB. With it, each shape past the limits peaks at 26 MB, and the
 * worst shape at them, 65536 keys, at 35 MB.
 *
 * The derivation, done 2026-10-30. The largest valid body by the bounds of
 * the engine is a Group PATCH of `PATCH_OPS_MAX` operations that name
 * `PATCH_MEMBERS_MAX` members, each with the four sub-attributes of RFC 7643
 * section 4.2: 5403 items. The PUT of such a Group holds 5013. A User keeps
 * at most `SCIM_DATA_MAX` bytes of attributes. At that bound, a body of
 * `emails` items `{"type":""}` holds 2732. The limit of a route body, 4096,
 * would refuse the PATCH and the PUT. The next power of two is 8192. The
 * limit is 8 times that, as for a route body, for the attributes that core
 * ignores. The depth limit is `BODY_DEPTH_MAX`: the deepest valid body is a
 * PATCH value of `PATCH_VALUE_DEPTH_MAX` levels under 3 levels of the
 * message. scim/limits.test.ts holds each number.
 */
export const SCIM_ITEMS_MAX = 65_536;

/** The media types that a SCIM body may carry; a parameter such as `charset` may follow. */
const BODY_MEDIA: ReadonlySet<string> = new Set([SCIM_MEDIA, "application/json"]);

/**
 * The JSON body of a SCIM request (plan 12d Task 9 Behavior 5). The type
 * must be `application/scim+json` or `application/json`, else 400
 * `invalidSyntax`. At most `SCIM_BODY_MAX` bytes through `readBodyBytes`,
 * else 413. A body that is not UTF-8 answers 400 `invalidSyntax`, as does
 * JSON that does not parse, a body read before, or a body chunk that is not
 * bytes. Each names its cause (ruling 66 Low 1). So 413 means a long body
 * only. The read holds its bytes against the budget of the large reads, and
 * past it answers 503 with `Retry-After` (ruling 51 of the 12j lane). A read
 * that stalls past its deadline answers 408 (ruling 63 b). Each is in the
 * SCIM error form, never core's JSON form. A body nested deeper than
 * `BODY_DEPTH_MAX` or with more than `SCIM_ITEMS_MAX` items answers 400
 * `invalidSyntax` before the parse (ruling 56).
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
  // The read gives null for both a body read before and a bad chunk: this check tells them apart.
  if (!bodyReadable(request))
    return {
      ok: false,
      response: scimError(400, "the body was read before", "invalidSyntax"),
    };
  let bytes: Uint8Array | null;
  try {
    bytes = await readBodyBytes(request, SCIM_BODY_MAX);
  } catch (e) {
    if (e instanceof BodyTooLarge)
      return {
        ok: false,
        response: scimError(413, `the body is more than ${SCIM_BODY_MAX} bytes`),
      };
    // A stalled body: the read stopped at its deadline and freed its bytes (ruling 63 b).
    if (e instanceof BodyTimeout)
      return { ok: false, response: scimError(408, "the body did not arrive in time") };
    if (!(e instanceof BodyBusy)) throw e;
    const response = scimError(503, "the large request reads of the server are busy");
    response.headers.set("retry-after", String(BODY_BUSY_RETRY_SECONDS));
    return { ok: false, response };
  }
  if (bytes === null)
    return {
      ok: false,
      response: scimError(400, "the body holds a chunk that is not bytes", "invalidSyntax"),
    };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, response: scimError(400, "the body is not UTF-8", "invalidSyntax") };
  }
  // The shape scan of a route body, with the item limit of SCIM, before the parse.
  if (!jsonShapeFits(text, BODY_DEPTH_MAX, SCIM_ITEMS_MAX))
    return {
      ok: false,
      response: scimError(
        400,
        `the body nests deeper than ${BODY_DEPTH_MAX} or holds more than ${SCIM_ITEMS_MAX} items`,
        "invalidSyntax",
      ),
    };
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
