import { join } from "node:path";
import { LEGACY_FORMATS } from "@authtempo/legacy-hashes";
import { beforeAll, describe, expect, it } from "vitest";
import { SUPABASE_FIXTURE_CREATED } from "../../import/test/fixtures/supabase-counts.js";
import { IMPORT_JSON_KEYS } from "../src/json.js";
import { assertFreshBuild, linesOf, PKG, runBin } from "./support/bin.js";

// `authtempo import --target memory` (plan 11e Task 1): a plan against an
// empty store, with --dry-run only and no connection string.

beforeAll(() => {
  assertFreshBuild();
});

const FIXTURES = join(PKG, "../import/test/fixtures");
const SUPABASE = [
  "import",
  "supabase",
  "--users",
  join(FIXTURES, "supabase-users.csv"),
  "--identities",
  join(FIXTURES, "supabase-identities.csv"),
  "--formats",
  LEGACY_FORMATS.join(","),
];
const MISSING = [
  "import",
  "supabase",
  "--users",
  join(FIXTURES, "no-such-users.csv"),
  "--identities",
  join(FIXTURES, "no-such-identities.csv"),
  "--formats",
  "bcrypt",
];

interface Doc {
  report: { dryRun: boolean; created: { user: number } } & Record<string, unknown>;
  stopped: string | null;
}

describe("authtempo import --target memory (plan 11e)", () => {
  it("plans against an empty store with --target memory --dry-run", () => {
    const r = runBin([...SUPABASE, "--target", "memory", "--dry-run", "--json"]);
    expect([0, 1], r.stderr).toContain(r.status);
    expect(linesOf(r.stdout)).toHaveLength(1);
    const doc = JSON.parse(r.stdout) as Doc;
    expect(Object.keys(doc).sort()).toEqual(Object.keys(IMPORT_JSON_KEYS).sort());
    expect(doc.report.dryRun).toBe(true);
    expect(doc.report.created.user).toBe(SUPABASE_FIXTURE_CREATED.user);
  });

  it("refuses --target memory without --dry-run", () => {
    for (const args of [SUPABASE, MISSING]) {
      const r = runBin([...args, "--target", "memory"]);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
      expect(linesOf(r.stderr)[0]).toBe("--target memory needs --dry-run");
    }
  });

  it("refuses --target memory with --tables compat", () => {
    const r = runBin([...SUPABASE, "--target", "memory", "--tables", "compat", "--dry-run"]);
    expect(r.status).toBe(2);
    expect(linesOf(r.stderr)[0]).toBe("--tables compat needs --target postgres");
  });

  it("reads no connection string for --target memory", () => {
    // runBin passes no DATABASE_URL; a set one must not matter either.
    for (const env of [{}, { DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" }]) {
      const r = runBin([...SUPABASE, "--target", "memory", "--dry-run"], { env });
      expect([0, 1], r.stderr).toContain(r.status);
      expect(r.stderr).not.toContain("connecting to");
      expect(r.stderr).not.toContain("DATABASE_URL");
    }
  });

  it("names the three targets in the usage error", () => {
    const r = runBin([...SUPABASE, "--target", "nowhere", "--dry-run"]);
    expect(r.status).toBe(2);
    expect(linesOf(r.stderr)[0]).toMatch(
      /^--target is one of postgres, d1-bundle, memory(\. Did you mean \S+\?)?$/,
    );
  });
});
