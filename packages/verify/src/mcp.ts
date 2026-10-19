/**
 * `requireMcpAuth`: the guard of an app's own MCP server (plan 11e, spec 21).
 * The name follows Better Auth 1.7.7, read 2026-10-14; `withMcpAuth` is its pre-1.7 name.
 * The 401 and the 403 come from `unauthorized.ts`, so the challenge has one source.
 * DPoP and token introspection come through the `Verifier` (plan 12e), with no new option.
 */
import { isResourceUrl, readBearer, readDpopToken } from "@authtempo/core/credentials";
import {
  bearerChallenge,
  insufficientScopeResponse,
  unauthorizedResponse,
} from "./unauthorized.js";
import type { Verifier } from "./verifier.js";

/** The caller of an MCP request: an OAuth access token for the resource of the route. */
export interface McpCaller {
  userId: string;
  clientId: string;
  scopes: string[];
  resource: string;
  tokenId: string;
  expiresAt: Date;
}

/**
 * A `Verifier` of this package, or core's `auth`, by its `caller`.
 * The second form is structural, so this file imports no runtime code of core's main entry.
 */
export type McpSource = Verifier | { caller(request: Request): Promise<unknown> };

/** A handler throws this when the operation needs more scopes. The wrapper answers 403 for them. */
export class McpScopeError extends Error {
  readonly scopes: readonly string[];
  constructor(scopes: readonly string[]) {
    // The challenge rule checks the list here, so a wrong scope fails where the code names it.
    bearerChallenge({ scope: scopes });
    super(`authtempo verify: the operation needs the scopes ${scopes.join(" ")}`);
    this.name = "McpScopeError";
    this.scopes = [...scopes];
  }
}

/** Better Auth's `mcp()` rule: https, or http on the loopback names only. */
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

/**
 * Core's resource rule (`isResourceUrl`, its one copy), plus https or a loopback http.
 * A value that core refuses as `oauth.resources` then throws here, not at each request.
 */
function checkResource(resource: string): void {
  const url = isResourceUrl(resource) ? new URL(resource) : null;
  if (
    url === null ||
    !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)))
  )
    throw new Error(
      "authtempo verify: the MCP resource must be a resource URL of core: https, or http on 127.0.0.1 or localhost only, with no query, fragment, or user info",
    );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The caller of core's `auth.caller` when it is an OAuth caller with core's shape, else null. */
function fromCore(c: unknown): McpCaller | null {
  // Defence in depth: core's session and API token callers have no `clientId`, so the
  // shape check below refuses them too. No test can make this kind check alone decide.
  // It stays so that a future core caller with these fields is never taken for an OAuth caller.
  if (!isObject(c) || c.kind !== "oauth" || !isObject(c.user)) return null;
  const { clientId, scopes, resource, tokenId, expiresAt } = c;
  const userId = c.user.id;
  if (
    typeof userId !== "string" ||
    typeof clientId !== "string" ||
    !Array.isArray(scopes) ||
    !scopes.every((s) => typeof s === "string") ||
    typeof resource !== "string" ||
    typeof tokenId !== "string" ||
    !(expiresAt instanceof Date)
  )
    return null;
  return { userId, clientId, scopes: [...scopes], resource, tokenId, expiresAt };
}

/** The caller of a request: a caller, null for no OAuth caller, or "failed" when the source failed. */
async function callerOf(source: McpSource, request: Request): Promise<McpCaller | null | "failed"> {
  try {
    if ("verifyRequest" in source && typeof source.verifyRequest === "function") {
      const r = await source.verifyRequest(request);
      if (!r.ok) return "failed";
      if (r.value?.kind !== "oauth") return null;
      const { userId, clientId, scopes, resource, tokenId, expiresAt } = r.value;
      return { userId, clientId, scopes, resource, tokenId, expiresAt };
    }
    if ("caller" in source && typeof source.caller === "function") {
      // Core's caller reads the session cookie first and then never reads the bearer.
      // A client in a page of the auth app's origin sends the cookie with each fetch.
      // So core gets a copy with no cookie, and the bearer alone decides.
      // The copy keeps the DPoP header. Core spends the proof once for this one call,
      // so a second request with the same proof is a replay (ruling 31 of plan 12e).
      const headers = new Headers(request.headers);
      headers.delete("cookie");
      const bare = new Request(request.url, { method: request.method, headers });
      return fromCore(await source.caller(bare));
    }
  } catch {
    return "failed";
  }
  return "failed";
}

/**
 * Wraps the handler of an MCP route. The handler runs only for an OAuth access token
 * of `options.resource` that holds every entry of `options.scopes`.
 * A wrong option throws here, not at each request.
 */
export function requireMcpAuth(
  source: McpSource,
  handler: (request: Request, caller: McpCaller) => Response | Promise<Response>,
  options: {
    /** The resource of this MCP server: an `oauth.resources` entry of the auth app. */
    resource: string;
    /** The scopes that every request needs. A caller without one of them gets 403. */
    scopes?: readonly string[];
    /** The scopes that the 401 names, so a client asks for them. Default: `scopes`. */
    challengeScopes?: readonly string[];
  },
): (request: Request) => Promise<Response> {
  const { resource } = options;
  checkResource(resource);
  const scopes = options.scopes ? [...options.scopes] : undefined;
  const challengeScopes = options.challengeScopes ? [...options.challengeScopes] : scopes;
  // The challenge rule refuses offline_access, a quote, and an empty list. Check both lists now.
  if (scopes !== undefined) bearerChallenge({ resource, scope: scopes });
  if (challengeScopes !== undefined) bearerChallenge({ resource, scope: challengeScopes });
  const challenge = { resource, scope: challengeScopes };
  // A Verifier writes its own 401: it knows the scheme of the request and its DPoP algs.
  const verifier = "verifyRequest" in source ? source : null;
  const refused = (request: Request): Response =>
    verifier
      ? verifier.unauthorized({ ...challenge, request })
      : unauthorizedResponse({ ...challenge, invalidToken: true });

  return async (request) => {
    // No bearer and no DPoP token: the plain 401. A session cookie is no credential here.
    if (readBearer(request) === null && readDpopToken(request) === null)
      return verifier ? verifier.unauthorized(challenge) : unauthorizedResponse(challenge);
    const caller = await callerOf(source, request);
    // The auth app or its database did not answer: 503, never 401, and no detail.
    if (caller === "failed") return new Response(null, { status: 503 });
    if (caller === null) return refused(request);
    // A token for another resource of the same issuer.
    if (caller.resource !== resource) return refused(request);
    // Spec 20 item 17: the 403 names every scope of the operation, not only the missing ones.
    if (scopes !== undefined && !scopes.every((s) => caller.scopes.includes(s)))
      return insufficientScopeResponse({ resource, scope: scopes });
    try {
      return await handler(request, caller);
    } catch (e) {
      if (e instanceof McpScopeError)
        return insufficientScopeResponse({ resource, scope: e.scopes });
      throw e;
    }
  };
}
