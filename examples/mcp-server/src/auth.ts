import { createD1Adapter, createD1Limiter } from "@authtempo/adapter-d1";
import { type Auth, createAuth, type MailPort } from "@authtempo/core";
import { dohResolve, guardedFetch } from "./fetch.js";

/** The bindings and vars of wrangler.jsonc, and the secret of `wrangler secret put AUTH_SECRET`. */
export interface Env {
  DB: D1Database;
  BASE_URL: string;
  AUTH_SECRET: string;
}

/** The resource of the MCP route: the `aud` of its access tokens. */
export function mcpResource(env: Env): string {
  return `${env.BASE_URL}/mcp`;
}

/** The scope that every call to a tool of this server needs. */
export const MCP_SCOPE = "mcp:tools";

/** The auth app: sign-in, the OAuth provider for MCP clients, and the access tokens. */
export function makeAuth(env: Env, mail: MailPort): Auth {
  return createAuth({
    baseURL: env.BASE_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.BASE_URL],
    storage: createD1Adapter(env.DB),
    // The owned limiter counts in D1, so every isolate shares one count.
    // The default limiter counts per isolate, and is for tests only.
    limiter: createD1Limiter(env.DB),
    mail,
    // An OAuth access token is a JWT that core signs, so oauth needs jwtMint.
    // The defaults: EdDSA, and a life of 15 minutes.
    jwtMint: {},
    oauth: {
      // The one resource: the MCP route. A token for it is good at /mcp only.
      resources: [mcpResource(env)],
      // The consent page shows this text for the scope.
      scopes: { [MCP_SCOPE]: "Use the tools of this server" },
      // No RFC 7591 registration: the MCP authorization revision calls it
      // deprecated. A client registers by the URL of its metadata document.
      registration: { dynamic: false },
      // Core fetches a metadata document at a URL that a stranger chose. The
      // guarded fetch refuses a host with a private address (src/fetch.ts).
      // Pass the global fetch bare: a call with a receiver throws on workerd.
      fetch: guardedFetch({ resolve: dohResolve(fetch), fetch }),
    },
  });
}
