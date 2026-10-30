import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SQLITE_MIGRATIONS } from "../src/migrations.js";

const D1_DIR = fileURLToPath(new URL("../../adapter-d1/migrations/", import.meta.url));
const GENERATED = fileURLToPath(new URL("../src/migrations.generated.ts", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/copy-migrations.mjs", import.meta.url));

const d1Files = readdirSync(D1_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A temporary tree with the layout that the script reads from its own folder:
 * a copy of the script in adapter-sqlite/scripts, and a copy of each D1 file
 * in adapter-d1/migrations. So the test runs the real script, and it never
 * writes the module of this package.
 */
function scratchTree(): { script: string; target: string; migrations: string } {
  const root = mkdtempSync(join(tmpdir(), "authtempo-copy-migrations-"));
  made.push(root);
  const script = join(root, "adapter-sqlite/scripts/copy-migrations.mjs");
  const migrations = join(root, "adapter-d1/migrations");
  mkdirSync(join(root, "adapter-sqlite/scripts"), { recursive: true });
  mkdirSync(join(root, "adapter-sqlite/src"));
  mkdirSync(migrations, { recursive: true });
  copyFileSync(SCRIPT, script);
  for (const f of d1Files) copyFileSync(`${D1_DIR}${f}`, join(migrations, f));
  return { script, target: join(root, "adapter-sqlite/src/migrations.generated.ts"), migrations };
}

/** Runs the script, and gives its line. */
function copyMigrations(script: string): string {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

/** A time long before the run, so that any write moves the mtime. */
const PAST = new Date("2026-01-01T00:00:00Z");

describe("the SQLite migrations (plan 12g)", () => {
  it("holds every D1 file byte for byte", () => {
    expect(d1Files.length).toBeGreaterThan(0);
    for (const [i, file] of d1Files.entries()) {
      const entry = SQLITE_MIGRATIONS[i];
      expect(entry?.name, file).toBe(file.slice(0, -".sql".length));
      expect(entry?.sql === readFileSync(`${D1_DIR}${file}`, "utf8"), `${file} differs`).toBe(true);
    }
    expect(SQLITE_MIGRATIONS.map((m) => m.name)).toEqual(d1Files.map((f) => f.slice(0, -4)));
  });

  // The typecheck runs the script after the build. A write of the same bytes
  // made src newer than dist, so the build-age rule of release-check failed
  // on a fresh build (ruling 57 of plan 12j).
  it("writes the module only when its bytes differ", () => {
    const tree = scratchTree();
    const count = `copy-migrations: ${d1Files.length} files`;
    expect(copyMigrations(tree.script)).toBe(`${count}, written`);
    // The same D1 files give the same bytes as the module of this package.
    expect(readFileSync(tree.target, "utf8")).toBe(readFileSync(GENERATED, "utf8"));
    utimesSync(tree.target, PAST, PAST);
    // A second run, as the typecheck after the build, keeps the mtime.
    expect(copyMigrations(tree.script)).toBe(`${count}, unchanged`);
    expect(statSync(tree.target).mtimeMs).toBe(PAST.getTime());
    // A changed migration writes, so the build-age rule fails until the next build.
    const last = d1Files.at(-1);
    if (last === undefined) throw new Error("no D1 file");
    appendFileSync(join(tree.migrations, last), "\n-- a change\n");
    expect(copyMigrations(tree.script)).toBe(`${count}, written`);
    expect(statSync(tree.target).mtimeMs).toBeGreaterThan(PAST.getTime());
    expect(readFileSync(tree.target, "utf8")).toContain("-- a change");
  });
});
