/**
 * The 401 and the 403 of a resource server: RFC 6750 section 3 with the
 * resource metadata link of RFC 9728 section 5.1. `resource_metadata` names
 * the protected-resource document that `auth.wellKnown` serves for the
 * resource (spec 8.13 item 5). The MCP authorization revision 2026-07-28
 * (read 2026-10-14): a 401 SHOULD carry `scope`, a 403 names every scope of
 * the operation in one challenge, and `offline_access` SHOULD NOT be in it.
 */

export interface ChallengeInput {
  /** The resource of the request: an `oauth.resources` entry. Adds `resource_metadata`. */
  resource?: string | undefined;
  /** The scopes that the operation needs, as one space-separated string or a list. */
  scope?: string | readonly string[] | undefined;
  /** True when the request held a token that the server refused: adds `error="invalid_token"` to the 401. */
  invalidToken?: boolean | undefined;
  /** A short text for a person, as `error_description`. */
  description?: string | undefined;
}

/** RFC 6750 section 3: scope-token = 1*( %x21 / %x23-5B / %x5D-7E ). */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
/** RFC 6750 section 3: error_description = *( %x20-21 / %x23-5B / %x5D-7E ). */
const DESCRIPTION = /^[\x20\x21\x23-\x5B\x5D-\x7E]*$/;

/** The scope list, checked. Throws for a wrong value: a fault of the app's code. */
function scopeList(scope: string | readonly string[]): string[] {
  const list = typeof scope === "string" ? scope.split(" ").filter((t) => t !== "") : [...scope];
  if (list.length === 0) throw new Error("authtempo verify: scope needs at least one scope");
  for (const t of list) {
    if (!SCOPE_TOKEN.test(t))
      throw new Error(`authtempo verify: scope "${t}" holds a character that RFC 6750 refuses`);
    if (t === "offline_access")
      throw new Error(
        "authtempo verify: offline_access is not a resource scope; leave it out of the challenge",
      );
  }
  return list;
}

function metadataOf(resource: string): string {
  const r = new URL(resource);
  const path = r.pathname === "/" ? "" : r.pathname.replace(/\/$/, "");
  return `${r.origin}/.well-known/oauth-protected-resource${path}`;
}

/** The value of `WWW-Authenticate`. The order follows the examples of the MCP revision. */
export function bearerChallenge(
  input: ChallengeInput & { error?: "invalid_token" | "insufficient_scope" | undefined },
): string {
  const scope = input.scope !== undefined ? `scope="${scopeList(input.scope).join(" ")}"` : null;
  const metadata =
    input.resource !== undefined ? `resource_metadata="${metadataOf(input.resource)}"` : null;
  if (input.description !== undefined && !DESCRIPTION.test(input.description))
    throw new Error(
      "authtempo verify: the description holds a quote, a backslash, or a control character",
    );
  const description =
    input.description !== undefined ? `error_description="${input.description}"` : null;
  const parts =
    input.error === "insufficient_scope"
      ? [`error="insufficient_scope"`, scope, metadata, description]
      : [input.error ? `error="${input.error}"` : null, metadata, scope, description];
  const params = parts.filter((p): p is string => p !== null);
  return params.length > 0 ? `Bearer ${params.join(", ")}` : "Bearer";
}

/** 401: no valid credential. With `invalidToken`, the request held a token that the server refused. */
export function unauthorizedResponse(input: ChallengeInput = {}): Response {
  const challenge = bearerChallenge({
    ...input,
    ...(input.invalidToken ? { error: "invalid_token" as const } : {}),
  });
  return Response.json(
    { error: "unauthorized" },
    { status: 401, headers: { "www-authenticate": challenge } },
  );
}

/** 403: a valid token without a scope that the operation needs. Name every scope of the operation. */
export function insufficientScopeResponse(
  input: ChallengeInput & { scope: string | readonly string[] },
): Response {
  const challenge = bearerChallenge({ ...input, error: "insufficient_scope" });
  return Response.json(
    { error: "insufficient_scope" },
    { status: 403, headers: { "www-authenticate": challenge } },
  );
}
