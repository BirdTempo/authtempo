// The stdio rule (plan 11e Task 15, spec 21 item 2): the local server writes
// only MCP messages on stdout. A scan of src finds no write to stdout outside
// the seam and the binary, and a run of the built binary shows that each
// byte on stdout is part of a JSON-RPC frame, also for each local tool.
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../cli/test/support/pg.js";
import { assertFreshBuild, PKG, REPO, runServer } from "./support/bin.js";
import { type FixtureRoot, fixtureRoot } from "./support/fixture-root.js";
import { assertFreshIndex } from "./support/index.js";

const SRC = join(PKG, "src");

/**
 * A write to stdout. console.log, info, debug, dir, dirxml, and table write
 * to stdout in Node; console.error, warn, and trace write to stderr.
 */
const STDOUT_WRITE = /console\.(log|info|debug|dir|dirxml|table)\b|process\.stdout\b/;

/** The files that may write to stdout: the seam, which writes the frames, and the binary. */
const MAY_WRITE = (file: string) => file === "protocol.ts" || file.startsWith("bin/");

describe("the writes to stdout", () => {
  it("holds no console.log in src", () => {
    const files = readdirSync(SRC, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts"));
    // A scan that reads no file proves nothing.
    expect(files.length).toBeGreaterThan(10);
    const found: string[] = [];
    for (const file of files) {
      if (MAY_WRITE(file)) continue;
      readFileSync(join(SRC, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (STDOUT_WRITE.test(line)) found.push(`src/${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(found).toEqual([]);
  });
});

/** The answer to a line that is not JSON (JSON-RPC 2.0, section 5.1), written out here. */
const PARSE_ERROR = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };

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
    const calls: [string, Record<string, unknown>][] = [
      ["scaffold", { dir: "app", stack: "workers-d1" }],
      ["migrate.plan", { ...users, against: "empty" }],
      ["migrate.plan", { ...users, against: "database" }],
      // No plan has this id: the tool refuses it before the CLI runs.
      ["migrate.run", { ...users, plan_id: "mp_none", confirm: true }],
      ["schema.migrate", { dry_run: true }],
      ["check", { base_url: origin }],
      ["docs.search", { query: "magic link" }],
      ["docs.read", { path: "/docs/guides/magic-link/" }],
      ["version", {}],
    ];
    const line = (id: number | null, method: string, params?: Record<string, unknown>) =>
      JSON.stringify({
        jsonrpc: "2.0",
        ...(id === null ? {} : { id }),
        method,
        ...(params ? { params } : {}),
      });
    const lines = [
      line(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stdout-test", version: "0.0.0" },
      }),
      line(null, "notifications/initialized"),
      // A line that is not JSON gets the -32700 frame from the filter in front of the SDK.
      "this is not json",
      ...calls.map(([name, args], i) => line(10 + i, "tools/call", { name, arguments: args })),
      line(30, "resources/list"),
      line(31, "resources/read", { uri: "authtempo://docs/guides/magic-link" }),
      line(32, "prompts/list"),
      line(33, "prompts/get", { name: "check-deployment", arguments: {} }),
    ];
    const run = await runServer(["--root", fx.root], lines, {
      env: { DATABASE_URL: db.url },
      limitMs: 60_000,
    });

    // Each byte is in a frame: no empty line, no partial line, and a final newline.
    expect(run.stdout.endsWith("\n"), run.stdout).toBe(true);
    const frames = run.stdout.slice(0, -1).split("\n");
    const parsed = frames.map((l) => {
      let m: {
        jsonrpc?: unknown;
        id?: unknown;
        method?: unknown;
        error?: unknown;
        result?: { isError?: unknown };
      };
      try {
        m = JSON.parse(l) as typeof m;
      } catch {
        throw new Error(`a stdout line is no JSON-RPC frame: ${l}`);
      }
      expect(m.jsonrpc, l).toBe("2.0");
      expect(m.id !== undefined || typeof m.method === "string", l).toBe(true);
      return m;
    });
    // One answer to each request, and the one -32700 frame for the line that is not JSON.
    const ids = parsed.filter((m) => m.method === undefined).map((m) => m.id);
    expect(ids.filter((id) => id !== null).sort()).toEqual(
      [1, ...calls.map((_, i) => 10 + i), 30, 31, 32, 33].sort(),
    );
    expect(parsed.filter((m) => m.id === null)).toEqual([PARSE_ERROR]);
    // Each request got a result, not a protocol error. The tools that run
    // the CLI in process answered no fault, so the CLI ran and its lines stayed off stdout.
    for (const id of [...calls.map((_, i) => 10 + i), 30, 31, 32, 33]) {
      const m = parsed.find((x) => x.id === id);
      expect(m?.error, `id ${id}`).toBeUndefined();
      expect(m?.result, `id ${id}`).toBeDefined();
    }
    for (const name of ["scaffold", "migrate.plan", "schema.migrate", "check"]) {
      const i = calls.findIndex(([n]) => n === name);
      expect(parsed.find((x) => x.id === 10 + i)?.result?.isError ?? false, name).toBe(false);
    }
    expect(run.stderr).toContain("authtempo-mcp: a stdin line is not JSON: answered -32700");
  });
});
