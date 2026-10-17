// Raw JSON-RPC lines to the built binary, with no SDK client.
//
// The request envelope of revision 2026-07-28 was read in
// @modelcontextprotocol/core 2.3.1 dist/auth-BNDyLTqp.mjs on 2026-10-17.
// Each request carries `params._meta` with the keys
// "io.modelcontextprotocol/protocolVersion" (PROTOCOL_VERSION_META_KEY),
// "io.modelcontextprotocol/clientInfo" (CLIENT_INFO_META_KEY), and
// "io.modelcontextprotocol/clientCapabilities" (CLIENT_CAPABILITIES_META_KEY).
// `server/discover` (DiscoverRequestSchema) answers `supportedVersions`,
// `capabilities`, and `instructions`.
//
// The 2025-06-18 request is the `initialize` of the lifecycle page of that
// revision (modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle,
// read 2026-10-14): `protocolVersion`, `capabilities`, and `clientInfo`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION } from "@authtempo/cli/program";
import { beforeAll, describe, expect, it } from "vitest";
import { ENV_NAME } from "../../cli/src/secrets.js";
import { INSTRUCTIONS, URL_ENV_NAME } from "../src/server.js";
import { assertFreshBuild, linesOf, PKG, REPO, runServer, type ServerRun } from "./support/bin.js";
import { assertFreshIndex, siteIndex } from "./support/index.js";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "raw-test", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const line = (id: number | null, method: string, params?: Record<string, unknown>) =>
  JSON.stringify({
    jsonrpc: "2.0",
    ...(id === null ? {} : { id }),
    method,
    ...(params ? { params } : {}),
  });
const init = (version: string) =>
  line(1, "initialize", {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: "raw-test", version: "0.0.0" },
  });

/** The tool names of plan 11e Task 5, typed here: the test does not read the table it pins. */
const DOCS_TOOLS = ["docs.search", "docs.read", "version"];

const version = (path: string) =>
  (JSON.parse(readFileSync(join(REPO, path), "utf8")) as { version: string }).version;

interface Message {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  result?: Record<string, unknown>;
  error?: unknown;
}

/** The messages of a stdout text. A line that does not parse is left out here; the stdout test counts it. */
function messages(run: ServerRun): Message[] {
  const out: Message[] = [];
  for (const l of linesOf(run.stdout)) {
    try {
      out.push(JSON.parse(l) as Message);
    } catch {
      // The stdout test reports this line.
    }
  }
  return out;
}

function result(run: ServerRun, id: number): Record<string, unknown> {
  const m = messages(run).find((x) => x.id === id && x.method === undefined);
  if (!m?.result) throw new Error(`no result for id ${id}: ${run.stdout}\n${run.stderr}`);
  return m.result;
}

const runs: Record<"discover" | "init2511" | "init2506" | "calls", ServerRun> = {} as never;

beforeAll(async () => {
  assertFreshBuild();
  assertFreshIndex();
  const [discover, init2511, init2506, calls] = await Promise.all([
    runServer(
      [],
      [line(1, "server/discover", { _meta: META }), line(2, "tools/list", { _meta: META })],
    ),
    runServer(
      [],
      [
        init("2025-11-25"),
        line(null, "notifications/initialized"),
        line(2, "tools/list"),
        line(3, "resources/list"),
        line(4, "prompts/list"),
      ],
    ),
    runServer([], [init("2025-06-18"), line(null, "notifications/initialized")]),
    runServer(
      [],
      [
        init("2025-06-18"),
        line(null, "notifications/initialized"),
        line(2, "tools/call", { name: "docs.search", arguments: { query: "magic link" } }),
        line(3, "tools/call", {
          name: "docs.read",
          arguments: { path: "/docs/guides/magic-link/" },
        }),
        line(4, "tools/call", { name: "version", arguments: {} }),
      ],
    ),
  ]);
  Object.assign(runs, { discover, init2511, init2506, calls });
}, 120_000);

describe("the stdio server on the wire", () => {
  it("answers server/discover at 2026-07-28 and lists the tools", () => {
    const run = runs.discover;
    const found = result(run, 1);
    expect(found.supportedVersions).toContain("2026-07-28");
    expect(found.instructions).toBe(INSTRUCTIONS.local);
    const tools = result(run, 2).tools as { name: string }[];
    expect(tools.map((t) => t.name).sort()).toEqual([...DOCS_TOOLS].sort());
    for (const l of linesOf(run.stdout)) expect((JSON.parse(l) as Message).jsonrpc, l).toBe("2.0");
  });

  it("answers initialize at 2025-11-25, then the lists", () => {
    const run = runs.init2511;
    expect(result(run, 1).protocolVersion).toBe("2025-11-25");
    const tools = result(run, 2).tools as {
      name: string;
      annotations: Record<string, boolean>;
      inputSchema: Record<string, unknown>;
    }[];
    expect(tools.map((t) => t.name).sort()).toEqual([...DOCS_TOOLS].sort());
    for (const t of tools) {
      expect(t.annotations, t.name).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
    }
    expect(result(run, 3).resources).toEqual([]);
    expect(result(run, 4).prompts).toEqual([]);
  });

  it("answers initialize at 2025-06-18 with the same version", () => {
    const r = result(runs.init2506, 1);
    expect(r.protocolVersion).toBe("2025-06-18");
    expect((r.serverInfo as { name: string }).name).toBe("authtempo");
    expect(r.instructions).toBe(INSTRUCTIONS.local);
  });

  it("calls each docs tool once", () => {
    const run = runs.calls;
    const index = siteIndex();
    for (const id of [2, 3, 4]) {
      const r = result(run, id);
      expect(r.isError ?? false, `id ${id}`).toBe(false);
      const content = r.content as { type: string; text: string }[];
      expect(content).toHaveLength(1);
      expect(JSON.parse(content[0]?.text ?? "null")).toEqual(r.structuredContent);
    }
    const search = result(run, 2).structuredContent as { results: { path: string }[] };
    expect(search.results[0]?.path).toBe("/docs/guides/magic-link/");
    const read = result(run, 3).structuredContent as { markdown: string };
    expect(read.markdown).toBe(
      index.pages.find((p) => p.path === "/docs/guides/magic-link/")?.markdown,
    );
    expect(result(run, 4).structuredContent).toEqual({
      core: version("packages/core/package.json"),
      cli: version("packages/cli/package.json"),
      mcp: version("packages/mcp/package.json"),
      // The CLI's value: the server answers the schema that `authtempo migrate` expects.
      schemaVersion: SCHEMA_VERSION,
      protocol: "2026-07-28",
      docsIndex: {
        commit: index.header.commit,
        pages: index.pages.length,
        builtFrom: "apps/site/src/content/docs/docs/",
      },
    });
  });

  it("writes nothing but MCP messages on stdout", () => {
    for (const [name, run] of Object.entries(runs)) {
      expect(run.stdout.length, name).toBeGreaterThan(0);
      expect(run.stdout.endsWith("\n"), name).toBe(true);
      for (const l of linesOf(run.stdout)) {
        let m: Message;
        try {
          m = JSON.parse(l) as Message;
        } catch {
          throw new Error(`${name}: a stdout line is no JSON-RPC message: ${l}`);
        }
        expect(m.jsonrpc, `${name}: ${l}`).toBe("2.0");
        expect(m.id !== undefined || typeof m.method === "string", `${name}: ${l}`).toBe(true);
      }
      // The server logs its start on stderr, never on stdout.
      expect(run.stderr, name).toContain("authtempo-mcp: root ");
    }
  });
});

describe("the flags of the binary", () => {
  it("refuses a --url-env that is no variable name, and writes no stdout", async () => {
    const r = await runServer(["--url-env", "postgres://u:p@h/db"], []);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--url-env takes the name of a variable");
    expect(r.stderr).not.toContain("u:p@h");
  });

  it("keeps the name rule of the CLI", () => {
    expect(URL_ENV_NAME.source).toBe(ENV_NAME.source);
  });

  it("refuses a flag it does not know", async () => {
    const r = await runServer(["--verbose"], []);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
  });

  it("exits 2 with the index command when the index is missing", async () => {
    const r = await runServer(["--index", join(PKG, "no-such-index.json")], []);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("run pnpm turbo run index --filter=@authtempo/mcp");
  });
});
