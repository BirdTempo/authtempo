import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATE_JSON_KEYS } from "../src/json.js";
import { assertFreshBuild, linesOf, PKG, runBin } from "./support/bin.js";
import { D1_MODULES, d1Project, removeScaffolds } from "./support/d1-project.js";

const ADAPTER = join(D1_MODULES, "@authtempo/adapter-d1/migrations");
const ADAPTER_FILES = readdirSync(ADAPTER)
  .filter((f) => f.endsWith(".sql"))
  .sort();
/** Every entry of the adapter's folder before any test: a compat run must leave it as it is. */
const ADAPTER_ENTRIES = readdirSync(ADAPTER).sort();
const CORE = ADAPTER_FILES.map((f) => f.slice(0, -".sql".length));
const COMPAT_DIR = join(PKG, "../compat-better-auth/migrations/d1");
const BA_SQLITE = readFileSync(
  join(PKG, "../compat-better-auth/test/fixtures/better-auth-1.7.2.sqlite.sql"),
  "utf8",
);
const migrate = (dir: string, extra: string[] = []) =>
  runBin(["migrate", "--target", "d1", ...extra], { cwd: dir });

/**
 * One SELECT on the local D1 database of a project, through the pinned
 * wrangler 4.148.0 and not through the CLI's seam (plan 11c, controller
 * amendment): the proof that the seam wrote the database that `wrangler dev`
 * reads. wrangler prints `[{ results, success, meta }]` on stdout.
 */
function readLocal(dir: string, sql: string): Record<string, unknown>[] {
  const r = wranglerLocal(dir, ["d1", "execute", "cli-d1", "--local", "--json", "--command", sql]);
  const parsed = JSON.parse(r.stdout) as { results: Record<string, unknown>[] }[];
  return parsed[0]?.results ?? [];
}

/** The pinned wrangler on the local D1 of a project, with no CLI in between. It must exit 0. */
function wranglerLocal(dir: string, args: string[]): { stdout: string } {
  const r = spawnSync(join(D1_MODULES, ".bin/wrangler"), args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
      NO_COLOR: "1",
    },
    timeout: 120_000,
  });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  return { stdout: r.stdout };
}

beforeAll(() => {
  assertFreshBuild();
});

afterAll(() => {
  removeScaffolds();
});

// Each run calls the project's wrangler four or five times on its local D1.
describe("authtempo migrate --target d1 (spec 19)", { timeout: 300_000 }, () => {
  it("lists, then applies, the eight adapter files on a fresh local database, then applies none", () => {
    const p = d1Project({ name: "d1-local" });
    const dry = migrate(p.dir, ["--dry-run"]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(linesOf(dry.stdout)).toEqual([
      ...CORE.map((n) => `would apply ${n}`),
      "version before: none; version after: none",
    ]);
    const r = migrate(p.dir);
    expect(r.status, r.stderr).toBe(0);
    expect(linesOf(r.stdout)).toEqual([
      ...CORE.map((n) => `applied ${n}`),
      "version before: none; version after: 8",
    ]);
    // The direct read: wrangler's own table and ta_meta in the local database.
    expect(
      readLocal(p.dir, "SELECT name FROM d1_migrations ORDER BY id").map((row) => row.name),
    ).toEqual(ADAPTER_FILES);
    expect(readLocal(p.dir, "SELECT value FROM ta_meta WHERE key = 'schema_version'")).toEqual([
      { value: "8" },
    ]);
    const again = migrate(p.dir);
    expect(again.status).toBe(0);
    expect(linesOf(again.stdout)).toEqual(["version before: 8; version after: 8"]);
  });

  it("stops with exit 2 and names both folders when migrations_dir is not the adapter's folder", () => {
    const first = ADAPTER_FILES[0] ?? "";
    const p = d1Project({
      migrationsDir: "migrations",
      files: { [`migrations/${first}`]: readFileSync(join(ADAPTER, first), "utf8") },
    });
    const r = migrate(p.dir);
    expect(r.status).toBe(2);
    const last = linesOf(r.stderr).at(-1) ?? "";
    expect(last).toContain(join(p.dir, "migrations"));
    expect(last).toContain("adapter-d1/migrations");
    expect(last).toContain(ADAPTER_FILES[1] ?? "");
  });

  it("copies the compat files under the next numbers, applies them, and a second run copies nothing", () => {
    const p = d1Project({
      migrationsDir: "migrations",
      files: { "migrations/0001_better_auth.sql": BA_SQLITE },
    });
    const copied = [
      "0002_compat_better_auth",
      "0003_compat_schema_v5",
      "0004_compat_schema_v6",
      "0005_compat_schema_v7",
      "0006_compat_schema_v8",
    ];
    const r = migrate(p.dir, ["--tables", "compat"]);
    expect(r.status, r.stderr).toBe(0);
    expect(linesOf(r.stdout)).toEqual([
      ...copied.map((n) => `copied ${n}`),
      "applied 0001_better_auth",
      ...copied.map((n) => `applied ${n}`),
      "version before: none; version after: 8",
    ]);
    const shipped = readdirSync(COMPAT_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(shipped).toHaveLength(copied.length);
    for (const [i, f] of shipped.entries())
      expect(readFileSync(join(p.dir, "migrations", `${copied[i]}.sql`), "utf8")).toBe(
        readFileSync(join(COMPAT_DIR, f), "utf8"),
      );
    const again = migrate(p.dir, ["--tables", "compat"]);
    expect(again.status).toBe(0);
    expect(linesOf(again.stdout)).toEqual(["version before: 8; version after: 8"]);
  });

  it("refuses --tables compat when migrations_dir is the adapter's own folder, and writes into no package", () => {
    // The default fixture: migrations_dir is node_modules/@authtempo/adapter-d1/migrations,
    // which in the workspace links to packages/adapter-d1/migrations.
    const p = d1Project();
    for (const extra of [
      ["--tables", "compat"],
      ["--tables", "compat", "--dry-run"],
    ]) {
      const r = migrate(p.dir, extra);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
      expect(linesOf(r.stderr).at(-1)).toBe(
        `stopped: migrations_dir ${join(p.dir, "node_modules/@authtempo/adapter-d1/migrations")} is the folder of @authtempo/adapter-d1; with --tables compat, point migrations_dir at a folder of the app`,
      );
      expect(readdirSync(ADAPTER).sort()).toEqual(ADAPTER_ENTRIES);
      expect(ADAPTER_FILES).toHaveLength(8);
    }
  });

  it("stops after a run that leaves the database at version 9, and before any write on the next run", () => {
    const files = Object.fromEntries(
      ADAPTER_FILES.map((f) => [`migrations/${f}`, readFileSync(join(ADAPTER, f), "utf8")]),
    );
    const future = readFileSync(join(PKG, "test/fixtures/d1/0009_future.sql"), "utf8");
    const p = d1Project({
      migrationsDir: "migrations",
      files: { ...files, "migrations/0009_future.sql": future },
    });
    const first = migrate(p.dir);
    expect(first.status).toBe(2);
    expect(linesOf(first.stderr).at(-1)).toBe(
      "stopped: the database is at version 9 after the run; this CLI expects version 8",
    );
    const second = migrate(p.dir);
    expect(second.status).toBe(2);
    expect(second.stdout).toBe("");
    expect(linesOf(second.stderr).at(-1)).toBe(
      "stopped: the database is at version 9; this CLI knows version 8; use a newer CLI",
    );
  });

  it("needs --database when the project has two D1 databases", () => {
    const p = d1Project({ second: true });
    const r = migrate(p.dir, ["--dry-run"]);
    expect(r.status).toBe(2);
    expect(linesOf(r.stderr)[0]).toBe(
      `${join(p.dir, "wrangler.jsonc")} has 2 D1 databases: name one with --database`,
    );
    const named = migrate(p.dir, ["--dry-run", "--database", "cli-d1"]);
    expect(named.status, named.stderr).toBe(0);
  });

  it("stops when the project has no wrangler, and prints one JSON document with --json", () => {
    const bare = d1Project({
      modules: false,
      migrationsDir: "migrations",
      files: { "migrations/0001_a.sql": "SELECT 1;" },
    });
    const r = migrate(bare.dir, ["--tables", "compat"]);
    expect(r.status).toBe(2);
    expect(linesOf(r.stderr).at(-1)).toBe(
      `stopped: no wrangler in ${join(bare.dir, "node_modules")}: install the packages of the project first`,
    );
    const p = d1Project();
    const j = migrate(p.dir, ["--dry-run", "--json"]);
    expect(j.status).toBe(0);
    const doc = JSON.parse(j.stdout) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(Object.keys(MIGRATE_JSON_KEYS).sort());
    expect(doc).toMatchObject({
      target: "d1",
      tables: "core",
      dryRun: true,
      before: null,
      pending: CORE,
    });
  });

  it("with --remote, gives --remote to each wrangler call (a fake wrangler records them; no test logs in)", () => {
    const files = Object.fromEntries(
      ADAPTER_FILES.map((f) => [`migrations/${f}`, readFileSync(join(ADAPTER, f), "utf8")]),
    );
    // The fake answers each SELECT as wrangler 4.148.0 answers on a new database with --json.
    const fake = [
      "#!/bin/sh",
      'printf \'CI=%s %s\\n\' "$CI" "$*" >> "$(dirname "$0")/../../wrangler-calls.log"',
      'if [ "$2" = "execute" ]; then echo \'{"error":{"text":"no such table: ta_meta: SQLITE_ERROR"}}\'; exit 1; fi',
      "exit 0",
      "",
    ].join("\n");
    const p = d1Project({
      modules: false,
      migrationsDir: "migrations",
      files: { ...files, "node_modules/.bin/wrangler": fake },
    });
    chmodSync(join(p.dir, "node_modules/.bin/wrangler"), 0o755);
    const r = migrate(p.dir, ["--remote"]);
    // The fake applies nothing, so the gate after the run stops it.
    expect(r.status).toBe(2);
    expect(linesOf(r.stderr)).toContain("running wrangler d1 migrations apply cli-d1 --remote");
    const tail = `--remote --config ${join(p.dir, "wrangler.jsonc")}`;
    // CI=1 on each call: wrangler then takes the default answer of the apply confirmation.
    // The applied list comes first: the version check needs its count.
    const applied = `CI=1 d1 execute cli-d1 --json --command SELECT name FROM d1_migrations ORDER BY id ${tail}`;
    const version = `CI=1 d1 execute cli-d1 --json --command SELECT value FROM ta_meta WHERE key = 'schema_version' ${tail}`;
    expect(linesOf(readFileSync(join(p.dir, "wrangler-calls.log"), "utf8"))).toEqual([
      applied,
      version,
      `CI=1 d1 migrations apply cli-d1 ${tail}`,
      applied,
      version,
    ]);
  });

  it("stops before any write on a schema_version that is not a number, and on a missing row over applied files", () => {
    const p = d1Project();
    const first = migrate(p.dir);
    expect(first.status, first.stderr).toBe(0);
    readLocal(p.dir, "UPDATE ta_meta SET value = '9x' WHERE key = 'schema_version'");
    for (const extra of [["--dry-run"], []]) {
      const r = migrate(p.dir, extra);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
      expect(linesOf(r.stderr).at(-1)).toBe(
        'stopped: ta_meta holds schema_version "9x", which is not a version number; nothing was written',
      );
    }
    readLocal(p.dir, "DELETE FROM ta_meta WHERE key = 'schema_version'");
    const missing = migrate(p.dir);
    expect(missing.status).toBe(2);
    expect(missing.stdout).toBe("");
    expect(linesOf(missing.stderr).at(-1)).toBe(
      `stopped: ta_meta has no schema_version, but d1_migrations holds ${CORE.length} applied migration(s); nothing was written`,
    );
  });

  it("runs the compat copy over the app's own applied migration, which sets no schema_version", () => {
    const p = d1Project({
      migrationsDir: "migrations",
      files: { "migrations/0001_better_auth.sql": BA_SQLITE },
    });
    // The app applied its Better Auth tables before: d1_migrations holds one row, and ta_meta does not exist.
    wranglerLocal(p.dir, ["d1", "migrations", "apply", "cli-d1", "--local"]);
    const r = migrate(p.dir, ["--tables", "compat"]);
    expect(r.status, r.stderr).toBe(0);
    expect(linesOf(r.stdout).at(-1)).toBe("version before: none; version after: 8");
  });

  it("shows the usage line of each target on a usage error", () => {
    const p = d1Project({ modules: false });
    const r = migrate(p.dir, ["--url-env", "DATABASE_URL"]);
    expect(r.status).toBe(2);
    const usage = linesOf(r.stderr).filter((l) => l.startsWith("Usage: "));
    expect(usage).toHaveLength(2);
    expect(usage[0]).toContain("--target postgres");
    expect(usage[1]).toContain("--target d1");
    expect(usage[1]).toContain("--config <path>");
    expect(usage[1]).toContain("--before-1.7");
  });
});
