// The local server makes no network call at its start or for a docs tool
// (plan 11e Task 15, spec 21 item 8). The built binary runs under a preload
// that refuses each network call and logs it. A scan holds the imports of src.
// The local tools reach only their own targets, under spies in process.
import { spawn } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../cli/test/support/pg.js";
import { readIndexFile } from "../src/index-reader.js";
import { localTools } from "../src/local-tools.js";
import { createServer } from "../src/server.js";
import { assertFreshBuild, BIN, COPY, PKG, REPO } from "./support/bin.js";
import { connect } from "./support/client.js";
import { type FixtureRoot, fixtureRoot } from "./support/fixture-root.js";
import { assertFreshIndex } from "./support/index.js";

/**
 * The preload of the guarded binary. It refuses fetch, the connect of a
 * node:net socket, a dgram send or connect, each dns lookup and resolve, and
 * each child_process start. It also refuses a new worker_threads Worker,
 * because a fetch in a Worker would not meet this guard (Task 15 re-review
 * R-L1). Each try writes one stderr line first.
 */
const PRELOAD = `
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
import cp from "node:child_process";
import wt from "node:worker_threads";
const refuse = (what) => {
  process.stderr.write("network-guard: refused " + what + "\\n");
  throw new Error("network-guard refused " + what);
};
globalThis.fetch = async (input) => refuse("fetch " + String(input?.url ?? input));
net.Socket.prototype.connect = function () { refuse("socket connect"); };
dgram.Socket.prototype.send = function () { refuse("dgram send"); };
dgram.Socket.prototype.connect = function () { refuse("dgram connect"); };
for (const o of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype])
  for (const k of Object.keys(o))
    if (/^(lookup|resolve|reverse)/.test(k) && typeof o[k] === "function")
      o[k] = () => refuse("dns " + k);
for (const k of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
  cp[k] = () => refuse("child_process " + k);
wt.Worker = function Worker() { refuse("worker_threads Worker"); };
syncBuiltinESMExports();
process.stderr.write("network-guard: on\\n");
`;

/** The network modules that no file of src imports. A file that must may be named here, with its reason. */
const NETWORK_IMPORT =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:node:)?(dns|dgram|child_process|net|tls|http|https|http2|undici|worker_threads)(?:\/[a-z]+)?["']/g;
const NETWORK_FILES: Readonly<Record<string, readonly string[]>> = {};

/** The built binary under the guard preload, one request at a time. */
function startGuarded(args: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), "authtempo-mcp-guard-"));
  guards.push(dir);
  const preload = join(dir, "guard.mjs");
  writeFileSync(preload, PRELOAD);
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, BIN, ...args], {
    cwd: PKG,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let rest = "";
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    const lines = (rest + d).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      const m = JSON.parse(line) as Record<string, unknown>;
      if (typeof m.id === "number") waiting.get(m.id)?.(m);
    }
  });
  child.stderr.on("data", (d: string) => {
    stderr += d;
  });
  // A binary that exits early answers each open request with an error: the test then fails on it.
  const closed = new Promise<void>((done) =>
    child.on("close", () => {
      for (const done2 of waiting.values()) done2({ error: `the binary exited: ${stderr}` });
      done();
    }),
  );
  let id = 0;
  const send = (m: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(m)}\n`);
  return {
    async request(method: string, params?: Record<string, unknown>) {
      id++;
      const answer = new Promise<Record<string, unknown>>((done) => waiting.set(id, done));
      send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
      return answer;
    },
    notify: (method: string) => send({ jsonrpc: "2.0", method }),
    async close() {
      child.stdin.end();
      await closed;
      return { stderr };
    },
  };
}

/** The host and port, or the path, of one connect call of a socket. */
function target(args: readonly unknown[]): string {
  // net.connect passes its normalized arguments as one array.
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof first === "object" && first !== null) {
    const o = first as { host?: unknown; port?: unknown; path?: unknown };
    if (typeof o.path === "string") return o.path;
    return `${String(o.host ?? "localhost")}:${String(o.port)}`;
  }
  return `${String(args[1] ?? "localhost")}:${String(first)}`;
}

/** The URL of one fetch call. */
const urlOf = (input: unknown): string =>
  input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);

interface Seen {
  fetches: string[];
  sockets: string[];
}

/**
 * Spies on fetch and on Socket.prototype.connect. Each call is recorded. A
 * call that `allowed` refuses throws before any byte leaves the process.
 */
function watchNetwork(allowed: (where: string) => boolean = () => false): Seen {
  const seen: Seen = { fetches: [], sockets: [] };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = urlOf(input);
    seen.fetches.push(url);
    if (!allowed(url)) return Promise.reject(new Error(`no network in this test: ${url}`));
    return realFetch(input, init);
  });
  const realConnect = Socket.prototype.connect;
  vi.spyOn(Socket.prototype, "connect").mockImplementation(function (
    this: Socket,
    ...args: unknown[]
  ) {
    const where = target(args);
    seen.sockets.push(where);
    if (!allowed(where)) throw new Error(`no socket in this test: ${where}`);
    return (realConnect as (...a: unknown[]) => Socket).apply(this, args);
  });
  return seen;
}

const FIXTURES = join(REPO, "packages/import/test/fixtures");
const USERS = {
  provider: "supabase",
  users: "supabase/users.csv",
  identities: "supabase/ids.csv",
  formats: "bcrypt",
};

const fixtures: FixtureRoot[] = [];
const guards: string[] = [];
beforeAll(() => {
  assertFreshBuild();
  assertFreshIndex();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.remove();
  for (const d of guards.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the network of the local server", () => {
  it("makes no network call at the start and for the docs tools", async () => {
    // The built binary, its start included, under the preload that refuses each network call.
    const fx = fixtureRoot();
    fixtures.push(fx);
    const b = startGuarded(["--root", fx.root]);
    const ask = async (method: string, params?: Record<string, unknown>) => {
      const m = await b.request(method, params);
      expect(m.error, `${method}: ${JSON.stringify(m)}`).toBeUndefined();
      return (m.result ?? {}) as Record<string, unknown>;
    };
    await ask("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "no-network-test", version: "0.0.0" },
    });
    b.notify("notifications/initialized");
    for (const [name, args] of [
      ["version", {}],
      ["docs.search", { query: "magic link" }],
      ["docs.read", { path: "/docs/guides/magic-link/" }],
      ["docs.read", {}],
    ] as const) {
      const r = await ask("tools/call", { name, arguments: args });
      expect(r.isError ?? false, `${name}: ${JSON.stringify(r)}`).toBe(false);
    }
    const listed = (await ask("resources/list")).resources as { uri: string }[];
    expect(listed.length).toBeGreaterThan(0);
    await ask("resources/read", { uri: listed[0]?.uri ?? "" });
    expect(((await ask("prompts/list")).prompts as unknown[]).length).toBeGreaterThan(0);
    await ask("prompts/get", { name: "check-deployment", arguments: {} });
    const { stderr } = await b.close();
    // The guard was on, and it saw no network call.
    expect(stderr).toContain("network-guard: on");
    expect(stderr.split("\n").filter((l) => l.startsWith("network-guard: refused"))).toEqual([]);
  });

  it("imports no network module in src", () => {
    const files = readdirSync(join(PKG, "src"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts"));
    // A scan that reads no file proves nothing.
    expect(files.length).toBeGreaterThan(10);
    const found: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(PKG, "src", file), "utf8");
      for (const m of text.matchAll(NETWORK_IMPORT))
        if (!(NETWORK_FILES[file] ?? []).includes(m[1] ?? "")) found.push(`${file}: ${m[0]}`);
    }
    expect(found).toEqual([]);
  });

  // The scope beyond the brief: a local tool opens a socket only to the
  // place that its own input or the server's environment names. scaffold and
  // a plan against an empty store open none. check reaches the origin of
  // base_url only. A plan and a dry run against the database reach the host
  // and port of the server's connection string only.
  it("opens a socket only to the check URL and to the database of the environment", async () => {
    const db = await freshDatabase();
    const deployment = createHttpServer((req, res) => {
      req.resume();
      req.on("end", () => res.writeHead(404).end("{}"));
    });
    await new Promise<void>((done) => deployment.listen(0, "127.0.0.1", done));
    const { port } = deployment.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    const dbPort = new URL(db.url).port;
    const fx = fixtureRoot();
    fixtures.push(fx);
    mkdirSync(join(fx.root, "supabase"));
    copyFileSync(join(FIXTURES, "supabase-users.csv"), join(fx.root, "supabase/users.csv"));
    copyFileSync(join(FIXTURES, "supabase-identities.csv"), join(fx.root, "supabase/ids.csv"));
    const seen = watchNetwork(
      (where) =>
        where.startsWith(`${origin}/`) ||
        where === `127.0.0.1:${port}` ||
        new RegExp(`^(localhost|127\\.0\\.0\\.1|::1):${dbPort}$`).test(where),
    );
    const s = await connect(
      createServer({
        surface: "local",
        index: readIndexFile(COPY),
        skills: [],
        root: fx.root,
        env: { PATH: process.env.PATH ?? "", DATABASE_URL: db.url },
        local: localTools,
      }),
    );
    const step = async (name: string, args: Record<string, unknown>) => {
      const before = { fetches: seen.fetches.length, sockets: seen.sockets.length };
      const r = await s.call(name, args);
      return {
        r,
        fetches: seen.fetches.slice(before.fetches),
        sockets: seen.sockets.slice(before.sockets),
      };
    };
    try {
      const scaffold = await step("scaffold", { dir: "app", stack: "workers-d1" });
      expect(scaffold.r.isError, scaffold.r.texts.join("\n")).toBe(false);
      expect([...scaffold.fetches, ...scaffold.sockets]).toEqual([]);

      // The CLI plans the import against an empty store in memory.
      const empty = await step("migrate.plan", { ...USERS, against: "empty" });
      expect(empty.r.isError, empty.r.texts.join("\n")).toBe(false);
      expect([...empty.fetches, ...empty.sockets]).toEqual([]);

      const checked = await step("check", { base_url: origin });
      expect(checked.r.isError, checked.r.texts.join("\n")).toBe(false);
      expect(checked.fetches.length).toBeGreaterThan(0);
      for (const url of checked.fetches) expect(url.startsWith(`${origin}/`), url).toBe(true);
      expect(checked.sockets.length).toBeGreaterThan(0);
      for (const where of checked.sockets) expect(where).toBe(`127.0.0.1:${port}`);

      const dry = await step("schema.migrate", { dry_run: true });
      expect(dry.r.isError, dry.r.texts.join("\n")).toBe(false);
      expect(dry.fetches).toEqual([]);
      expect(dry.sockets.length).toBeGreaterThan(0);
      for (const where of dry.sockets) expect(where).toMatch(new RegExp(`:${dbPort}$`));

      const planned = await step("migrate.plan", { ...USERS, against: "database" });
      expect(planned.fetches).toEqual([]);
      expect(planned.sockets.length).toBeGreaterThan(0);
      for (const where of planned.sockets) expect(where).toMatch(new RegExp(`:${dbPort}$`));
    } finally {
      await s.close();
      vi.restoreAllMocks();
      deployment.closeAllConnections();
      await new Promise<void>((done) => deployment.close(() => done()));
      await db.drop();
    }
    // Every try of the run was to an allowed place: a refused try would show here.
    expect(
      [...seen.fetches, ...seen.sockets].filter(
        (w) =>
          !w.startsWith(`${origin}/`) &&
          w !== `127.0.0.1:${port}` &&
          !new RegExp(`:${dbPort}$`).test(w),
      ),
    ).toEqual([]);
  });
});
