import { z } from "zod";
import { CHALLENGE_RE } from "../../engine/oauth-authorize.js";
import type { RouteKey } from "../route-list.js";
import { OkAnswer } from "./shapes.js";
import type { RouteContract } from "./types.js";

/** A client id of either kind: a `cl_` id or a metadata document URL of at most 2048 characters. */
export const revokeGrantBody = z.object({ clientId: z.string().min(1).max(2048) });

/** A JWK Set of the client: 1 to 10 keys. The engine rules on each key. */
const ClientKeySet = z.strictObject({
  keys: z.array(z.record(z.string(), z.unknown())).min(1).max(10),
});

/** The token endpoint auth methods of a client (plan 12e). `none` is a public client. */
const AuthMethod = z.enum(["none", "client_secret_basic", "client_secret_post", "private_key_jwt"]);

/**
 * The registration of RFC 7591 section 2 and OIDC Registration section 2,
 * read by hand: `redirect_uris` is the one required key. An omitted
 * `token_endpoint_auth_method` is `none` (plan 12e, owner decision 4). The
 * grant types are the code and the refresh, and the one response type is
 * `code`. The engine rules on each value.
 */
export const registerBody = z.object({
  redirect_uris: z.array(z.string()).min(1),
  client_name: z.string().min(1).max(80).optional(),
  token_endpoint_auth_method: AuthMethod.optional(),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).optional(),
  response_types: z.array(z.literal("code")).optional(),
  jwks: ClientKeySet.optional(),
  jwks_uri: z.string().optional(),
  post_logout_redirect_uris: z.array(z.string()).max(10).optional(),
  subject_type: z.enum(["public", "pairwise"]).optional(),
  id_token_signed_response_alg: z.string().optional(),
  dpop_bound_access_tokens: z.boolean().optional(),
});

/**
 * The authorization request of OAuth 2.1 with PKCE, read by hand. Each key
 * comes once. `request_id` alone names a request that core holds after the
 * sign-in; the engine refuses it beside another key. PKCE is optional only
 * for a confidential client that asks `openid` with a `nonce` (plan 12e,
 * `pkceRequired`). The engine refuses its absence for every other request.
 */
export const authorizeQuery = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1).max(2048),
  redirect_uri: z.string().min(1),
  code_challenge: z.string().regex(CHALLENGE_RE).optional(),
  code_challenge_method: z.literal("S256").optional(),
  scope: z.string().min(1),
  resource: z.string().min(1),
  state: z.string().max(512).optional(),
  nonce: z.string().max(512).optional(),
  prompt: z.string().optional(),
  request_id: z.string().optional(),
});

/** The consent form: the short id of the held request and the person's decision (plan 9h). */
export const consentBody = z.object({
  request_id: z.string(),
  decision: z.enum(["allow", "deny"]),
});

/** The sign-in step of an authorize request: `next` is the authorize URL to land back on. */
export const signInQuery = z.object({ next: z.string().min(1) });

/**
 * The token request of RFC 6749 section 4.1.3 and section 6, read by hand
 * as a form. The code grant takes `code`, `code_verifier`, and
 * `redirect_uri`; the refresh grant takes `refresh_token`. `resource` is
 * the audience of RFC 8707, and `scope` narrows a refresh. A
 * `client_secret_post` client sends `client_secret`; a
 * `client_secret_basic` client sends its id in the header and may omit
 * `client_id` (plan 12e).
 */
export const tokenBody = z.object({
  grant_type: z.enum(["authorization_code", "refresh_token"]),
  client_id: z.string().min(1).max(2048).optional(),
  client_secret: z.string().optional(),
  code: z.string().optional(),
  code_verifier: z.string().optional(),
  redirect_uri: z.string().optional(),
  resource: z.string().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

/** The revocation of RFC 7009 section 2.1, read by hand as a form. The client auth is that of the token route (plan 12e). */
export const revokeBody = z.object({
  token: z.string(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
});

/** The token answer of RFC 6749 section 5.1. `id_token` comes with the `openid` scope. */
export const TokenAnswerJson = z.strictObject({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int(),
  scope: z.string(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
});

/**
 * The registered client of RFC 7591 section 3.2.1, as `registerClient`
 * answers it. A secret client gets `client_secret` and
 * `client_secret_expires_at` in this one answer (plan 12e).
 */
export const RegisteredClientJson = z.strictObject({
  client_id: z.string(),
  client_id_issued_at: z.number().int(),
  client_name: z.string().optional(),
  redirect_uris: z.array(z.string()),
  token_endpoint_auth_method: AuthMethod,
  grant_types: z.array(z.string()),
  response_types: z.array(z.string()),
  jwks: ClientKeySet.optional(),
  jwks_uri: z.string().optional(),
  post_logout_redirect_uris: z.array(z.string()).optional(),
  subject_type: z.enum(["public", "pairwise"]),
  id_token_signed_response_alg: z.string(),
  dpop_bound_access_tokens: z.boolean(),
  client_secret: z.string().optional(),
  client_secret_expires_at: z.number().int().optional(),
});

/** The userinfo claims by scope (OIDC Core 1.0 section 5.3), as `userinfoClaims` answers them. */
export const UserinfoJson = z.strictObject({
  sub: z.string(),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().nullable().optional(),
  picture: z.string().nullable().optional(),
});

/** One consent of the signed-in person, as `listGrants` answers it. */
export const GrantJson = z.strictObject({
  clientId: z.string(),
  clientName: z.string().nullable(),
  scopes: z.array(z.string()),
  createdAt: z.iso.datetime(),
  refreshTokens: z.number().int().min(0),
});

const userinfo = { answer: { kind: "json", schema: UserinfoJson } } as const;
const metadata = (standard: "rfc8414" | "oidc-discovery") =>
  ({ answer: { kind: "metadata", standard } }) as const;

/** The contract of `routes/oauth.ts` (plan 11g). A provider route that redirects carries `error` to the client. */
export const OAUTH_CONTRACT = {
  "POST /oauth/register": {
    body: { schema: registerBody, media: ["json"], parsedBy: "hand" },
    answer: { kind: "json", schema: RegisteredClientJson, status: 201 },
  },
  "GET /oauth/authorize": {
    query: { schema: authorizeQuery, parsedBy: "hand" },
    // The client's redirect with the code or the error, or the sign-in page; the consent page with a session.
    answer: { kind: "redirect", param: "error" },
    alt: { kind: "html" },
  },
  "POST /oauth/authorize": {
    body: { schema: consentBody, media: ["form"], parsedBy: "hand" },
    answer: { kind: "redirect", param: "error" },
  },
  "GET /oauth/sign-in": {
    query: { schema: signInQuery, parsedBy: "hand" },
    // The sign-in page; a `next` that is not an authorize URL goes to the app's error page.
    answer: { kind: "html" },
    alt: { kind: "redirect", param: "auth_error" },
  },
  "POST /oauth/token": {
    body: { schema: tokenBody, media: ["form"], parsedBy: "hand" },
    answer: { kind: "json", schema: TokenAnswerJson },
  },
  "POST /oauth/revoke": {
    body: { schema: revokeBody, media: ["form"], parsedBy: "hand" },
    // RFC 7009 section 2.2: an empty object, for a revoked and for an unknown token.
    answer: { kind: "json", schema: z.strictObject({}) },
  },
  "GET /oauth/userinfo": userinfo,
  "POST /oauth/userinfo": userinfo,
  "GET /oauth/grants": {
    answer: { kind: "json", schema: z.strictObject({ grants: z.array(GrantJson) }) },
  },
  "POST /oauth/grants/revoke": {
    body: { schema: revokeGrantBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: OkAnswer },
  },
  "GET /.well-known/oauth-authorization-server": metadata("rfc8414"),
  "GET /.well-known/openid-configuration": metadata("oidc-discovery"),
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
