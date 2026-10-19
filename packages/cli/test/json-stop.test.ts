import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPostgresMigrations } from "@authtempo/adapter-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECK_JSON_KEYS,
  IMPORT_JSON_KEYS,
  INFO_JSON_KEYS,
  INIT_JSON_KEYS,
  KEYS_JSON_KEYS,
  MCP_JSON_KEYS,
  MIGRATE_JSON_KEYS,
  SECRET_JSON_KEYS,
  SECRET_REWRAP_JSON_KEYS,
  SECRET_STATUS_JSON_KEYS,
  STOP_JSON,
  VERSION_JSON_KEYS,
} from "../src/json.js";
import { COMMANDS } from "../src/main.js";
import { guarded, printJson } from "../src/output.js";
import { assertFreshBuild, type BinRun, linesOf, PKG, runBin } from "./support/bin.js";
import { fakeIo } from "./support/fake-io.js";
import { freshDatabase } from "./support/pg.js";

// The stop document of --json (plan 11e deviation 19). A usage error or a
// stop with --json prints one document on stdout. It holds the empty shape
// of the command, exit 2, and the reason in stopped. A success holds exit 0
// or 1 and stopped null. One describe block for each command.

beforeAll(() => {
  assertFreshBuild();
});

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
/** A new empty folder, with each link of its path resolved. */
const fresh = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "authtempo-json-stop-")));
  made.push(dir);
  return dir;
};

/** The reason that stderr gives: the text of the stopped: line, or the first line of a usage error. */
function stderrReason(r: BinRun, usage: boolean): string {
  const lines = linesOf(r.stderr);
  if (usage) return lines[0] ?? "";
  const stopped = lines.filter((l) => l.startsWith("stopped: "));
  expect(stopped, r.stderr).toHaveLength(1);
  return (stopped[0] ?? "").slice("stopped: ".length);
}

/**
 * The common assertions of a stop. The run exits 2 and prints one JSON line
 * with the keys of the shape. The line holds exit 2 and the reason of stderr.
 */
function stopDoc(r: BinRun, keys: object, usage: boolean): Record<string, unknown> {
  expect(r.status, r.stderr).toBe(2);
  const lines = linesOf(r.stdout);
  expect(lines, r.stderr).toHaveLength(1);
  const doc = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  expect(Object.keys(doc).sort()).toEqual(Object.keys(keys).sort());
  expect(doc.exit).toBe(2);
  const reason = stderrReason(r, usage);
  expect(reason.length).toBeGreaterThan(0);
  expect(doc.stopped).toBe(reason);
  return doc;
}

/** The success document: one JSON line, the exit code of the process, and stopped null. */
function doneDoc(r: BinRun, keys: object, exit: number): Record<string, unknown> {
  expect(r.status, r.stderr).toBe(exit);
  const lines = linesOf(r.stdout);
  expect(lines).toHaveLength(1);
  const doc = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  expect(Object.keys(doc).sort()).toEqual(Object.keys(keys).sort());
  expect(doc.exit).toBe(exit);
  expect(doc.stopped).toBeNull();
  return doc;
}

/** A port with no server: a server takes a free port, and closes it. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((done) => s.listen(0, "127.0.0.1", done));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((done) => s.close(() => done()));
  return port;
}

/**
 * runBin with no block of the event loop, so a server of this process can
 * answer the command. The environment rule of runBin applies.
 */
function runBinAsync(args: readonly string[]): Promise<BinRun> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(PKG, "dist/bin/authtempo.js"), ...args], {
      cwd: PKG,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", fail);
    child.on("close", (status) => done({ status: status ?? -1, stdout, stderr }));
  });
}

describe("init --json", () => {
  it("prints the stop document on a taken folder and on a usage error, and exit 0 on a success", () => {
    const taken = fresh();
    writeFileSync(join(taken, "package.json"), "{}\n");
    const stop = runBin(["init", taken, "--stack", "node", "--json"]);
    expect(stop.stderr).toContain(`exists: ${join(taken, "package.json")}`);
    expect(stopDoc(stop, INIT_JSON_KEYS, false)).toMatchObject({
      stack: "",
      dir: "",
      files: [],
      next: [],
    });
    expect(readFileSync(join(taken, "package.json"), "utf8")).toBe("{}\n");

    const usage = runBin(["init", join(fresh(), "app"), "--stack", "nowhere", "--json"]);
    expect(stopDoc(usage, INIT_JSON_KEYS, true).files).toEqual([]);

    const dir = join(fresh(), "app");
    const done = doneDoc(runBin(["init", dir, "--stack", "node", "--json"]), INIT_JSON_KEYS, 0);
    expect(done.dir).toBe(dir);
    expect((done.files as string[]).length).toBeGreaterThan(0);
  });
});

describe("migrate --json", () => {
  it("prints the stop document on a database at a newer version and on a usage error", async () => {
    const db = await freshDatabase();
    try {
      await applyPostgresMigrations(db.sql);
      await db.sql.unsafe(
        readFileSync(join(PKG, "test/fixtures/postgres/0011_future.sql"), "utf8"),
      );
      const stop = runBin(
        ["migrate", "--target", "postgres", "--url-env", "TEST_DB_URL", "--json"],
        { env: { TEST_DB_URL: db.url } },
      );
      const doc = stopDoc(stop, MIGRATE_JSON_KEYS, false);
      expect(doc.stopped).toBe(
        "the database is at version 11; this CLI knows version 10; use a newer CLI",
      );
      expect(doc).toMatchObject({ target: "", tables: "", applied: [], pending: [] });
      // The stop document holds no part of the connection string.
      expect(stop.stdout).not.toContain(db.url);
    } finally {
      await db.drop();
    }
    const usage = runBin(["migrate", "--target", "nowhere", "--json"]);
    expect(stopDoc(usage, MIGRATE_JSON_KEYS, true).applied).toEqual([]);
  });
});

describe("import --json", () => {
  it("prints its own document on an export that does not parse, and the stop document on a usage error", () => {
    const dir = fresh();
    writeFileSync(join(dir, "users.csv"), "id,primary_email_address\n");
    writeFileSync(join(dir, "users.json"), "{");
    const args = ["--csv", join(dir, "users.csv"), "--users", join(dir, "users.json")];
    const stop = runBin([
      "import",
      "clerk",
      ...args,
      "--formats",
      "none",
      "--target",
      "memory",
      "--dry-run",
      "--json",
    ]);
    expect(stopDoc(stop, IMPORT_JSON_KEYS, false)).toMatchObject({ report: null, bundle: null });

    const usage = runBin(["import", "clerk", ...args, "--target", "nowhere", "--json"]);
    expect(stopDoc(usage, IMPORT_JSON_KEYS, true).report).toBeNull();
  });

  it("prints one document, not two, on the stop of a parsed run", () => {
    // The files parse as flags, so the run reaches runParsed, which returns 2 with its own document.
    const dir = fresh();
    writeFileSync(join(dir, "users.csv"), "id,primary_email_address\n");
    writeFileSync(join(dir, "users.json"), "{");
    const r = runBin([
      "import",
      "clerk",
      "--csv",
      join(dir, "users.csv"),
      "--users",
      join(dir, "users.json"),
      "--formats",
      "none",
      "--target",
      "memory",
      "--dry-run",
      "--json",
    ]);
    expect(r.status).toBe(2);
    expect(r.stdout.split("\n").filter((l) => l !== "")).toHaveLength(1);
    // The stopped: line comes from runParsed, not from main: no usage text follows it.
    expect(r.stderr).not.toContain("Usage:");
  });
});

describe("check --json", () => {
  let server: Server | undefined;
  afterAll(async () => {
    const s = server;
    if (s) await new Promise<void>((done) => s.close(() => done()));
  });

  it("prints the stop document when the host gives no answer and on a usage error", async () => {
    const port = await closedPort();
    const stop = runBin(["check", `http://127.0.0.1:${port}`, "--json"]);
    const doc = stopDoc(stop, CHECK_JSON_KEYS, false);
    expect(doc).toMatchObject({
      base: "",
      checks: [],
      warnings: [],
      summary: { run: 0, pass: 0, fail: 0, skip: 0 },
    });
    expect(doc.stopped).toContain("no answer");

    const usage = runBin(["check", "https://api.example.com", "--timeout", "x", "--json"]);
    expect(stopDoc(usage, CHECK_JSON_KEYS, true).checks).toEqual([]);
  });

  it("gives exit 1 and stopped null for a run with a failed check", async () => {
    // A host that answers 404 to each request: the mount check fails.
    const s = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    });
    server = s;
    await new Promise<void>((done) => s.listen(0, "127.0.0.1", done));
    const { port } = s.address() as AddressInfo;
    const r = await runBinAsync(["check", `http://127.0.0.1:${port}`, "--json"]);
    const doc = doneDoc(r, CHECK_JSON_KEYS, 1);
    expect((doc.summary as { fail: number }).fail).toBeGreaterThan(0);
  });
});

describe("keys rotate --json", () => {
  it("prints the stop document with no secret in the environment and when the host gives no answer", async () => {
    const usage = runBin(["keys", "rotate", "https://api.example.com", "--yes", "--json"]);
    expect(stopDoc(usage, KEYS_JSON_KEYS, true).kid).toBe("");
    expect(usage.stderr).toContain("set AUTHTEMPO_OPERATOR_SECRET");

    const port = await closedPort();
    const secret = "s".repeat(40);
    const stop = runBin(["keys", "rotate", `http://127.0.0.1:${port}`, "--yes", "--json"], {
      env: { AUTHTEMPO_OPERATOR_SECRET: secret },
    });
    const doc = stopDoc(stop, KEYS_JSON_KEYS, false);
    expect(doc.kid).toBe("");
    expect(doc.stopped).toContain("no answer");
    expect(stop.stdout).not.toContain(secret);
  });
});

describe("mcp --json", () => {
  it("prints its own document on another authtempo entry, and the stop document on two editor flags", () => {
    const dir = fresh();
    const other = { mcpServers: { authtempo: { command: "other", args: [] } } };
    writeFileSync(join(dir, ".mcp.json"), `${JSON.stringify(other, null, 2)}\n`);
    const before = readFileSync(join(dir, ".mcp.json"), "utf8");
    const bin = join(fresh(), "authtempo-mcp.js");
    writeFileSync(bin, "");
    const env = { AUTHTEMPO_MCP_BIN: bin };
    const merge = runBin(["mcp", dir, "--claude-code", "--json"], { env });
    // A merge stop keeps the file and the entry to add by hand (plan 11e ruling 11).
    const doc = stopDoc(merge, MCP_JSON_KEYS, false);
    expect(doc).toMatchObject({ editor: "claude-code", action: "stopped" });
    expect(doc.file).toBe(join(dir, ".mcp.json"));
    expect(doc.entry).not.toBeNull();
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe(before);

    const usage = runBin(["mcp", dir, "--claude-code", "--cursor", "--json"], { env });
    expect(stopDoc(usage, MCP_JSON_KEYS, true)).toMatchObject({
      editor: "",
      file: null,
      action: "stopped",
      entry: null,
    });
  });

  it("prints the stop document on a thrown stop: a server that is not built", () => {
    const dir = fresh();
    const r = runBin(["mcp", dir, "--cursor", "--json"], {
      env: { AUTHTEMPO_MCP_BIN: join(dir, "missing.js") },
    });
    const doc = stopDoc(r, MCP_JSON_KEYS, false);
    expect(doc).toMatchObject({ editor: "", file: null, entry: null });
    expect(doc.stopped).toContain("build @authtempo/mcp first");
  });
});

describe("authtempo secret", () => {
  it("prints the stop document on a usage error and on a taken --out path, and exit 0 on a success", () => {
    const usage = runBin(["secret", "--version", "0", "--json"]);
    expect(stopDoc(usage, SECRET_JSON_KEYS, true)).toMatchObject({
      kind: "app",
      value: null,
      version: null,
      bytes: 0,
      estimateBits: 0,
      out: null,
      secretHash: null,
    });

    const dir = fresh();
    writeFileSync(join(dir, "taken.txt"), "old\n");
    const stop = runBin(["secret", "--version", "2", "--out", "taken.txt", "--json"], { cwd: dir });
    expect(stopDoc(stop, SECRET_JSON_KEYS, false).value).toBeNull();
    expect(stop.stderr).toContain(`${join(dir, "taken.txt")} exists`);
    expect(readFileSync(join(dir, "taken.txt"), "utf8")).toBe("old\n");

    const done = doneDoc(runBin(["secret", "--version", "2", "--json"]), SECRET_JSON_KEYS, 0);
    expect(done.version).toBe(2);
    expect(typeof done.value).toBe("string");
  });
});

describe("authtempo secret status", () => {
  it("prints the stop document when the host gives no answer and on a usage error", async () => {
    const port = await closedPort();
    const secret = "s".repeat(40);
    const stop = runBin(["secret", "status", `http://127.0.0.1:${port}`, "--json"], {
      env: { AUTHTEMPO_OPERATOR_SECRET: secret },
    });
    const doc = stopDoc(stop, SECRET_STATUS_JSON_KEYS, false);
    expect(doc.versions).toEqual([]);
    expect(doc.stopped).toContain("no answer");
    expect(stop.stdout).not.toContain(secret);

    const usage = runBin([
      "secret",
      "status",
      "https://api.example.com",
      "--timeout",
      "x",
      "--json",
    ]);
    expect(stopDoc(usage, SECRET_STATUS_JSON_KEYS, true).versions).toEqual([]);
    expect(usage.stderr).toContain("Usage: authtempo secret status");
  });
});

describe("authtempo secret rewrap", () => {
  it("prints the stop document when the host gives no answer and on a usage error", async () => {
    const port = await closedPort();
    const secret = "s".repeat(40);
    const stop = runBin(["secret", "rewrap", `http://127.0.0.1:${port}`, "--yes", "--json"], {
      env: { AUTHTEMPO_OPERATOR_SECRET: secret },
    });
    const doc = stopDoc(stop, SECRET_REWRAP_JSON_KEYS, false);
    expect(doc).toMatchObject({ calls: 0, resealed: 0, failed: 0, skipped: 0, more: false });
    expect(doc.stopped).toContain("no answer");
    expect(stop.stdout).not.toContain(secret);

    const usage = runBin([
      "secret",
      "rewrap",
      "https://api.example.com",
      "--yes",
      "--timeout",
      "x",
      "--json",
    ]);
    expect(stopDoc(usage, SECRET_REWRAP_JSON_KEYS, true).calls).toBe(0);
    expect(usage.stderr).toContain("Usage: authtempo secret rewrap");
  });
});

describe("authtempo info", () => {
  it("prints the stop document on a usage error and on a stop before the report, and exit 0 on a success", () => {
    const usage = runBin(["info", "--url-env", "DATABASE_URL", "--json"]);
    expect(stopDoc(usage, INFO_JSON_KEYS, true)).toMatchObject({
      cli: "",
      schemaVersion: 0,
      runtime: { node: "", platform: "", arch: "" },
      packageManager: null,
      packages: {},
      adapters: [],
      project: null,
      env: {},
      database: null,
      deployment: null,
      unread: [],
    });
    expect(usage.stderr).toContain("--url-env needs --target postgres");
    const timeout = runBin(["info", "https://api.example.com", "--timeout", "x", "--json"]);
    expect(stopDoc(timeout, INFO_JSON_KEYS, true).deployment).toBeNull();
    expect(timeout.stderr).toContain("Usage: authtempo info");

    // A stop before the report: no wrangler config in the folder.
    const stop = runBin(["info", "--target", "d1", "--json"], { cwd: fresh() });
    expect(stopDoc(stop, INFO_JSON_KEYS, false).database).toBeNull();
    expect(stop.stderr).toContain("no wrangler.jsonc in");

    const done = doneDoc(runBin(["info", "--json"]), INFO_JSON_KEYS, 0);
    expect(done.unread).toEqual([]);
    expect(done.cli).toBe("0.0.0");
  });
});

describe("STOP_JSON", () => {
  it("holds STOP_JSON to each key list", () => {
    const lists: Record<keyof typeof STOP_JSON, object> = {
      init: INIT_JSON_KEYS,
      migrate: MIGRATE_JSON_KEYS,
      import: IMPORT_JSON_KEYS,
      check: CHECK_JSON_KEYS,
      keys: KEYS_JSON_KEYS,
      mcp: MCP_JSON_KEYS,
      secret: SECRET_JSON_KEYS,
      "secret status": SECRET_STATUS_JSON_KEYS,
      "secret rewrap": SECRET_REWRAP_JSON_KEYS,
      info: INFO_JSON_KEYS,
    };
    expect(Object.keys(STOP_JSON).sort()).toEqual(
      [
        "check",
        "import",
        "init",
        "keys",
        "mcp",
        "migrate",
        "secret",
        "secret status",
        "secret rewrap",
        "info",
      ].sort(),
    );
    for (const [name, list] of Object.entries(lists)) {
      const shape = STOP_JSON[name as keyof typeof STOP_JSON];
      expect(Object.keys(shape).sort(), name).toEqual(Object.keys(list).sort());
      expect(Object.keys(list), name).toEqual(expect.arrayContaining(["exit", "stopped"]));
      expect(shape.exit, name).toBe(2);
      expect(shape.stopped, name).toBeNull();
    }
    // --version has no stop, so its shape has neither key.
    expect(Object.keys(VERSION_JSON_KEYS)).not.toContain("exit");
    expect(Object.keys(VERSION_JSON_KEYS)).not.toContain("stopped");
  });
});

describe("STOP_JSON and the commands", () => {
  it("has a stop document for each command and each subcommand of COMMANDS", () => {
    // A new command or subcommand with no entry would print no document on a stop.
    const keys = Object.entries(COMMANDS).flatMap(([name, c]) => [
      name,
      ...Object.keys(c.subcommands ?? {}).map((sub) => `${name} ${sub}`),
    ]);
    expect(Object.keys(STOP_JSON).sort()).toEqual(keys.sort());
  });
});

describe("the scrub of a --json document", () => {
  it("holds no part of a secret that has a quote or a backslash", () => {
    const io = fakeIo();
    const ctx = guarded(io);
    const secret = 'pa"ss\\word-0123456789';
    ctx.addSecret(secret);
    // The stop document of main: the reason can hold any text of an error.
    printJson(ctx, { ...STOP_JSON.keys, exit: 2, stopped: `the deployment said ${secret}` });
    expect(io.stdout).toHaveLength(1);
    const line = io.stdout[0] ?? "";
    expect(line).not.toContain(secret);
    expect(line).not.toContain(JSON.stringify(secret).slice(1, -1));
    const doc = JSON.parse(line) as { stopped: string };
    expect(doc.stopped).toBe("the deployment said ***");
  });
});
