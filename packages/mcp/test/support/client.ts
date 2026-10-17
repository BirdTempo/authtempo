import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "../../src/protocol.js";
import type { ServerSpec } from "../../src/spec.js";

/** The answer of one tools/call, as a test reads it. */
export interface Called {
  isError: boolean;
  structured: Record<string, unknown> | undefined;
  /** The text of each content block. */
  texts: string[];
}

/**
 * An SDK client connected in process to a server spec. The client uses the
 * in-memory transport pair of @modelcontextprotocol/client 2.3.1
 * (dist/index-B-4n9P0J.d.mts, read 2026-10-17). The server side goes
 * through the seam's serveStdio.
 */
export async function connect(spec: ServerSpec): Promise<{
  client: Client;
  call(name: string, args: Record<string, unknown>): Promise<Called>;
  close(): Promise<void>;
}> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await serveStdio(spec, { transport: serverSide });
  const client = new Client({ name: "authtempo-mcp-test", version: "0.0.0" });
  await client.connect(clientSide);
  return {
    client,
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args });
      const texts: string[] = [];
      for (const block of r.content as { type: string; text?: string }[])
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      return {
        isError: r.isError === true,
        structured: r.structuredContent as Record<string, unknown> | undefined,
        texts,
      };
    },
    close: () => client.close(),
  };
}
