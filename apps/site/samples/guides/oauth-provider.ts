import { type Auth, createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

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

const METADATA =
  'resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"';

/** The MCP resource: an access token for this resource, with the scope of the tools. */
export async function mcpRoute(auth: Auth, request: Request): Promise<Response> {
  const c = await auth.caller(request);
  if (c?.kind !== "oauth")
    return Response.json(
      { error: "unauthorized" },
      { status: 401, headers: { "www-authenticate": `Bearer ${METADATA}` } },
    );
  // Check the scope of each tool: a token with only openid must not call it.
  if (!c.scopes.includes("mcp:tools"))
    return Response.json(
      { error: "insufficient_scope" },
      {
        status: 403,
        headers: {
          "www-authenticate": `Bearer error="insufficient_scope", scope="mcp:tools", ${METADATA}`,
        },
      },
    );
  return Response.json({ sub: c.user.id, clientId: c.clientId });
}
