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
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/**
 * The capabilities, as spec 21 item 14 states them: no list-change notices.
 * The SDK sets listChanged to true when a server leaves it unset.
 */
const CAPABILITIES = {
  tools: { listChanged: false },
  resources: { listChanged: false },
  prompts: { listChanged: false },
};

/** The answer to a line that is not JSON (JSON-RPC 2.0, section 5.1). */
const PARSE_ERROR = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };

/** The schema version from the D1 migration files: a source that is not core's constant. */
const SCHEMA_FILE_VERSION = Math.max(
  ...readdirSync(join(REPO, "packages/adapter-d1/migrations")).map((f) =>
    Number(/^\d{4}_schema_v(\d+)\.sql$/.exec(f)?.[1] ?? 0),
  ),
);

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

const runs: Record<"discover" | "init2511" | "init2506" | "calls" | "parse", ServerRun> =
  {} as never;

beforeAll(async () => {
  assertFreshBuild();
  assertFreshIndex();
  const [discover, init2511, init2506, calls, parse] = await Promise.all([
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
    runServer([], ["this is not json", init("2025-06-18")]),
  ]);
  Object.assign(runs, { discover, init2511, init2506, calls, parse });
}, 120_000);

describe("the stdio server on the wire", () => {
  it("answers server/discover at 2026-07-28 and lists the tools", () => {
    const run = runs.discover;
    const found = result(run, 1);
    expect(found.supportedVersions).toContain("2026-07-28");
    expect(found.capabilities).toEqual(CAPABILITIES);
    expect(found.instructions).toBe(INSTRUCTIONS.local);
    const tools = result(run, 2).tools as { name: string }[];
    expect(tools.map((t) => t.name).sort()).toEqual([...DOCS_TOOLS].sort());
    for (const l of linesOf(run.stdout)) expect((JSON.parse(l) as Message).jsonrpc, l).toBe("2.0");
  });

  it("answers initialize at 2025-11-25, then the lists", () => {
    const run = runs.init2511;
    expect(result(run, 1).protocolVersion).toBe("2025-11-25");
    expect(result(run, 1).capabilities).toEqual(CAPABILITIES);
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
    expect(result(run, 4).prompts).toEqual([]);
  });

  // The SDK's own resources/list handler (@modelcontextprotocol/server 2.3.1,
  // dist/mcp-DIH4cS6P.mjs:1880, read 2026-10-17) answers every page at once
  // and gives no nextCursor. A first page of 100 with a cursor shows that the
  // seam's handler answers. This test fails when the SDK handler answers again.
  it("pages resources/list on the wire, 100 entries a page, to a last page with no cursor", async () => {
    const n = siteIndex().pages.length;
    // The test needs a second page. A docs tree of 100 pages or fewer cannot show the cursor.
    expect(n).toBeGreaterThan(100);
    const first = result(runs.init2511, 3) as {
      resources: { uri: string }[];
      nextCursor?: unknown;
    };
    expect(first.resources).toHaveLength(100);
    for (const r of first.resources) expect(r.uri).toMatch(/^authtempo:\/\/docs\/[a-z0-9/-]+$/);
    expect(typeof first.nextCursor).toBe("string");
    const uris = first.resources.map((r) => r.uri);
    let cursor = first.nextCursor as string;
    for (let i = 0; i < 10; i++) {
      const run = await runServer(
        [],
        [
          init("2025-11-25"),
          line(null, "notifications/initialized"),
          line(2, "resources/list", { cursor }),
        ],
      );
      const page = result(run, 2) as { resources: { uri: string }[]; nextCursor?: unknown };
      expect(page.resources.length).toBeGreaterThan(0);
      expect(page.resources.length).toBeLessThanOrEqual(100);
      uris.push(...page.resources.map((r) => r.uri));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor as string;
    }
    // Every page of the index, once: the last page has no cursor.
    expect(uris).toHaveLength(n);
    expect(new Set(uris).size).toBe(n);
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
      schemaVersion: SCHEMA_FILE_VERSION,
      protocol: "2026-07-28",
      docsIndex: {
        commit: index.header.commit,
        pages: index.pages.length,
        builtFrom: "apps/site/src/content/docs/docs/",
      },
    });
  });

  it("answers a line that is not JSON with -32700, and logs one line", () => {
    const run = runs.parse;
    const first = linesOf(run.stdout)[0] ?? "";
    expect(JSON.parse(first)).toEqual(PARSE_ERROR);
    // The next request still gets its answer.
    expect(result(run, 1).protocolVersion).toBe("2025-06-18");
    const logged = linesOf(run.stderr).filter((l) => l.includes("not JSON"));
    expect(logged).toEqual(["authtempo-mcp: a stdin line is not JSON: answered -32700"]);
    // The log holds no text of the input, which can hold a secret.
    expect(run.stderr).not.toContain("this is not json");
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

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
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

  it("resolves --root by its links, and logs the target", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "authtempo-mcp-root-")));
    made.push(dir);
    const target = join(dir, "project");
    mkdirSync(target);
    symlinkSync(target, join(dir, "link"), "dir");
    const r = await runServer(["--root", join(dir, "link")], []);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`authtempo-mcp: root ${target}, `);
  });

  it("refuses a --root that does not exist, or that is a file", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "authtempo-mcp-root-")));
    made.push(dir);
    writeFileSync(join(dir, "file.txt"), "a file, not a folder\n");
    const missing = await runServer(["--root", join(dir, "no-such-folder")], []);
    expect(missing.status).toBe(2);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("does not exist");
    const file = await runServer(["--root", join(dir, "file.txt")], []);
    expect(file.status).toBe(2);
    expect(file.stdout).toBe("");
    expect(file.stderr).toContain(`the root ${join(dir, "file.txt")} is not a folder`);
  });

  it("exits 2 with the index command when the index is missing", async () => {
    const r = await runServer(["--index", join(PKG, "no-such-index.json")], []);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("run pnpm turbo run index --filter=@authtempo/mcp");
  });
});
