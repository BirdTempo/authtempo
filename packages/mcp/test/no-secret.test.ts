// The no-secret rule of the tools (plan 11e Task 15, spec 21 item 5). No
// tool input takes a secret, and no value of the server's environment
// reaches a tool result, a stderr line, or a file. The secret rule is the
// CLI's own, read from its program entry: one copy.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { NAME_ONLY_FLAGS, SECRETISH_FLAG } from "@authtempo/cli/program";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ADMIN_URL, freshDatabase } from "../../cli/test/support/pg.js";
import { TOOLS } from "../src/tools.js";
import { assertFreshBuild, BIN, PKG, REPO } from "./support/bin.js";
import { type FixtureRoot, fixtureRoot } from "./support/fixture-root.js";
import { assertFreshIndex } from "./support/index.js";

/** A connection string with a user and a password: no input may take it. */
const URL_VALUE = "postgres://u:p@h/db";

/**
 * The input keys that the secret rule matches and that take no secret, each
 * with its reason. The CLI's rule covers its string flags; base_url is the
 * CLI's positional, and the rule has no case for it.
 */
const NOT_A_SECRET: Readonly<Record<string, string>> = {
  base_url:
    "the public origin of the deployment that check reads; check sends no credential (spec 21 item 7)",
};

describe("the inputs of the tools", () => {
  it("takes no secret as an input", () => {
    let matched = 0;
    for (const t of TOOLS) {
      const schema = z.toJSONSchema(t.input) as {
        properties?: Record<string, { type?: unknown }>;
      };
      for (const [key, field] of Object.entries(t.input.shape)) {
        const flag = key.replaceAll("_", "-");
        if (!SECRETISH_FLAG.test(flag) || NAME_ONLY_FLAGS.has(flag)) continue;
        matched++;
        const where = `${t.name}: ${key}`;
        // Every matched key refuses a connection string, also a key that takes no text.
        expect((field as z.ZodType).safeParse(URL_VALUE).success, where).toBe(false);
        // A key that takes text takes the name of a variable.
        if (schema.properties?.[key]?.type === "string" && !Object.hasOwn(NOT_A_SECRET, key))
          expect(key, where).toMatch(/_env$/);
      }
    }
    // The rule reads keys of the table: firebase_signer_key_env at least. Zero is no proof.
    expect(matched).toBeGreaterThan(0);
    for (const key of Object.keys(NOT_A_SECRET))
      expect(
        TOOLS.some((t) => Object.hasOwn(t.input.shape, key)),
        `${key} is an input key`,
      ).toBe(true);
  });
});

/** The value of a variable that no output may hold. */
const PROBE = "probe-value-3";

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
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    stdout += d;
    for (const line of d.split("\n")) {
      try {
        const m = JSON.parse(line) as Record<string, unknown>;
        if (typeof m.id === "number") waiting.get(m.id)?.(m);
      } catch {
        // A part of a line; the full stdout text is checked at the end.
      }
    }
  });
  child.stderr.on("data", (d: string) => {
    stderr += d;
  });
  const closed = new Promise<void>((done) => child.on("close", () => done()));
  let id = 0;
  const send = (m: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(m)}\n`);
  return {
    async request(method: string, params: Record<string, unknown>) {
      id++;
      const answer = new Promise<Record<string, unknown>>((done) => waiting.set(id, done));
      send({ jsonrpc: "2.0", id, method, params });
      return answer;
    },
    notify: (method: string) => send({ jsonrpc: "2.0", method }),
    async close() {
      child.stdin.end();
      await closed;
      return { stdout, stderr };
    },
  };
}

type Binary = ReturnType<typeof startBinary>;

async function open(b: Binary): Promise<void> {
  await b.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "no-secret-test", version: "0.0.0" },
  });
  b.notify("notifications/initialized");
}

/** One tools/call: the structured content of the answer. */
async function call(b: Binary, name: string, args: Record<string, unknown>) {
  const m = await b.request("tools/call", { name, arguments: args });
  const result = (m.result ?? {}) as { structuredContent?: Record<string, unknown> };
  return result.structuredContent ?? {};
}

/** The text of each file under a folder, by its path. */
function filesUnder(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true }))
    if (e.isFile())
      out.set(join(e.parentPath, e.name), readFileSync(join(e.parentPath, e.name), "utf8"));
  return out;
}

const FIXTURES = join(REPO, "packages/import/test/fixtures");
const USERS = {
  provider: "supabase",
  users: "supabase/users.csv",
  identities: "supabase/ids.csv",
  formats: "bcrypt",
};

describe("the environment of the server", () => {
  const roots: FixtureRoot[] = [];
  const dbs: Awaited<ReturnType<typeof freshDatabase>>[] = [];
  let close: (() => Promise<void>) | undefined;
  /** The origin of a deployment that answers 404 to each request, for check. */
  let origin = "";
  beforeAll(() => {
    assertFreshBuild();
    assertFreshIndex();
  });
  afterAll(async () => {
    for (const f of roots) f.remove();
    await close?.();
    for (const db of dbs) await db.drop();
  });

  /** A root with the Supabase export, a fresh database, and a deployment for check. */
  async function setUp() {
    const db = await freshDatabase();
    dbs.push(db);
    const fx = fixtureRoot();
    roots.push(fx);
    mkdirSync(join(fx.root, "supabase"));
    copyFileSync(join(FIXTURES, "supabase-users.csv"), join(fx.root, "supabase/users.csv"));
    copyFileSync(join(FIXTURES, "supabase-identities.csv"), join(fx.root, "supabase/ids.csv"));
    if (!close) {
      const server = createHttpServer((req, res) => {
        req.resume();
        req.on("end", () => res.writeHead(404).end("{}"));
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      close = () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        });
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }
    return { db, fx };
  }

  it("puts no environment value in a result, a stderr line, or a file", async () => {
    // The user and password of the brief's URL (tempo:tempo), on a fresh
    // database: migrate.run and schema.migrate write into it.
    const { db, fx } = await setUp();
    expect(db.url.startsWith("postgres://tempo:tempo@")).toBe(true);
    const b = startBinary(["--root", fx.root], { DATABASE_URL: db.url, AUTHTEMPO_PROBE: PROBE });
    await open(b);
    const results: Record<string, unknown>[] = [];
    const run = async (name: string, args: Record<string, unknown>) => {
      const r = await call(b, name, args);
      results.push(r);
      return r;
    };
    await run("scaffold", { dir: "app", stack: "workers-d1" });
    const schemaPlan = await run("schema.migrate", { dry_run: true });
    await run("schema.migrate", { plan_id: schemaPlan.plan_id, confirm: true });
    await run("migrate.plan", { ...USERS, against: "empty" });
    const plan = await run("migrate.plan", { ...USERS, against: "database" });
    const done = await run("migrate.run", { ...USERS, plan_id: plan.plan_id, confirm: true });
    await run("check", { base_url: origin });
    const { stdout, stderr } = await b.close();

    // Each call ran: a plan id for each plan, and the import wrote its users.
    expect(typeof schemaPlan.plan_id, stdout).toBe("string");
    expect(typeof plan.plan_id, stdout).toBe("string");
    // The Supabase fixture holds two hashes that the import refuses, so the run exits 1.
    expect(done.exit, stdout).toBe(1);
    const report = done.report as { dryRun?: unknown; created?: { user?: unknown } };
    expect(report.dryRun).toBe(false);
    expect(report.created?.user).toBeGreaterThan(0);
    expect(results).toHaveLength(7);
    expect(stderr.length).toBeGreaterThan(0);

    // The password equals the user name and is part of "authtempo", so it
    // counts as a whole word. The node templates hold the repo's dev URL,
    // so the scaffold writes workers-d1.
    const forbidden = [PROBE, db.url, "tempo:tempo", /(?<![A-Za-z0-9_])tempo(?![A-Za-z0-9_])/];
    const texts: [string, string][] = [
      ["stdout", stdout],
      ...stderr.split("\n").map((l): [string, string] => ["stderr", l]),
      ...filesUnder(fx.base),
    ];
    expect(texts.filter(([where]) => where.startsWith(fx.base)).length).toBeGreaterThan(0);
    for (const [where, text] of texts)
      for (const f of forbidden)
        if (typeof f === "string") expect(text, where).not.toContain(f);
        else expect(text, where).not.toMatch(f);
  });

  it("puts no password with a quote or a backslash in an answer or a stderr line", async () => {
    // The scrub of the CLI also covers the JSON form of a secret (Task 7 review m-2).
    // A wrong password stops each database tool with a stop document.
    const { db, fx } = await setUp();
    const name = new URL(db.url).pathname.slice(1);
    const password = 'q"w\\e-7';
    const url = `postgres://tempo:${encodeURIComponent(password)}@${new URL(ADMIN_URL).host}/${name}`;
    const b = startBinary(["--root", fx.root], { DATABASE_URL: url });
    await open(b);
    const stops = [
      await call(b, "schema.migrate", { dry_run: true }),
      await call(b, "migrate.plan", { ...USERS, against: "database" }),
    ];
    const { stdout, stderr } = await b.close();
    for (const s of stops) expect(s.exit, stdout).toBe(2);
    const forms = [
      url,
      encodeURIComponent(password),
      password,
      JSON.stringify(password).slice(1, -1),
    ];
    for (const f of forms) {
      expect(stdout).not.toContain(f);
      expect(stderr).not.toContain(f);
    }
  });
});
