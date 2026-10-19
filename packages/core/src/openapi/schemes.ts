import type { AuthForm } from "../http/route-list.js";
import { API_TOKEN_PREFIX, SESSION_TOKEN_PREFIX } from "../primitives/credentials.js";
import type { OpenApiOptions } from "./deployment.js";

/** The name of each security scheme, in the order of the document (spec 25 item 8). */
export const SCHEME_NAMES = [
  "sessionCookie",
  "sessionBearer",
  "apiToken",
  "sessionJwt",
  "oauth",
  "operatorSecret",
] as const;
export type SchemeName = (typeof SCHEME_NAMES)[number];

/** The schemes of each credential form. A session is the cookie or a bearer; `none` has no scheme. */
const SCHEMES_OF: Record<AuthForm, readonly SchemeName[]> = {
  none: [],
  session: ["sessionCookie", "sessionBearer"],
  apiToken: ["apiToken"],
  sessionJwt: ["sessionJwt"],
  accessToken: ["oauth"],
  operator: ["operatorSecret"],
};

/**
 * The six security schemes of spec 25 item 8. The OAuth flow URLs are
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
    sessionJwt: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
      description: "A session JWT as the bearer.",
    },
    oauth: {
      type: "oauth2",
      description:
        "An access token of the provider, from the authorization code flow with PKCE (S256). Each client is public: the token request has no client secret.",
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
