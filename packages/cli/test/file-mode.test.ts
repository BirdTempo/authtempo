import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_EXPORTS } from "@authtempo/import/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertFreshBuild, linesOf, runBin } from "./support/bin.js";

// The file mode warning of `authtempo import` (plan 11f Task 4; spec 23 item
// 6). An export holds addresses and can hold password hashes. A file that
// other users of the machine can read gets one warning line on stderr. The
// run goes on: the file is the operator's. Every export file of the command
// gets the check, the alias none (plan deviation 8).

const SUPABASE = FIXTURE_EXPORTS.supabase;
const FILES = [
  "supabase",
  "--users",
  "users.csv",
  "--identities",
  "identities.csv",
  "--formats",
  SUPABASE.formats.join(","),
];
const warning = (name: string) =>
  `warning: ${name} is readable by other users of this machine; an export holds addresses and can hold password hashes`;

let dir: string;

beforeAll(() => {
  assertFreshBuild();
  dir = mkdtempSync(join(tmpdir(), "authtempo-file-mode-"));
  for (const name of ["users", "identities"] as const) {
    const text = SUPABASE.bundle.files[name];
    if (text === undefined) throw new Error(`the Supabase fixture has no ${name} file`);
    writeFileSync(join(dir, `${name}.csv`), text, { mode: 0o600 });
  }
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const modes = (users: number, identities: number) => {
  chmodSync(join(dir, "users.csv"), users);
  chmodSync(join(dir, "identities.csv"), identities);
};
const warnings = (stderr: string) => linesOf(stderr).filter((l) => l.startsWith("warning:"));

it("warns on an export file that other users can read", () => {
  modes(0o644, 0o600);
  const r = runBin(["import", ...FILES, "--target", "memory", "--dry-run"], { cwd: dir });
  expect(warnings(r.stderr)).toEqual([warning("users.csv")]);
  // The run goes on: the report prints and the exit status is the report's.
  expect(r.status, r.stderr).toBe(0);
  expect(linesOf(r.stdout)).toContain("exists: user 0, organization 0");
});

it("prints no warning for mode 0600", () => {
  modes(0o600, 0o600);
  const r = runBin(["import", ...FILES, "--target", "memory", "--dry-run"], { cwd: dir });
  expect(r.status, r.stderr).toBe(0);
  expect(warnings(r.stderr)).toEqual([]);
});

it("warns for each file and for import verify too", () => {
  modes(0o640, 0o640);
  const r = runBin(["import", ...FILES, "--target", "memory", "--dry-run"], { cwd: dir });
  expect(r.status, r.stderr).toBe(0);
  expect(warnings(r.stderr)).toEqual([warning("users.csv"), warning("identities.csv")]);
  const out = join(dir, "v.json");
  const v = runBin(["import", "verify", ...FILES, "--target", "d1-bundle", "--out", out], {
    cwd: dir,
  });
  expect(v.status, v.stderr).toBe(0);
  expect(warnings(v.stderr)).toEqual([warning("users.csv"), warning("identities.csv")]);
});
