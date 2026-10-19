/**
 * The 401 and the 403 of a resource server: RFC 6750 section 3 with the
 * resource metadata link of RFC 9728 section 5.1. `resource_metadata` names
 * the protected-resource document that `auth.wellKnown` serves for the
 * resource (spec 8.13 item 5).
 * The MCP authorization revision 2026-07-28 was read on 2026-10-14. A 401 SHOULD carry `scope`.
 * A 403 names every scope of the operation in one challenge. `offline_access` SHOULD NOT be in it.
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

/** The parameters of a challenge, checked. The order follows the examples of the MCP revision. */
function challengeParams(
  input: ChallengeInput & { error?: "invalid_token" | "insufficient_scope" | undefined },
): string[] {
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
  return parts.filter((p): p is string => p !== null);
}

/** The value of `WWW-Authenticate`. */
export function bearerChallenge(
  input: ChallengeInput & { error?: "invalid_token" | "insufficient_scope" | undefined },
): string {
  const params = challengeParams(input);
  return params.length > 0 ? `Bearer ${params.join(", ")}` : "Bearer";
}

/** RFC 7515 section 4.1.1: an alg name. A quote, a space, or a comma would break the parameter. */
const ALG = /^[A-Za-z0-9+._-]+$/;

/**
 * The value of a `DPoP` challenge (RFC 9449 section 7.1): `error` first, as
 * Figure 16 of the RFC, then `algs` and the parameters of `bearerChallenge`.
 * `algs` lists the algs that the server accepts for a proof. The RFC makes
 * `algs` a SHOULD, so a server that does not know its algs leaves it out.
 */
export function dpopChallenge(
  input: ChallengeInput & {
    algs?: readonly string[] | undefined;
    error?: "invalid_dpop_proof" | "invalid_token" | "insufficient_scope" | undefined;
  },
): string {
  if (
    input.algs !== undefined &&
    (input.algs.length === 0 || !input.algs.every((a) => ALG.test(a)))
  )
    throw new Error("authtempo verify: algs needs one or more alg names");
  // The parameters after `algs` follow the Bearer rule, so a wrong scope throws here too.
  const rest = challengeParams({ ...input, error: undefined });
  const error = input.error ? [`error="${input.error}"`] : [];
  const algs = input.algs !== undefined ? [`algs="${input.algs.join(" ")}"`] : [];
  return `DPoP ${[...error, ...algs, ...rest].join(", ")}`;
}

/** A 401 with the value of `WWW-Authenticate`. */
export function unauthorizedWith(challenge: string): Response {
  return Response.json(
    { error: "unauthorized" },
    { status: 401, headers: { "www-authenticate": challenge } },
  );
}

/** 401: no valid credential. With `invalidToken`, the request held a token that the server refused. */
export function unauthorizedResponse(input: ChallengeInput = {}): Response {
  return unauthorizedWith(
    bearerChallenge({
      ...input,
      ...(input.invalidToken ? { error: "invalid_token" as const } : {}),
    }),
  );
}

/** A 403 `insufficient_scope` with the value of `WWW-Authenticate`. */
export function insufficientScopeWith(challenge: string): Response {
  return Response.json(
    { error: "insufficient_scope" },
    { status: 403, headers: { "www-authenticate": challenge } },
  );
}

/** 403: a valid token without a scope that the operation needs. Name every scope of the operation. */
export function insufficientScopeResponse(
  input: ChallengeInput & { scope: string | readonly string[] },
): Response {
  return insufficientScopeWith(bearerChallenge({ ...input, error: "insufficient_scope" }));
}
