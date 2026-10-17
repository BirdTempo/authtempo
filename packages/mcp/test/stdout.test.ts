// The stdio rule (plan 11e Task 15, spec 21 item 2): the local server writes
// only MCP messages on stdout. A scan of src finds no write to stdout but two
// named lines of the binary. A run of the built binary shows that each byte on
// stdout is part of a JSON-RPC frame. The run also covers the real write paths
// of the CLI, which runs in the server's process.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../cli/test/support/pg.js";
import { assertFreshBuild, BIN, PKG, REPO } from "./support/bin.js";
import { type FixtureRoot, fixtureRoot } from "./support/fixture-root.js";
import { assertFreshIndex } from "./support/index.js";

const SRC = join(PKG, "src");

/**
 * A write to stdout. console.log, info, debug, dir, dirxml, and table write
 * to stdout in Node; console.error, warn, and trace write to stderr. The
 * forms: a call by dot or by bracket, process.stdout, a write to file
 * descriptor 1, and stdout taken from node:process.
 */
const STDOUT_WRITES = [
  /\bconsole\s*\.\s*(log|info|debug|dir|dirxml|table)\b/,
  /\bconsole\s*\[\s*["'`](log|info|debug|dir|dirxml|table)["'`]\s*\]/,
  /\bprocess\s*\.\s*stdout\b/,
  /\bprocess\s*\[\s*["'`]stdout["'`]\s*\]/,
  /\bwriteSync\s*\(\s*1\b/,
  /\bstdout\b[^;]*\bfrom\s*["'](node:)?process["']/,
  /\{[^}]*\bstdout\b[^}]*\}\s*=\s*process\b/,
];

/**
 * The lines that may write to stdout, each by file and exact text, with a
 * count. The binary gives the SDK process.stdout for the frames, and the
 * parse filter writes the -32700 frame. A new write in these files fails too.
 */
const MAY_WRITE: Readonly<Record<string, readonly string[]>> = {
  "bin/authtempo-mcp.ts": [
    "input: process.stdin.pipe(parseGuard((line) => process.stdout.write(line))),",
    "output: process.stdout,",
  ],
};

describe("the writes to stdout", () => {
  it("holds no console.log in src", () => {
    const files = readdirSync(SRC, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts"));
    // A scan that reads no file proves nothing.
    expect(files.length).toBeGreaterThan(10);
    const found: string[] = [];
    for (const file of files)
      readFileSync(join(SRC, file), "utf8")
        .split("\n")
        .forEach((line) => {
          if (STDOUT_WRITES.some((re) => re.test(line))) found.push(`${file}: ${line.trim()}`);
        });
    const allowed = Object.entries(MAY_WRITE).flatMap(([file, lines]) =>
      lines.map((l) => `${file}: ${l}`),
    );
    // Each allowed line once, and no other line.
    expect(found.sort()).toEqual(allowed.sort());
  });
});

/** The answer to a line that is not JSON (JSON-RPC 2.0, section 5.1), written out here. */
const PARSE_ERROR = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };

/** A run of the built binary, one request at a time: a later request takes a value of an answer. */
function startBinary(args: readonly string[], env: Record<string, string>) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: PKG,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let rest = "";
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    stdout += d;
    const lines = (rest + d).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const m = JSON.parse(line) as Record<string, unknown>;
        if (typeof m.id === "number") waiting.get(m.id)?.(m);
      } catch {
        // Not a frame: the check of the whole stdout text reports it.
      }
    }
  });
  child.stderr.on("data", (d: string) => {
    stderr += d;
  });
  const closed = new Promise<void>((done) => child.on("close", () => done()));
  let id = 0;
  return {
    async request(method: string, params?: Record<string, unknown>) {
      id++;
      const answer = new Promise<Record<string, unknown>>((done) => waiting.set(id, done));
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`,
      );
      return answer;
    },
    raw: (line: string) => child.stdin.write(`${line}\n`),
    async close() {
      child.stdin.end();
      await closed;
      return { stdout, stderr };
    },
  };
}

describe("the stdout of the binary", () => {
  let fx: FixtureRoot | undefined;
  let db: Awaited<ReturnType<typeof freshDatabase>> | undefined;
  let close: (() => Promise<void>) | undefined;
  beforeAll(() => {
    assertFreshBuild();
    assertFreshIndex();
  });
  afterAll(async () => {
    fx?.remove();
    await close?.();
    await db?.drop();
  });

  it("writes only JSON-RPC frames on stdout, for each tool and for a line that is not JSON", async () => {
    db = await freshDatabase();
    fx = fixtureRoot();
    mkdirSync(join(fx.root, "supabase"));
    const fixtures = join(REPO, "packages/import/test/fixtures");
    copyFileSync(join(fixtures, "supabase-users.csv"), join(fx.root, "supabase/users.csv"));
    copyFileSync(join(fixtures, "supabase-identities.csv"), join(fx.root, "supabase/ids.csv"));
    const deployment = createHttpServer((req, res) => {
      req.resume();
      req.on("end", () => res.writeHead(404).end("{}"));
    });
    await new Promise<void>((done) => deployment.listen(0, "127.0.0.1", done));
    close = () =>
      new Promise<void>((done) => {
        deployment.closeAllConnections();
        deployment.close(() => done());
      });
    const origin = `http://127.0.0.1:${(deployment.address() as AddressInfo).port}`;
    const users = {
      provider: "supabase",
      users: "supabase/users.csv",
      identities: "supabase/ids.csv",
      formats: "bcrypt",
    };

    const b = startBinary(["--root", fx.root], { DATABASE_URL: db.url });
    const answers: [string, Record<string, unknown>][] = [];
    const ask = async (what: string, method: string, params?: Record<string, unknown>) => {
      const m = await b.request(method, params);
      answers.push([what, m]);
      return m;
    };
    const tool = async (name: string, args: Record<string, unknown>) => {
      const m = await ask(name, "tools/call", { name, arguments: args });
      const r = (m.result ?? {}) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
      };
      expect(r.isError ?? false, `${name}: ${JSON.stringify(m)}`).toBe(false);
      return r.structuredContent ?? {};
    };
    await ask("initialize", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stdout-test", version: "0.0.0" },
    });
    b.raw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    // A line that is not JSON gets the -32700 frame from the filter in front of the SDK.
    b.raw("this is not json");
    await tool("scaffold", { dir: "app", stack: "workers-d1" });
    await tool("migrate.plan", { ...users, against: "empty" });
    // The real write paths of the CLI: the schema run, then the import run.
    const schemaPlan = await tool("schema.migrate", { dry_run: true });
    const schemaRun = await tool("schema.migrate", { plan_id: schemaPlan.plan_id, confirm: true });
    expect((schemaRun.applied as unknown[]).length).toBeGreaterThan(0);
    const plan = await tool("migrate.plan", { ...users, against: "database" });
    const run = await tool("migrate.run", { ...users, plan_id: plan.plan_id, confirm: true });
    expect((run.report as { dryRun?: unknown }).dryRun).toBe(false);
    await tool("check", { base_url: origin });
    await tool("docs.search", { query: "magic link" });
    await tool("docs.read", { path: "/docs/guides/magic-link/" });
    await tool("version", {});
    await ask("resources/list", "resources/list");
    await ask("resources/read", "resources/read", { uri: "authtempo://docs/guides/magic-link" });
    await ask("prompts/list", "prompts/list");
    await ask("prompts/get", "prompts/get", { name: "check-deployment", arguments: {} });
    const { stdout, stderr } = await b.close();

    // Each byte is in a frame: no empty line, no partial line, and a final newline.
    expect(stdout.endsWith("\n"), stdout).toBe(true);
    const parsed = stdout
      .slice(0, -1)
      .split("\n")
      .map((l) => {
        let m: { jsonrpc?: unknown; id?: unknown; method?: unknown };
        try {
          m = JSON.parse(l) as typeof m;
        } catch {
          throw new Error(`a stdout line is no JSON-RPC frame: ${l}`);
        }
        expect(m.jsonrpc, l).toBe("2.0");
        expect(m.id !== undefined || typeof m.method === "string", l).toBe(true);
        return m;
      });
    // One answer to each request, each a result, and the one -32700 frame.
    expect(parsed.filter((m) => typeof m.id === "number")).toHaveLength(answers.length);
    for (const [what, m] of answers) {
      expect(m.error, what).toBeUndefined();
      expect(m.result, what).toBeDefined();
    }
    expect(parsed.filter((m) => m.id === null)).toEqual([PARSE_ERROR]);
    expect(stderr).toContain("authtempo-mcp: a stdin line is not JSON: answered -32700");
  });
});
