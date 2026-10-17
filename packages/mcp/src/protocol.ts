// The seam to the MCP SDK (@modelcontextprotocol/server 2.3.1). This is the
// one file that imports the SDK. A change of the SDK, or another SDK, plugs
// into the same two calls: serveStdio and httpHandler. The names were read in
// dist/index.d.mts, dist/stdio.d.mts, and the createMcpHandler declaration
// file on 2026-10-17 ($SCRATCH/plan-11e-task-5-sdk.md).
import {
  createMcpHandler,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  type Transport,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServerSpec, ToolImpl } from "./spec.js";

/** One instance, so the JSON Schema of a listing holds its definition once. */
const JSON_VALUE = z.json();

/**
 * The output schema of a row: a strict object with exactly the row's output
 * keys. The SDK checks a result against it, and skips the check for a tool
 * fault (isError), whose structured content has its own keys.
 */
function outputSchema(keys: readonly string[]) {
  return z.strictObject(Object.fromEntries(keys.map((k) => [k, JSON_VALUE])));
}

function registerTool(server: McpServer, impl: ToolImpl): void {
  const { row } = impl;
  server.registerTool(
    row.name,
    {
      title: row.title,
      description: row.description,
      inputSchema: row.input,
      outputSchema: outputSchema(row.outputKeys),
      annotations: { ...row.annotations },
    },
    async (input: unknown) => {
      const r = await impl.call(input as Record<string, unknown>);
      // structuredContent, and the same JSON in one text block, for a client
      // that reads only the content blocks.
      return {
        content: [{ type: "text" as const, text: r.text ?? JSON.stringify(r.structured) }],
        structuredContent: r.structured,
        isError: r.isError,
      };
    },
  );
}

/** A fresh McpServer for one connection or one request, from a spec. */
function build(spec: ServerSpec): McpServer {
  const server = new McpServer(
    { name: spec.name, version: spec.version },
    {
      instructions: spec.instructions,
      // Declared, so the lists answer empty and never "Method not found",
      // while a surface has no resource or prompt. listChanged is false: spec
      // 21 item 14 leaves list changes out, and the SDK fills true when unset.
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
        prompts: { listChanged: false },
      },
    },
  );
  for (const impl of spec.tools) registerTool(server, impl);
  for (const t of spec.resources.templates)
    server.registerResource(
      t.name,
      // No list callback: the list handler below pages the list of the spec.
      new ResourceTemplate(t.uriTemplate, { list: undefined }),
      { title: t.title, description: t.description, mimeType: t.mimeType },
      async (uri) => {
        const text = spec.resources.read(uri.href);
        // An unknown resource is a protocol error -32602 with the URI in its data (spec 21 item 9).
        if (text === null) throw new ResourceNotFoundError(uri.href);
        return { contents: [{ uri: uri.href, mimeType: t.mimeType, text }] };
      },
    );
  // The SDK's resources/list handler ignores the cursor and gives no
  // nextCursor (@modelcontextprotocol/server 2.3.1, dist/mcp-DIH4cS6P.mjs:1880,
  // read 2026-10-17). So the seam replaces that one handler and pages the
  // list. setRequestHandler replaces a handler that exists (2.3.1).
  // protocol-raw.test.ts fails when the SDK handler answers again. A cursor
  // that the list did not give is the protocol error -32602 (InvalidParams),
  // because the request has a parameter that is not valid.
  server.server.setRequestHandler("resources/list", async (request) => {
    const cursor = request.params?.cursor;
    const page = spec.resources.list(cursor);
    if (page === null)
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `the cursor ${String(cursor)} is not valid`,
      );
    return {
      resources: page.resources.map((r) => ({ ...r })),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  });
  for (const p of spec.prompts)
    server.registerPrompt(
      p.name,
      {
        title: p.title,
        description: p.description,
        // A strict object: an argument that the prompt does not name is the
        // protocol error -32602, as an unknown tool input is an input error
        // (plan 11e Task 14, review I-6 of Task 5). A free argument takes the
        // schema of its tool input; with no schema, 1 to 2048 characters.
        argsSchema: z.strictObject(
          Object.fromEntries(
            p.args.map((a) => {
              const [first, ...rest] = a.values;
              const value =
                first !== undefined
                  ? z.enum([first, ...rest])
                  : (a.schema ?? z.string().min(1).max(2048));
              const schema = value.describe(a.description);
              return [a.name, a.required ? schema : schema.optional()];
            }),
          ),
        ),
      },
      (args: unknown) => ({
        description: p.description,
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: p.text(args as Record<string, string>) },
          },
        ],
      }),
    );
  return server;
}

/**
 * Serves a spec on stdio: one server per connection. The SDK's legacy option
 * "serve" answers the 2025-era initialize handshake from the same factory,
 * and a 2026-07-28 opening gets the modern era. `transport` replaces the
 * process's stdio, for a test that connects in process. `streams` gives the
 * SDK's stdio transport another input and output, such as a filtered stdin.
 * The SDK writes only protocol messages to stdout. An error report goes to stderr.
 */
export async function serveStdio(
  spec: ServerSpec,
  opts: { transport?: Transport; streams?: { input: unknown; output: unknown } } = {},
): Promise<void> {
  // The stdio module reads node:stream. A dynamic import keeps it out of the
  // remote Worker's module graph at load, where only httpHandler runs.
  const stdio = await import("@modelcontextprotocol/server/stdio");
  // The streams are Node streams; this file names no Node type, so the files
  // of the remote surface stay free of Node modules.
  const transport =
    opts.transport ??
    (opts.streams
      ? new stdio.StdioServerTransport(opts.streams.input as never, opts.streams.output as never)
      : undefined);
  stdio.serveStdio(() => build(spec), {
    legacy: "serve",
    onerror: (e) => console.error(`authtempo-mcp: ${e.message}`),
    ...(transport === undefined ? {} : { transport }),
  });
}

/**
 * A fetch handler for the remote surface: one fresh server per request. The
 * legacy option "stateless" answers 2025-era requests from the same factory.
 * `onerror` gets each error that the SDK reports, such as a refused request.
 * The default writes one stderr line. The remote Worker passes a handler that
 * writes nothing, because the SDK's text can hold header and body values.
 */
export function httpHandler(
  factory: () => ServerSpec,
  opts: { onerror?: (error: Error) => void } = {},
): (request: Request) => Promise<Response> {
  const handler = createMcpHandler(() => build(factory()), {
    legacy: "stateless",
    onerror: opts.onerror ?? ((e) => console.error(`authtempo-mcp: ${e.message}`)),
  });
  return (request) => handler.fetch(request);
}
