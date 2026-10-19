/**
 * The seam to the MCP SDK (@modelcontextprotocol/server 2.3.1). This is the
 * one file of the app that imports the SDK. It has two calls: `whoami` is
 * the answer of the one tool, and `mcpHandler` serves one request. Another
 * SDK plugs into the same two calls.
 */
import type { McpCaller } from "@authtempo/verify/mcp";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

/** The answer of the tool `whoami`: who calls, from which client, with which scopes. */
export function whoami(caller: McpCaller): { userId: string; clientId: string; scopes: string[] } {
  return { userId: caller.userId, clientId: caller.clientId, scopes: [...caller.scopes] };
}

/**
 * Serves one MCP request for a caller that `requireMcpAuth` let through.
 * One server for each request, with no session: the "stateless" legacy
 * option answers the 2025-era requests from the same factory.
 */
export function mcpHandler(request: Request, caller: McpCaller): Promise<Response> {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "my-app", version: "0.0.0" },
        { capabilities: { tools: {} } },
      );
      server.registerTool(
        "whoami",
        {
          title: "Who am I",
          description: "Answers the token subject, the client id, and the scopes of the caller.",
        },
        async () => {
          const answer = whoami(caller);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(answer) }],
            structuredContent: answer,
          };
        },
      );
      return server;
    },
    { legacy: "stateless" },
  );
  return handler.fetch(request);
}
