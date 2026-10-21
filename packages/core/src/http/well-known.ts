import type { ResolvedConfig } from "../config.js";
import { issuerOf, mintConfig } from "../engine/jwt.js";
import { AUTH_METHODS, SUBJECT_TYPES, tokenGrantTypes } from "../engine/oauth-clients.js";
import { oauthOf } from "../engine/oauth-result.js";
import { ID_TOKEN_CLAIMS, SCOPE_CLAIMS } from "../engine/oauth-token.js";
import { FOREIGN_ALGS } from "../primitives/foreign-jwk.js";
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
export const WEBAUTHN_PATH = "/.well-known/webauthn";

/**
 * The related origins document of WebAuthn Level 3 (read 2026-10-14, plan
 * 12i), or null when this request gets none. The client fetches
 * `https://<rpId>/.well-known/webauthn`, so only a request to the `rpID`
 * host gets it, and only with `passkey.relatedOrigins` on. "The content type
 * MUST be application/json", so the type has no parameter. The ceremonies
 * check each origin against `passkey.origins` again: the document is the
 * browser's input, not core's.
 */
export function relatedOriginsAnswer(config: ResolvedConfig, request: Request): Response | null {
  const rp = config.passkey;
  if (!rp?.relatedOrigins) return null;
  if (new URL(request.url).hostname !== rp.rpID) return null;
  return json({ origins: [...rp.origins] }, 200, {
    ...PUBLIC_METADATA_HEADERS,
    "content-type": "application/json",
  });
}

/**
 * RFC 8414 section 2 and OIDC Discovery 1.0 section 3 (both read 2026-10-20).
 * Each member is what the code does under this config, no more and no less.
 * Each list reads the constant or the config value that the code reads.
 * The auth method `none` is stated: the RFC 8414 default is
 * `client_secret_basic` alone. The ID token alg list names `jwtMint.alg`
 * alone, because core signs with one key of one alg (spec 8.13 item 5).
 * OIDC Discovery asks for RS256 in it: a deployment sets
 * `jwtMint.alg: "RS256"` for that (plan 12e deviation 4).
 */
export function authorizationServerMetadata(config: ResolvedConfig): Record<string, unknown> {
  const oauth = oauthOf(config);
  const issuer = issuerOf(config);
  // Core posts a logout token only through oauth.fetch (ruling 49 of plan 12e).
  const backchannel = oauth.fetch !== null;
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    ...(oauth.dynamic ? { registration_endpoint: `${issuer}/oauth/register` } : {}),
    revocation_endpoint: `${issuer}/oauth/revoke`,
    introspection_endpoint: `${issuer}/oauth/introspect`,
    // The device routes exist only while oauth.device is on.
    ...(oauth.device !== null
      ? { device_authorization_endpoint: `${issuer}/oauth/device_authorization` }
      : {}),
    end_session_endpoint: `${issuer}/oauth/end-session`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    scopes_supported: [...oauth.scopes.keys()],
    response_types_supported: ["code"],
    // Stated: the RFC 8414 default adds `fragment`, which core does not send.
    response_modes_supported: ["query"],
    grant_types_supported: tokenGrantTypes(oauth),
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    // RFC 8414 section 2: a MUST while private_key_jwt is listed.
    token_endpoint_auth_signing_alg_values_supported: [...FOREIGN_ALGS],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    // Introspection takes a confidential client only (RFC 7662 section 4).
    introspection_endpoint_auth_methods_supported: AUTH_METHODS.filter((m) => m !== "none"),
    // Required here: without it, RFC 8414 says the server has no PKCE.
    code_challenge_methods_supported: ["S256"],
    subject_types_supported: [...SUBJECT_TYPES],
    id_token_signing_alg_values_supported: [mintConfig(config).alg],
    // RFC 9449 section 5.1: the algs of a DPoP proof at the token endpoint.
    dpop_signing_alg_values_supported: [...oauth.dpop.algs],
    claims_supported: [
      ...ID_TOKEN_CLAIMS,
      ...Object.values(SCOPE_CLAIMS).flatMap((named) => Object.keys(named)),
    ],
    // OIDC Core 3.1.2.6: core refuses `request` and `request_uri`, and ignores `claims`.
    request_parameter_supported: false,
    // Stated: the OIDC Discovery default of this member is true.
    request_uri_parameter_supported: false,
    claims_parameter_supported: false,
    backchannel_logout_supported: backchannel,
    // Each logout token holds the `sid` of the session (Back-Channel Logout 1.0 section 2.4).
    backchannel_logout_session_supported: backchannel,
    // RFC 9207: every redirect to a client carries iss.
    authorization_response_iss_parameter_supported: true,
    // The CIMD draft, section 6 (read 2026-10-13).
    client_id_metadata_document_supported: oauth.cimd,
  };
}

/**
 * RFC 9728 section 2. A client must find `resource` identical to the URL it
 * asked for (section 3.3). The DPoP algs are those that `auth.caller` takes.
 */
export function protectedResourceMetadata(
  config: ResolvedConfig,
  resource: string,
): Record<string, unknown> {
  const oauth = oauthOf(config);
  return {
    resource,
    authorization_servers: [issuerOf(config)],
    scopes_supported: [...oauth.scopes.keys()],
    bearer_methods_supported: ["header"],
    dpop_signing_alg_values_supported: [...oauth.dpop.algs],
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
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === WEBAUTHN_PATH && request.method === "GET")
      return relatedOriginsAnswer(config, request) ?? json({ error: "not_found" }, 404);
    if (!config.oauth) return json({ error: "not_found" }, 404);
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
