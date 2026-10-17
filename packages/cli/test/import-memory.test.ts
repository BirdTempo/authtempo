import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitCode, type ImportReport } from "@authtempo/import";
import { LEGACY_FORMATS } from "@authtempo/legacy-hashes";
import { beforeAll, describe, expect, it } from "vitest";
import { SUPABASE_FIXTURE_CREATED } from "../../import/test/fixtures/supabase-counts.js";
import { IMPORT_JSON_KEYS } from "../src/json.js";
import { main } from "../src/main.js";
import { assertFreshBuild, linesOf, PKG, runBin } from "./support/bin.js";
import { fakeIo } from "./support/fake-io.js";

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
  report: ImportReport;
  stopped: string | null;
}

describe("authtempo import --target memory (plan 11e)", () => {
  it("plans against an empty store with --target memory --dry-run", () => {
    const r = runBin([...SUPABASE, "--target", "memory", "--dry-run", "--json"]);
    expect(linesOf(r.stdout)).toHaveLength(1);
    const doc = JSON.parse(r.stdout) as Doc;
    // The exit code follows the report, as a run against a database does.
    expect(r.status, r.stderr).toBe(exitCode(doc.report));
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

  it("refuses --tables compat in the shared parse, before any file read", async () => {
    // In process with a fake io: the one copy of the rule is in import-core.ts.
    const io = fakeIo();
    const code = await main(
      [...MISSING, "--target", "memory", "--tables", "compat", "--dry-run"],
      io,
    );
    expect(code).toBe(2);
    expect(io.stderr[0]).toBe("--tables compat needs --target postgres");
    expect(io.reads).toEqual([]);
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

  it("names the input and the place when an export is not JSON, never the file text", () => {
    // A .env file named as the export: V8's parse text would quote its start.
    const secret = "DATABASE_URL=postgres://owner:Zq9xK7wV@db.example.net/app\n";
    const dir = mkdtempSync(join(tmpdir(), "authtempo-json-fault-"));
    try {
      const file = join(dir, ".env");
      writeFileSync(file, secret);
      const argv = ["import", "cognito", "--users", file, "--target", "memory", "--dry-run"];
      const fault =
        "authtempo import: the Cognito users input is not JSON (the fault is at line 1, column 1)";
      const shell = runBin(argv);
      expect(shell.status).toBe(2);
      expect(linesOf(shell.stderr)).toEqual([`stopped: ${fault}; nothing was written`]);
      const json = runBin([...argv, "--json"]);
      expect(json.status).toBe(2);
      const doc = JSON.parse(json.stdout) as Doc;
      expect(doc.stopped).toBe(`${fault}; nothing was written`);
      // Each run of four characters of the file: none may reach an answer.
      for (let i = 0; i + 4 <= secret.length; i++) {
        const run = secret.slice(i, i + 4);
        for (const text of [shell.stderr, json.stderr, doc.stopped ?? ""])
          expect(text).not.toContain(run);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
