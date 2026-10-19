import { type Auth, createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";
import { readBearer, readSessionToken, sessionCookieNames } from "@authtempo/core/credentials";
import { insufficientScopeResponse, unauthorizedResponse } from "@authtempo/verify";

export function createProviderAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
}) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    oauth: {
      // The resources that a client may ask for. Each is the `aud` of its access tokens.
      resources: ["https://api.example.com/mcp"],
      // The app's scopes, with the text of the consent page.
      scopes: { "mcp:tools": "Use your tools" },
      // A client id may be the https URL of its metadata document. That needs
      // your own fetch, which refuses private addresses. This sample turns it off.
      // RFC 7591 registration is off by default. This sample turns it on.
      registration: { cimd: false, dynamic: true },
    },
  });
}

const RESOURCE = "https://api.example.com/mcp";

/**
 * True when the request held a bearer and no session cookie. Core lets a
 * session cookie win and never reads the bearer then, so a refused cookie
 * request names no invalid_token (RFC 6750 section 3.1). The cookie names come
 * from core.
 */
function refusedBearer(request: Request): boolean {
  if (readBearer(request) === null) return false;
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  return readSessionToken(sessionCookieNames(), { headers }) === null;
}

/** The MCP resource: an access token for this resource, with the scope of the tools. */
export async function mcpRoute(auth: Auth, request: Request): Promise<Response> {
  const c = await auth.caller(request);
  // The 401 names the scope that the route needs (MCP 2026-07-28). A bearer
  // that the route refuses adds error="invalid_token"; a cookie is no bearer.
  if (c?.kind !== "oauth")
    return unauthorizedResponse({
      resource: RESOURCE,
      scope: "mcp:tools",
      invalidToken: refusedBearer(request),
    });
  // Check the scope of each tool: a token with only openid must not call it.
  if (!c.scopes.includes("mcp:tools"))
    return insufficientScopeResponse({ resource: RESOURCE, scope: "mcp:tools" });
  // c.user is for the app; c.subject is what the client may see.
  return Response.json({ sub: c.subject, clientId: c.clientId });
}
