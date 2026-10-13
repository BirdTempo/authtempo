import type { ResolvedConfig } from "../config.js";
import { issuerOf, mintConfig } from "../engine/jwt.js";
import { oauthOf } from "../engine/oauth-result.js";
import { json } from "./json.js";

/**
 * The metadata documents (plan 9g, spec 8.13 item 5). RFC 8414 and OIDC
 * Discovery 1.0 for the issuer `baseURL + basePath`, and RFC 9728 for each
 * resource (all three read 2026-10-13). The issuer has a path, so RFC 8414
 * section 3 puts its document at `/.well-known/oauth-authorization-server<basePath>`
 * at the origin root; consumerb's clients read it under `basePath` too, and
 * OIDC Discovery section 4 at `<issuer>/.well-known/openid-configuration`.
 * Every form answers one document.
 */

/** Public: any client reads them, from any origin, and a cache may keep them five minutes. */
export const PUBLIC_METADATA_HEADERS: Record<string, string> = {
  "cache-control": "public, max-age=300",
  "access-control-allow-origin": "*",
};

const AS_PATH = "/.well-known/oauth-authorization-server";
const OIDC_PATH = "/.well-known/openid-configuration";
const PRM_PATH = "/.well-known/oauth-protected-resource";

/**
 * RFC 8414 section 2 and OIDC Discovery section 3. The auth method `none`
 * is stated: the RFC 8414 default is `client_secret_basic`, which core does
 * not take. OIDC Discovery asks for RS256 in the alg list; core signs only
 * EdDSA or ES256, so the list names the configured alg alone (spec 8.13 item 5).
 */
export function authorizationServerMetadata(config: ResolvedConfig): Record<string, unknown> {
  const oauth = oauthOf(config);
  const issuer = issuerOf(config);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    ...(oauth.dynamic ? { registration_endpoint: `${issuer}/oauth/register` } : {}),
    revocation_endpoint: `${issuer}/oauth/revoke`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    scopes_supported: [...oauth.scopes.keys()],
    response_types_supported: ["code"],
    // Stated: the RFC 8414 default adds `fragment`, which core does not send.
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    // Required here: without it, RFC 8414 says the server has no PKCE.
    code_challenge_methods_supported: ["S256"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [mintConfig(config).alg],
    // RFC 9207: every redirect to a client carries iss.
    authorization_response_iss_parameter_supported: true,
    // The CIMD draft, section 6 (read 2026-10-13).
    client_id_metadata_document_supported: oauth.cimd,
  };
}

/** RFC 9728 section 2. A client must find `resource` identical to the URL it asked for (section 3.3). */
export function protectedResourceMetadata(
  config: ResolvedConfig,
  resource: string,
): Record<string, unknown> {
  return {
    resource,
    authorization_servers: [issuerOf(config)],
    scopes_supported: [...oauthOf(config).scopes.keys()],
    bearer_methods_supported: ["header"],
  };
}

/**
 * The resource of a protected-resource path on `origin`, or null. `rest` is
 * the path after `PRM_PATH`: "" for the root form, which answers the first
 * resource on this origin (consumerb's clients read the root form for a
 * resource with a path); else the resource whose path is `rest` (RFC 9728
 * section 3.1). A resource on another origin never answers: its client
 * would refuse the document (section 3.3).
 */
function resourceFor(config: ResolvedConfig, origin: string, rest: string): string | null {
  const resources = oauthOf(config).resources;
  if (rest === "") return resources.find((r) => new URL(r).origin === origin) ?? null;
  return (
    resources.find((r) => {
      const u = new URL(r);
      return u.origin === origin && u.pathname.replace(/\/$/, "") === rest;
    }) ?? null
  );
}

/** `auth.wellKnown`: mount it for the paths that start with `/.well-known/` at the origin root. */
export function createWellKnownHandler(
  config: ResolvedConfig,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!config.oauth) return json({ error: "not_found" }, 404);
    const url = new URL(request.url);
    const path = url.pathname;
    let body: Record<string, unknown> | null = null;
    if (
      path === AS_PATH ||
      path === `${AS_PATH}${config.basePath}` ||
      path === OIDC_PATH ||
      path === `${OIDC_PATH}${config.basePath}`
    )
      body = authorizationServerMetadata(config);
    else if (path === PRM_PATH || path.startsWith(`${PRM_PATH}/`)) {
      const resource = resourceFor(config, url.origin, path.slice(PRM_PATH.length));
      if (resource) body = protectedResourceMetadata(config, resource);
    }
    if (body === null) return json({ error: "not_found" }, 404);
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET",
          "access-control-max-age": "600",
        },
      });
    if (request.method !== "GET")
      return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
    return json(body, 200, PUBLIC_METADATA_HEADERS);
  };
}
