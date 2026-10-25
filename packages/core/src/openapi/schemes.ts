import type { AuthForm } from "../http/route-list.js";
import {
  API_TOKEN_PREFIX,
  ORGANIZATION_TOKEN_PREFIX,
  SCIM_TOKEN_PREFIX,
  SESSION_TOKEN_PREFIX,
} from "../primitives/credentials.js";
import type { OpenApiOptions } from "./deployment.js";

/** The name of each security scheme, in the order of the document (spec 25 item 8). */
export const SCHEME_NAMES = [
  "sessionCookie",
  "sessionBearer",
  "apiToken",
  "organizationToken",
  "sessionJwt",
  "oauth",
  "operatorSecret",
  "initialAccessToken",
  "clientSecretBasic",
  "oauthDpop",
  "scimToken",
] as const;
export type SchemeName = (typeof SCHEME_NAMES)[number];

/**
 * The schemes of each credential form. A session is the cookie or a bearer;
 * `sessionCookie` is the cookie only (plan 12i Task 11); `none` has no scheme.
 */
const SCHEMES_OF: Record<AuthForm, readonly SchemeName[]> = {
  none: [],
  session: ["sessionCookie", "sessionBearer"],
  sessionCookie: ["sessionCookie"],
  apiToken: ["apiToken"],
  organizationToken: ["organizationToken"],
  sessionJwt: ["sessionJwt"],
  accessToken: ["oauth"],
  dpopAccessToken: ["oauthDpop"],
  operator: ["operatorSecret"],
  initialAccessToken: ["initialAccessToken"],
  clientSecretBasic: ["clientSecretBasic"],
  scimToken: ["scimToken"],
};

/**
 * The six security schemes of spec 25 item 8, and the initial access token
 * of the register route, the client Basic auth, and the DPoP scheme (plan 12e),
 * and the organization token (plan 12k), and the SCIM token (plan 12d). The OAuth flow URLs are
 * absolute with a `serverUrl`; with none, they are absolute paths, which
 * resolve against the server of the document. A token prefix is in a
 * description only, never a value.
 */
export function securitySchemes(options: OpenApiOptions): Record<SchemeName, object> {
  const at = (path: string) => `${options.serverUrl ?? ""}${options.basePath}${path}`;
  return {
    sessionCookie: {
      type: "apiKey",
      in: "cookie",
      name: options.cookieName,
      description: "The session cookie that a sign-in sets.",
    },
    sessionBearer: {
      type: "http",
      scheme: "bearer",
      description: `A session token as the bearer. It starts with \`${SESSION_TOKEN_PREFIX}\`.`,
    },
    apiToken: {
      type: "http",
      scheme: "bearer",
      description: `An API token as the bearer. It starts with \`${API_TOKEN_PREFIX}\`.`,
    },
    organizationToken: {
      type: "http",
      scheme: "bearer",
      description: `A token of an organization as the bearer (plan 12k). It starts with \`${ORGANIZATION_TOKEN_PREFIX}\`.`,
    },
    sessionJwt: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
      description: "A session JWT as the bearer.",
    },
    oauth: {
      type: "oauth2",
      description:
        "An access token of the provider, from the authorization code flow. A public client proves itself with PKCE (S256). A confidential client sends its secret, by `client_secret_basic` or `client_secret_post`. It may omit PKCE only when it asks `openid` with a `nonce`.",
      flows: {
        authorizationCode: {
          authorizationUrl: at("/oauth/authorize"),
          tokenUrl: at("/oauth/token"),
          refreshUrl: at("/oauth/token"),
          scopes: Object.fromEntries(options.scopes),
        },
      },
    },
    operatorSecret: {
      type: "apiKey",
      in: "header",
      name: "Authorization",
      description:
        "The operator secret, as `Operator <secret>`. `Operator` is not a registered HTTP authentication scheme, so the scheme is an API key in the header.",
    },
    initialAccessToken: {
      type: "http",
      scheme: "bearer",
      description:
        "The initial access token of RFC 7591 as the bearer. The register route needs it while `oauth.registration.initialAccessTokenHash` is set.",
    },
    clientSecretBasic: {
      type: "http",
      scheme: "basic",
      description:
        "The client id and the client secret of a client with a secret, as HTTP Basic. Each half is form-encoded first (RFC 6749 section 2.3.1).",
    },
    oauthDpop: {
      type: "http",
      scheme: "DPoP",
      description:
        "A DPoP-bound access token of the provider, as `Authorization: DPoP <token>`, with a proof of its key in the `DPoP` header (RFC 9449 section 7.1). A bound token never passes as a bearer.",
    },
    scimToken: {
      type: "http",
      scheme: "bearer",
      description: `A SCIM token of an organization as the bearer (plan 12d). It starts with \`${SCIM_TOKEN_PREFIX}\`. Only the routes under \`/scim/v2\` take it.`,
    },
  };
}

/**
 * The security requirements of a route: one per scheme of each form of `auth`.
 * `none` beside another form is the empty requirement (anonymous access); a
 * route of `none` alone has no requirement.
 */
export function securityOf(auth: readonly AuthForm[]): Record<string, string[]>[] {
  if (auth.every((form) => form === "none")) return [];
  return auth.flatMap((form) =>
    form === "none" ? [{}] : SCHEMES_OF[form].map((name) => ({ [name]: [] })),
  );
}
