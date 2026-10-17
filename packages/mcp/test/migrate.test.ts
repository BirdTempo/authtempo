import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { IMPORT_JSON_KEYS } from "@authtempo/cli";
import { PROVIDERS } from "@authtempo/cli/program";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../cli/test/support/pg.js";
import * as READERS from "../../import/test/fixtures/readers.js";
import { SUPABASE_FIXTURE_CREATED } from "../../import/test/fixtures/supabase-counts.js";
import { localTools, pinnedIo } from "../src/local-tools.js";
import { PlanStore } from "../src/plans.js";
import { createServer } from "../src/server.js";
import { IMPORT_PROVIDERS, TOOLS } from "../src/tools.js";
import { assertFreshBuild, REPO, runServer } from "./support/bin.js";
import { type Called, connect } from "./support/client.js";
import { type FixtureRoot, fixtureRoot } from "./support/fixture-root.js";
import { assertFreshIndex, siteIndex } from "./support/index.js";

// migrate.plan and migrate.run (plan 11e Task 8) run authtempo import
// through the CLI's main in process. A plan handle binds a real run to the
// input, the bytes of each file, and the database of its plan.

const CLI_BIN = join(REPO, "packages/cli/dist/bin/authtempo.js");
const FIXTURES = join(REPO, "packages/import/test/fixtures");

/** The keys of a plan answer, written out: the CLI's import keys and the three tool keys. */
const PLAN_KEYS = ["against", "bundle", "exit", "next", "plan_id", "report", "stopped"];
/** The fixed refusal texts, written out here: the test does not read the constants it pins. */
const NO_PLAN = "no held plan has this id; run migrate.plan again";
const OTHER_INPUT = "the input differs from the plan";
const OTHER_DATABASE = "the database differs from the plan";

/** One export of each provider: the files and the other input that its plan needs. */
interface ProviderExport {
  files: Record<string, { name: string; text: string }>;
  input: Record<string, unknown>;
}

const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

/**
 * The export of each provider: the Supabase CSV pair, and for the others
 * the main export of each reader test (packages/import/test/fixtures/readers.ts).
 */
const EXPORTS: Record<string, ProviderExport> = {
  supabase: {
    files: {
      users: { name: "users.csv", text: fixture("supabase-users.csv") },
      identities: { name: "identities.csv", text: fixture("supabase-identities.csv") },
    },
    input: { formats: "bcrypt" },
  },
  clerk: {
    files: {
      csv: { name: "users.csv", text: READERS.CLERK_CSV },
      users: { name: "users.json", text: READERS.CLERK_USERS },
      organizations: { name: "organizations.json", text: READERS.CLERK_ORGS },
    },
    input: { formats: "bcrypt" },
  },
  auth0: {
    files: {
      users: { name: "users.ndjson", text: READERS.AUTH0_USERS },
      hashes: { name: "hashes.ndjson", text: READERS.AUTH0_HASHES },
      organizations: { name: "organizations.json", text: READERS.AUTH0_ORGS },
    },
    input: { formats: "bcrypt" },
  },
  firebase: {
    files: { users: { name: "users.json", text: READERS.FIREBASE_USERS } },
    input: { formats: "firescrypt", firebase_rounds: 8, firebase_mem_cost: 14 },
  },
  authjs: {
    files: { authjs_tables: { name: "tables.json", text: READERS.AUTHJS_TABLES } },
    input: { formats: "bcrypt", password_column: "passwordHash" },
  },
  cognito: {
    files: { users: { name: "users.json", text: READERS.COGNITO_USERS } },
    input: {},
  },
};

/**
 * Each long run of hash or key characters in the export texts: a hash, a
 * salt, or a public key. A report holds none of them.
 */
const secretsOf = (text: string): string[] =>
  [...text.matchAll(/[A-Za-z0-9+/=$.]{20,}/g)].map((m) => m[0]);

type Session = Awaited<ReturnType<typeof connect>>;
type Db = Awaited<ReturnType<typeof freshDatabase>>;
let fx: FixtureRoot | undefined;
let session: Session | undefined;
const dbs: Db[] = [];

beforeAll(() => {
  assertFreshBuild();
  assertFreshIndex();
});
afterEach(async () => {
  await session?.close();
  session = undefined;
  fx?.remove();
  fx = undefined;
});
// Each test database is dropped here, also when a test fails.
afterAll(async () => {
  for (const db of dbs) await db.drop();
});

/** A server on a new fixture root. `env` is the server's environment; a test may change it. */
async function start(
  env: Record<string, string | undefined>,
  plans?: PlanStore,
  urlEnv?: string,
): Promise<{ s: Session; root: string }> {
  const f = fixtureRoot();
  fx = f;
  session = await connect(
    createServer({
      surface: "local",
      index: siteIndex(),
      skills: [],
      root: f.root,
      env,
      ...(urlEnv === undefined ? {} : { urlEnv }),
      local: (facts) => localTools(facts, plans === undefined ? {} : { plans }),
    }),
  );
  return { s: session, root: f.root };
}

/** Writes the export of a provider under root/<provider>/ and answers the tool input. */
function write(root: string, provider: string): Record<string, unknown> {
  const e = EXPORTS[provider];
  if (!e) throw new Error(`no export for ${provider}`);
  const input: Record<string, unknown> = { provider, ...e.input };
  for (const [key, file] of Object.entries(e.files)) {
    const path = join(provider, file.name);
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), file.text);
    input[key] = path;
  }
  return input;
}

/** A fresh database with the core schema, by a run of authtempo migrate. */
async function migratedDatabase(): Promise<Db> {
  const db = await freshDatabase();
  dbs.push(db);
  const r = spawnSync(
    process.execPath,
    [CLI_BIN, "migrate", "--target", "postgres", "--url-env", "TEST_DB_URL"],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "", TEST_DB_URL: db.url } },
  );
  if (r.status !== 0) throw new Error(`authtempo migrate exited ${r.status}: ${r.stderr}`);
  return db;
}

async function users(db: Db): Promise<number> {
  const rows = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ta_user`;
  return rows[0]?.n ?? -1;
}

const text = (r: Called) => r.texts.join("\n");
const doc = (r: Called) => r.structured ?? {};
const report = (r: Called) => (doc(r).report ?? {}) as Record<string, unknown>;

/** A plan against the database that must give a handle. */
async function plan(s: Session, input: Record<string, unknown>): Promise<string> {
  const r = await s.call("migrate.plan", { ...input, against: "database" });
  expect(r.isError, text(r)).toBe(false);
  const id = doc(r).plan_id;
  if (typeof id !== "string") throw new Error(`no plan_id: ${text(r)}`);
  return id;
}

describe("migrate.plan against an empty store", () => {
  it("plans each provider against an empty store", async () => {
    // The copies of the Worker-safe table equal the CLI's sources.
    expect([...IMPORT_PROVIDERS]).toEqual([...PROVIDERS]);
    expect(Object.keys(EXPORTS).sort()).toEqual([...PROVIDERS].sort());
    const planRow = TOOLS.find((t) => t.name === "migrate.plan");
    expect([...(planRow?.outputKeys ?? [])].sort()).toEqual(PLAN_KEYS);
    expect([...(planRow?.outputKeys ?? [])].sort()).toEqual(
      [...Object.keys(IMPORT_JSON_KEYS), "against", "plan_id", "next"].sort(),
    );
    const { s, root } = await start({ PATH: process.env.PATH ?? "" });
    for (const provider of PROVIDERS) {
      const r = await s.call("migrate.plan", write(root, provider));
      expect(r.isError, `${provider}: ${text(r)}`).toBe(false);
      expect(Object.keys(doc(r)).sort(), provider).toEqual(PLAN_KEYS);
      expect(report(r).dryRun, provider).toBe(true);
      expect(report(r).source, provider).toBe(provider);
      expect(doc(r).against, provider).toBe("empty");
      expect(doc(r).plan_id, provider).toBeNull();
      expect(doc(r).stopped, provider).toBeNull();
      expect(String(doc(r).next), provider).toMatch(
        new RegExp(`^authtempo import ${provider} .* --target postgres --url-env DATABASE_URL$`),
      );
    }
  });

  it("plans a Cognito import with legacy_verify, and refuses the marker without it", async () => {
    const { s, root } = await start({ PATH: process.env.PATH ?? "" });
    const input = write(root, "cognito");
    const with_ = await s.call("migrate.plan", { ...input, legacy_verify: true });
    expect(with_.isError, text(with_)).toBe(false);
    expect(doc(with_).exit).toBe(0);
    expect(report(with_).refusedHashes).toEqual([]);
    expect(String(doc(with_).next)).toContain(" --legacy-verify ");
    const without = await s.call("migrate.plan", input);
    expect(without.isError, text(without)).toBe(false);
    expect(doc(without).exit).toBe(1);
    expect(report(without).refusedHashes).toEqual([{ sourceId: "sub-1", format: "legacy-verify" }]);
  });

  it("holds no address and no hash in the plan", async () => {
    const { s, root } = await start({ PATH: process.env.PATH ?? "" });
    for (const provider of PROVIDERS) {
      const r = await s.call("migrate.plan", write(root, provider));
      expect(r.isError, `${provider}: ${text(r)}`).toBe(false);
      const json = JSON.stringify(report(r));
      expect(json, provider).not.toContain("@");
      const files = Object.values(EXPORTS[provider]?.files ?? {});
      const secrets = files.flatMap((f) => secretsOf(f.text));
      // The fixture has hash texts, so the check below can fail.
      expect(files.map((f) => f.text).join("")).toContain("@");
      for (const secret of secrets) expect(json, `${provider}: ${secret}`).not.toContain(secret);
    }
    expect(secretsOf(fixture("supabase-users.csv")).length).toBeGreaterThan(0);
  });
});

describe("migrate.plan and migrate.run against the database", () => {
  it("plans against the database and gives a handle", async () => {
    const db = await migratedDatabase();
    const { s, root } = await start({ PATH: process.env.PATH ?? "", DATABASE_URL: db.url });
    const r = await s.call("migrate.plan", { ...write(root, "supabase"), against: "database" });
    expect(r.isError, text(r)).toBe(false);
    expect(Object.keys(doc(r)).sort()).toEqual(PLAN_KEYS);
    expect(doc(r).against).toBe("database");
    expect(doc(r).plan_id).toMatch(/^mp_[A-Za-z0-9_-]{22}$/);
    expect(report(r).dryRun).toBe(true);
    expect(report(r).created).toMatchObject({ user: SUPABASE_FIXTURE_CREATED.user });
    // The handle and the next command name the variable, never its value.
    expect(JSON.stringify(doc(r))).not.toContain(db.url);
    expect(await users(db)).toBe(0);
  });

  it("runs a held plan once", async () => {
    const db = await migratedDatabase();
    const { s, root } = await start({ PATH: process.env.PATH ?? "", DATABASE_URL: db.url });
    const input = write(root, "supabase");
    const id = await plan(s, input);
    expect(await users(db)).toBe(0);
    const r = await s.call("migrate.run", { ...input, plan_id: id, confirm: true });
    expect(r.isError, text(r)).toBe(false);
    expect(Object.keys(doc(r)).sort()).toEqual(["bundle", "exit", "report", "stopped"]);
    expect(report(r).dryRun).toBe(false);
    const created = (report(r).created ?? {}) as Record<string, unknown>;
    expect(created.user).toBe(SUPABASE_FIXTURE_CREATED.user);
    expect(await users(db)).toBe(created.user);
    const again = await s.call("migrate.run", { ...input, plan_id: id, confirm: true });
    expect(again.isError).toBe(true);
    expect(text(again)).toBe(NO_PLAN);
    expect(await users(db)).toBe(created.user);
  });

  it("refuses a plan whose file changed", async () => {
    const db = await migratedDatabase();
    const { s, root } = await start({ PATH: process.env.PATH ?? "", DATABASE_URL: db.url });
    const input = write(root, "supabase");
    const id = await plan(s, input);
    appendFileSync(join(root, String(input.users)), "\n");
    const r = await s.call("migrate.run", { ...input, plan_id: id, confirm: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("the file users changed since the plan");
    expect(await users(db)).toBe(0);
    // A new plan of the changed file gives a new handle, and that handle runs.
    const next = await plan(s, input);
    expect(next).not.toBe(id);
    const ran = await s.call("migrate.run", { ...input, plan_id: next, confirm: true });
    expect(ran.isError, text(ran)).toBe(false);
    expect(await users(db)).toBe(SUPABASE_FIXTURE_CREATED.user);
  });

  it("refuses a plan whose identities file changed", async () => {
    // Each file input is in the plan's digests, not only users.
    const db = await migratedDatabase();
    const { s, root } = await start({ PATH: process.env.PATH ?? "", DATABASE_URL: db.url });
    const input = write(root, "supabase");
    const id = await plan(s, input);
    appendFileSync(join(root, String(input.identities)), "\n");
    const r = await s.call("migrate.run", { ...input, plan_id: id, confirm: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("the file identities changed since the plan");
    expect(await users(db)).toBe(0);
  });

  it("plans and runs against the database that the server's --url-env names", async () => {
    const named = await migratedDatabase();
    // DATABASE_URL names a database with no schema: a plan or a run there stops.
    const fallback = await freshDatabase();
    dbs.push(fallback);
    const { s, root } = await start(
      { PATH: process.env.PATH ?? "", APP_DB: named.url, DATABASE_URL: fallback.url },
      undefined,
      "APP_DB",
    );
    const input = write(root, "supabase");
    const p = await s.call("migrate.plan", { ...input, against: "database" });
    expect(p.isError, text(p)).toBe(false);
    expect(String(doc(p).next)).toMatch(/ --url-env APP_DB$/);
    const id = doc(p).plan_id;
    expect(typeof id).toBe("string");
    const r = await s.call("migrate.run", { ...input, plan_id: id, confirm: true });
    expect(r.isError, text(r)).toBe(false);
    expect(await users(named)).toBe(SUPABASE_FIXTURE_CREATED.user);
    const table = await fallback.sql<
      { t: string | null }[]
    >`SELECT to_regclass('ta_user')::text AS t`;
    expect(table[0]?.t).toBeNull();
  });

  it("uses up the plan when a file cannot be read at the run", async () => {
    const db = await migratedDatabase();
    const { s, root } = await start({ PATH: process.env.PATH ?? "", DATABASE_URL: db.url });
    const input = write(root, "supabase");
    const id = await plan(s, input);
    const path = join(root, String(input.identities));
    renameSync(path, `${path}.away`);
    const r = await s.call("migrate.run", { ...input, plan_id: id, confirm: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("the file identities cannot be read: ENOENT");
    renameSync(`${path}.away`, path);
    const again = await s.call("migrate.run", { ...input, plan_id: id, confirm: true });
    expect(again.isError).toBe(true);
    expect(text(again)).toBe(NO_PLAN);
    expect(await users(db)).toBe(0);
  });

  it("refuses another input, an expired plan, another database, and confirm false", async () => {
    const db = await migratedDatabase();
    const other = await migratedDatabase();
    let now = 1_000;
    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH ?? "",
      DATABASE_URL: db.url,
    };
    const { s, root } = await start(env, new PlanStore(() => now));
    const input = write(root, "supabase");

    const first = await plan(s, input);
    const changed = await s.call("migrate.run", {
      ...input,
      on_email_taken: "fail",
      plan_id: first,
      confirm: true,
    });
    expect(changed.isError).toBe(true);
    expect(text(changed)).toBe(OTHER_INPUT);
    // The refusal used the plan: the right input does not run it now.
    const used = await s.call("migrate.run", { ...input, plan_id: first, confirm: true });
    expect(text(used)).toBe(NO_PLAN);

    // Ten minutes and one millisecond after the plan.
    const old = await plan(s, input);
    now += 600_001;
    const expired = await s.call("migrate.run", { ...input, plan_id: old, confirm: true });
    expect(expired.isError).toBe(true);
    expect(text(expired)).toBe(NO_PLAN);

    // The server's variable now names another database.
    const moved = await plan(s, input);
    env.DATABASE_URL = other.url;
    const elsewhere = await s.call("migrate.run", { ...input, plan_id: moved, confirm: true });
    expect(elsewhere.isError).toBe(true);
    expect(text(elsewhere)).toBe(OTHER_DATABASE);
    env.DATABASE_URL = db.url;

    const unsure = await plan(s, input);
    const no = await s.call("migrate.run", { ...input, plan_id: unsure, confirm: false });
    expect(no.isError).toBe(true);
    expect(text(no)).toContain("confirm");

    expect(await users(db)).toBe(0);
    expect(await users(other)).toBe(0);
  });
});

describe("the plan store and the input rules", () => {
  it("keeps at most 16 plans", () => {
    const store = new PlanStore(() => 0);
    const ids = Array.from({ length: 17 }, (_, n) =>
      store.hold("import", { n }, { users: `digest-${n}` }, null, "db"),
    );
    expect(store.size).toBe(16);
    const [first, ...rest] = ids;
    expect(store.take("import", String(first), { n: 0 }, { users: "digest-0" }, "db")).toEqual({
      refused: NO_PLAN,
    });
    rest.forEach((id, i) => {
      const held = store.take("import", id, { n: i + 1 }, { users: `digest-${i + 1}` }, "db");
      expect("refused" in held, id).toBe(false);
    });
    expect(store.size).toBe(0);
  });

  it("counts a plan of another kind as unknown", () => {
    const store = new PlanStore(() => 0);
    const id = store.hold("import", { n: 1 }, {}, null, "db");
    // The text names the call that makes a plan of the caller's kind (Task 9 review m-1).
    expect(store.take("schema", id, { n: 1 }, {}, "db")).toEqual({
      refused: "no held plan has this id; run schema.migrate with dry_run: true again",
    });
    expect(store.size).toBe(0);
  });

  it("gives the CLI the bytes that the plan hashed, not the file as it is now", () => {
    const f = fixtureRoot();
    fx = f;
    const file = join(f.root, "users.csv");
    writeFileSync(file, "id,email\nnew-bytes\n");
    const { io } = pinnedIo(f.root, {}, new Map([[file, "id,email\nplanned-bytes\n"]]));
    expect(io.readFile(file)).toBe("id,email\nplanned-bytes\n");
    expect(io.readFile("users.csv")).toBe("id,email\nplanned-bytes\n");
    // A file that the map does not name is read from the disk, inside the root.
    writeFileSync(join(f.root, "other.csv"), "x\n");
    expect(io.readFile("other.csv")).toBe("x\n");
  });

  it("takes no connection string as an input", async () => {
    const { s, root } = await start({ PATH: process.env.PATH ?? "" });
    const input = write(root, "supabase");
    const r = await s.call("migrate.plan", { ...input, url: "postgres://tempo:x@localhost/db" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("url");
    const listed = await s.client.listTools();
    for (const name of ["migrate.plan", "migrate.run"]) {
      const tool = listed.tools.find((t) => t.name === name);
      const keys = Object.keys((tool?.inputSchema.properties ?? {}) as object);
      expect(keys.length, name).toBeGreaterThan(0);
      for (const key of keys) expect(key, name).not.toMatch(/url|dsn|connection|database/i);
      expect(tool?.inputSchema.additionalProperties, name).toBe(false);
    }
  });

  it("scrubs the connection string", async () => {
    const f = fixtureRoot();
    fx = f;
    const input = write(f.root, "supabase");
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "migrate.plan", arguments: { ...input, against: "database" } },
    });
    const run = await runServer(
      ["--root", f.root],
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "migrate-test", version: "0.0.0" },
          },
        }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        call,
      ],
      { env: { DATABASE_URL: "postgres://tempo:wrong-pass-5@localhost:5439/none" } },
    );
    const answer = run.stdout
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { id?: unknown; result?: Record<string, unknown> })
      .find((m) => m.id === 2);
    const result = answer?.result ?? {};
    expect(result.isError, run.stdout).toBe(true);
    const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
    expect(String(structured.stopped)).toMatch(
      /^storage: \S+ at localhost:5439\/none; nothing was written$/,
    );
    expect(structured.plan_id).toBeNull();
    expect(run.stdout).not.toContain("wrong-pass-5");
    expect(run.stderr).not.toContain("wrong-pass-5");
    expect(run.stderr.length).toBeGreaterThan(0);
  });
});
