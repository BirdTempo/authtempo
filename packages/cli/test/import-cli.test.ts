import { join } from "node:path";
import { applyPostgresMigrations } from "@authtempo/adapter-postgres";
import { LEGACY_FORMATS } from "@authtempo/legacy-hashes";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ALIAS_LINES } from "../src/commands/import-alias.js";
import { IMPORT_JSON_KEYS } from "../src/json.js";
import { ALIAS, assertFreshBuild, linesOf, PKG, runBin } from "./support/bin.js";
import { freshDatabase } from "./support/pg.js";

// The two binaries as child processes on the docker compose Postgres (plan 11c).
const FIXTURES = join(PKG, "../import/test/fixtures");
const FILES = [
  "--users",
  join(FIXTURES, "supabase-users.csv"),
  "--identities",
  join(FIXTURES, "supabase-identities.csv"),
  "--formats",
  LEGACY_FORMATS.join(","),
];

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeAll(async () => {
  assertFreshBuild();
  db = await freshDatabase();
  await applyPostgresMigrations(db.sql);
});
afterAll(async () => {
  await db.drop();
});

const newRun = (extra: string[], url: string) =>
  runBin(
    [
      "import",
      "supabase",
      ...FILES,
      "--target",
      "postgres",
      "--url-env",
      "TEST_DB_URL",
      "--dry-run",
      ...extra,
    ],
    {
      env: { TEST_DB_URL: url },
    },
  );

it("prints the same report and exits with the same code from the alias and from authtempo import (spec 19)", () => {
  const old = runBin(["supabase", ...FILES, "--postgres", db.url, "--dry-run"], { bin: ALIAS });
  const neu = newRun([], db.url);
  // The fixture holds two hashes that no format verifies: the first test of the alias suite.
  expect(old.status).toBe(1);
  expect(neu.status).toBe(old.status);
  expect(neu.stdout).toBe(old.stdout);
  expect(linesOf(old.stderr).slice(0, 2)).toEqual([ALIAS_LINES.renamed, ALIAS_LINES.postgres]);
  expect(linesOf(neu.stderr)[0]).toMatch(/^connecting to \S+:\d+\/cli_/);
  expect(neu.stdout + neu.stderr).not.toContain(db.url);
});

it("prints one JSON document with the report on --json, and the summary on stderr", () => {
  const r = newRun(["--json"], db.url);
  expect(r.status).toBe(1);
  expect(linesOf(r.stdout)).toHaveLength(1);
  const doc = JSON.parse(r.stdout) as { report: { source: string; dryRun: boolean } } & Record<
    string,
    unknown
  >;
  expect(Object.keys(doc).sort()).toEqual(Object.keys(IMPORT_JSON_KEYS).sort());
  expect(doc.report).toMatchObject({ source: "supabase", dryRun: true });
  expect(linesOf(r.stderr)).toContain("supabase (dry run, nothing written)");
});

it("stops with exit 2 on a refused connection, and no output holds the password", () => {
  const r = newRun([], "postgres://app:s3cret-canary@127.0.0.1:1/none");
  expect(r.status).toBe(2);
  expect(linesOf(r.stderr).at(-1)).toBe(
    "stopped: storage: ECONNREFUSED at 127.0.0.1:1/none; nothing was written",
  );
  expect(r.stdout + r.stderr).not.toContain("s3cret-canary");
});

it("names a refused login by its SQLSTATE and the host only: no line names the user", () => {
  const url = db.url.replace(/\/\/[^@]+@/, "//no_such_user_canary:wrong-pass-canary@");
  const r = newRun([], url);
  expect(r.status).toBe(2);
  const host = new URL(url);
  expect(linesOf(r.stderr).at(-1)).toBe(
    `stopped: storage: 28P01 at ${host.hostname}:${host.port}${host.pathname}; nothing was written`,
  );
  expect(r.stdout + r.stderr).not.toContain("canary");
});

it("keeps the old usage text on a usage error of the alias", () => {
  const r = runBin([], { bin: ALIAS });
  expect(r.status).toBe(2);
  expect(linesOf(r.stderr)[0]).toBe(ALIAS_LINES.renamed);
  expect(r.stderr).toContain(
    "authtempo-import <provider> [files] (--postgres <url> | --d1-bundle <file>) [options]",
  );
});
