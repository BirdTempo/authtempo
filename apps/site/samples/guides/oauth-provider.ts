import { type Auth, createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";
import { readBearer } from "@authtempo/core/credentials";
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
      registration: { cimd: false },
    },
  });
}

const RESOURCE = "https://api.example.com/mcp";

/** The MCP resource: an access token for this resource, with the scope of the tools. */
export async function mcpRoute(auth: Auth, request: Request): Promise<Response> {
  const c = await auth.caller(request);
  // The 401 names the scope that the route needs (MCP 2026-07-28). A bearer
  // that the route refuses adds error="invalid_token"; a cookie is no bearer.
  if (c?.kind !== "oauth")
    return unauthorizedResponse({
      resource: RESOURCE,
      scope: "mcp:tools",
      invalidToken: readBearer(request) !== null,
    });
  // Check the scope of each tool: a token with only openid must not call it.
  if (!c.scopes.includes("mcp:tools"))
    return insufficientScopeResponse({ resource: RESOURCE, scope: "mcp:tools" });
  return Response.json({ sub: c.user.id, clientId: c.clientId });
}
