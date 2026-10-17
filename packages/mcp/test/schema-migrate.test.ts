import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATE_JSON_KEYS } from "@authtempo/cli";
import { main } from "@authtempo/cli/program";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../cli/test/support/pg.js";
import { type CliMain, localTools } from "../src/local-tools.js";
import { PlanStore } from "../src/plans.js";
import { createServer } from "../src/server.js";
import { TOOLS } from "../src/tools.js";
import { assertFreshBuild, REPO } from "./support/bin.js";
import { type Called, connect } from "./support/client.js";
import { type FixtureRoot, fixtureRoot } from "./support/fixture-root.js";
import { assertFreshIndex, siteIndex } from "./support/index.js";

// schema.migrate (plan 11e Task 9): authtempo migrate --target postgres
// through the CLI's main in process. A dry run gives a plan_id; the real run
// takes it, runs the dry run again, and refuses when the database changed.

const CLI_BIN = join(REPO, "packages/cli/dist/bin/authtempo.js");
/** The 11c fixture of a future schema version (0008_future.sql then; renumbered by later plans). */
const FUTURE_SQL = join(REPO, "packages/cli/test/fixtures/postgres/0011_future.sql");
/**
 * The highest schema version of the Postgres adapter's migration files
 * (ruling 25). CORE_MIGRATIONS of the CLI comes from this folder. The test
 * does not read SCHEMA_VERSION.
 */
const FILE_VERSION = Math.max(
  ...readdirSync(join(REPO, "packages/adapter-postgres/src/migrations")).map((f) =>
    Number(/^\d{4}_schema_v(\d+)\.ts$/.exec(f)?.[1] ?? 0),
  ),
);

/** The keys of an answer, written out: the CLI's migrate keys and the two tool keys. */
const ANSWER_KEYS = [
  "after",
  "applied",
  "before",
  "copied",
  "dryRun",
  "exit",
  "next",
  "pending",
  "plan_id",
  "stopped",
  "tables",
  "target",
];
/** The fixed texts, written out here: the test does not read the constants it pins. */
const NO_PLAN = "no held plan has this id; run schema.migrate with dry_run: true again";
const OTHER_DATABASE = "the database differs from the plan";
const CHANGED = "the database changed since the plan";
const MODES = "schema.migrate takes dry_run: true alone, or plan_id with confirm: true";
const NEXT = "authtempo migrate --target postgres --tables core --url-env DATABASE_URL";

type Session = Awaited<ReturnType<typeof connect>>;
type Db = Awaited<ReturnType<typeof freshDatabase>>;
const roots: FixtureRoot[] = [];
const sessions: Session[] = [];
const dbs: Db[] = [];

beforeAll(() => {
  assertFreshBuild();
  assertFreshIndex();
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const f of roots.splice(0)) f.remove();
});
// Each test database is dropped here, also when a test fails.
afterAll(async () => {
  for (const db of dbs) await db.drop();
});

/** A new, empty database. */
async function emptyDatabase(): Promise<Db> {
  const db = await freshDatabase();
  dbs.push(db);
  return db;
}

/** A server on a new fixture root, with DATABASE_URL in its environment. */
async function start(db: Db, opts: { plans?: PlanStore; main?: CliMain } = {}): Promise<Session> {
  const f = fixtureRoot();
  roots.push(f);
  const session = await connect(
    createServer({
      surface: "local",
      index: siteIndex(),
      skills: [],
      root: f.root,
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: db.url },
      local: (facts) => localTools(facts, opts),
    }),
  );
  sessions.push(session);
  return session;
}

/** authtempo migrate in a shell, on the database, with its own flags. */
function shell(db: Db, extra: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(
    process.execPath,
    [CLI_BIN, "migrate", "--target", "postgres", "--url-env", "TEST_DB_URL", ...extra],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "", TEST_DB_URL: db.url } },
  );
}

/** The pending list of a dry run in a shell, and the version that the last name gives. */
function shellPlan(db: Db): { pending: string[]; version: number } {
  const r = shell(db, ["--dry-run", "--json"]);
  if (r.status !== 0)
    throw new Error(`authtempo migrate --dry-run exited ${r.status}: ${r.stderr}`);
  const pending = (JSON.parse(r.stdout) as { pending: string[] }).pending;
  const last = pending.at(-1) ?? "";
  // A core name is NNNN_schema_vN: the number of the last name is the version after the run.
  const version = Number(/^(\d+)_/.exec(last)?.[1] ?? Number.NaN);
  return { pending, version };
}

async function metaVersion(db: Db): Promise<string | null> {
  const t = await db.sql<{ t: string | null }[]>`SELECT to_regclass('ta_meta')::text AS t`;
  if (t[0]?.t == null) return null;
  const rows = await db.sql<
    { value: string }[]
  >`SELECT value FROM ta_meta WHERE key = 'schema_version'`;
  return rows[0]?.value ?? null;
}

const text = (r: Called) => r.texts.join("\n");
const doc = (r: Called) => r.structured ?? {};

/**
 * Writes the fixture of plan 11c, renumbered to one version past the last
 * migration file, and answers that version.
 */
async function applyFuture(db: Db): Promise<number> {
  const future = FILE_VERSION + 1;
  const sql = readFileSync(FUTURE_SQL, "utf8")
    .replace(/value = '\d+'/, `value = '${future}'`)
    .replace(/'\d+_future'/, `'${String(future).padStart(4, "0")}_future'`);
  await db.sql.unsafe(sql);
  expect(await metaVersion(db)).toBe(String(future));
  return future;
}

/** A dry run that must give a plan_id. */
async function plan(s: Session): Promise<string> {
  const r = await s.call("schema.migrate", { dry_run: true });
  expect(r.isError, text(r)).toBe(false);
  const id = doc(r).plan_id;
  if (typeof id !== "string") throw new Error(`no plan_id: ${text(r)}`);
  return id;
}

describe("schema.migrate", () => {
  it("plans and applies the migrations on an empty database", async () => {
    const row = TOOLS.find((t) => t.name === "schema.migrate");
    expect([...(row?.outputKeys ?? [])].sort()).toEqual(ANSWER_KEYS);
    expect([...(row?.outputKeys ?? [])].sort()).toEqual(
      [...Object.keys(MIGRATE_JSON_KEYS), "plan_id", "next"].sort(),
    );
    const db = await emptyDatabase();
    const expected = shellPlan(db);
    expect(expected.pending.length).toBeGreaterThan(0);
    const s = await start(db);

    const dry = await s.call("schema.migrate", { dry_run: true });
    expect(dry.isError, text(dry)).toBe(false);
    expect(Object.keys(doc(dry)).sort()).toEqual(ANSWER_KEYS);
    expect(doc(dry)).toMatchObject({
      target: "postgres",
      tables: "core",
      dryRun: true,
      before: null,
      pending: expected.pending,
      applied: [],
      exit: 0,
      stopped: null,
      next: NEXT,
    });
    expect(doc(dry).plan_id).toMatch(/^mp_[A-Za-z0-9_-]{22}$/);
    // The answer names the variable, never its value.
    expect(JSON.stringify(doc(dry))).not.toContain(db.url);
    expect(await metaVersion(db)).toBeNull();

    const id = String(doc(dry).plan_id);
    const run = await s.call("schema.migrate", { plan_id: id, confirm: true });
    expect(run.isError, text(run)).toBe(false);
    expect(Object.keys(doc(run)).sort()).toEqual(ANSWER_KEYS);
    expect(doc(run)).toMatchObject({
      dryRun: false,
      before: null,
      after: expected.version,
      pending: expected.pending,
      applied: expected.pending,
      exit: 0,
      stopped: null,
      plan_id: null,
    });
    expect(await metaVersion(db)).toBe(String(expected.version));

    const again = await s.call("schema.migrate", { plan_id: id, confirm: true });
    expect(again.isError).toBe(true);
    expect(text(again)).toBe(NO_PLAN);
  });

  it("stops at the gate on a newer database", async () => {
    const db = await emptyDatabase();
    const known = FILE_VERSION;
    expect(shell(db, []).status).toBe(0);
    // The fixture of plan 11c, renumbered to one version past the last migration file.
    const future = await applyFuture(db);
    const s = await start(db);
    const r = await s.call("schema.migrate", { dry_run: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("this CLI knows version");
    expect(text(r)).toBe(
      `stopped: the database is at version ${future}; this CLI knows version ${known}; use a newer CLI`,
    );
    expect(doc(r).plan_id).toBeNull();
    expect(doc(r).exit).toBe(2);
  });

  it("refuses a plan when the database changed", async () => {
    const db = await emptyDatabase();
    const expected = shellPlan(db);
    const s = await start(db);
    const id = await plan(s);
    // A migration run in the shell between the plan and the run.
    expect(shell(db, []).status).toBe(0);
    const r = await s.call("schema.migrate", { plan_id: id, confirm: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(CHANGED);
    expect(doc(r).plan_id).toBeUndefined();
    expect(await metaVersion(db)).toBe(String(expected.version));
    // The refusal used the plan.
    const used = await s.call("schema.migrate", { plan_id: id, confirm: true });
    expect(text(used)).toBe(NO_PLAN);
  });

  it("refuses a mix of the modes", async () => {
    const db = await emptyDatabase();
    const store = new PlanStore();
    const s = await start(db, { plans: store });
    const id = await plan(s);
    const mixes: Record<string, unknown>[] = [
      {},
      { tables: "core" },
      { dry_run: false },
      { dry_run: true, confirm: true },
      { dry_run: true, plan_id: id },
      { dry_run: true, plan_id: id, confirm: true },
      { dry_run: false, plan_id: id, confirm: true },
      { plan_id: id },
      { plan_id: id, confirm: false },
      { confirm: true },
    ];
    for (const input of mixes) {
      const r = await s.call("schema.migrate", input);
      expect(r.isError, JSON.stringify(input)).toBe(true);
      expect(text(r), JSON.stringify(input)).toBe(MODES);
    }
    // A key that the row does not name, such as a connection string, is an input error.
    const url = await s.call("schema.migrate", { dry_run: true, url: db.url });
    expect(url.isError).toBe(true);
    expect(await metaVersion(db)).toBeNull();
    // A plan of migrate.plan is an unknown id here.
    const other = store.hold("import", { tables: "core" }, {}, null, "db");
    expect(store.take("schema", other, { tables: "core" }, {}, "db")).toEqual({ refused: NO_PLAN });
    // No mix used the plan: it runs now.
    const run = await s.call("schema.migrate", { plan_id: id, confirm: true });
    expect(run.isError, text(run)).toBe(false);
    expect(doc(run).exit).toBe(0);
  });

  it("refuses a plan of one database on another", async () => {
    const a = await emptyDatabase();
    const b = await emptyDatabase();
    // Two servers share one store; each one has its own DATABASE_URL.
    const store = new PlanStore();
    const onA = await start(a, { plans: store });
    const onB = await start(b, { plans: store });
    const id = await plan(onA);
    const r = await onB.call("schema.migrate", { plan_id: id, confirm: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(OTHER_DATABASE);
    expect(await metaVersion(a)).toBeNull();
    expect(await metaVersion(b)).toBeNull();
  });

  it("stops at the gate in a run when the database became newer after the plan", async () => {
    const db = await emptyDatabase();
    const known = FILE_VERSION;
    expect(shell(db, []).status).toBe(0);
    const s = await start(db);
    const id = await plan(s);
    const future = await applyFuture(db);
    const r = await s.call("schema.migrate", { plan_id: id, confirm: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(
      `stopped: the database is at version ${future}; this CLI knows version ${known}; use a newer CLI`,
    );
    expect(doc(r).plan_id).toBeNull();
    expect(await metaVersion(db)).toBe(String(future));
  });

  it("reads the database again after a run that stops", async () => {
    const db = await emptyDatabase();
    const expected = shellPlan(db);
    // The real run applies each migration, then its first stdout write fails,
    // as a lost link would fail after the commit. main prints a stop document
    // with applied [], and the tool must not trust it.
    const faulty: CliMain = (argv, io) => {
      if (argv.includes("--dry-run")) return main(argv, io);
      let first = true;
      return main(argv, {
        ...io,
        out(line) {
          if (first) {
            first = false;
            throw new Error("the link to the agent dropped");
          }
          io.out(line);
        },
      });
    };
    const s = await start(db, { main: faulty });
    const id = await plan(s);
    const r = await s.call("schema.migrate", { plan_id: id, confirm: true });
    expect(r.isError).toBe(true);
    expect(text(r).split("\n")).toEqual([
      "stopped: the link to the agent dropped",
      `after the stop, the database is at version ${expected.version} with 0 pending migration(s)`,
    ]);
    expect(doc(r)).toMatchObject({
      target: "postgres",
      tables: "core",
      dryRun: false,
      before: null,
      after: expected.version,
      pending: expected.pending,
      applied: expected.pending,
      exit: 2,
      stopped: "the link to the agent dropped",
      plan_id: null,
    });
    expect(await metaVersion(db)).toBe(String(expected.version));
  });
});
