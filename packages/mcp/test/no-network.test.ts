// The local server makes no network call at its start or for a docs tool
// (plan 11e Task 15, spec 21 item 8). A spy on globalThis.fetch and on the
// connect of each node:net socket sees each try, and refuses it.
import { copyFileSync, mkdirSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { CLI_VERSION } from "@authtempo/cli/program";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../cli/test/support/pg.js";
import { readIndexFile, readSkills } from "../src/index-reader.js";
import { localTools } from "../src/local-tools.js";
import { createServer } from "../src/server.js";
import { assertFreshBuild, COPY, PKG, REPO } from "./support/bin.js";
import { connect } from "./support/client.js";
import { type FixtureRoot, fixtureRoot } from "./support/fixture-root.js";
import { assertFreshIndex } from "./support/index.js";

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
beforeAll(() => {
  assertFreshBuild();
  assertFreshIndex();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.remove();
});

describe("the network of the local server", () => {
  it("makes no network call at the start and for the docs tools", async () => {
    const seen = watchNetwork();
    const fx = fixtureRoot();
    fixtures.push(fx);
    // The start of the binary: the index, the skills, the server, the session.
    const index = readIndexFile(COPY);
    const skills = readSkills(join(PKG, "skills"));
    const s = await connect(
      createServer({
        surface: "local",
        index,
        skills,
        root: fx.root,
        env: { PATH: process.env.PATH ?? "" },
        cli: CLI_VERSION,
        local: localTools,
      }),
    );
    try {
      for (const [name, args] of [
        ["version", {}],
        ["docs.search", { query: "magic link" }],
        ["docs.read", { path: "/docs/guides/magic-link/" }],
        ["docs.read", {}],
      ] as const) {
        const r = await s.call(name, args);
        expect(r.isError, `${name}: ${r.texts.join("\n")}`).toBe(false);
      }
      const listed = await s.client.listResources();
      const first = listed.resources[0]?.uri ?? "";
      expect(first).toMatch(/^authtempo:\/\/docs\//);
      const read = await s.client.readResource({ uri: first });
      expect(read.contents.length).toBeGreaterThan(0);
      const prompts = await s.client.listPrompts();
      expect(prompts.prompts.length).toBe(skills.length);
      const got = await s.client.getPrompt({ name: "check-deployment", arguments: {} });
      expect(got.messages.length).toBeGreaterThan(0);
    } finally {
      await s.close();
    }
    expect(seen.fetches).toEqual([]);
    expect(seen.sockets).toEqual([]);
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
