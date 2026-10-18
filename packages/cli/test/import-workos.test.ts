import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImportReport } from "@authtempo/import";
import { FIXTURE_EXPORTS } from "@authtempo/import/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertFreshBuild, linesOf, runBin } from "./support/bin.js";
import { freshDatabase } from "./support/pg.js";

// `authtempo import workos` (plan 11f Task 2): the four files of the guide's
// curl script, the flag --memberships, and no --formats, because no hash
// moves from WorkOS (owner decision 1 of 2026-10-14). Each run is a child
// process in a folder that holds the fixture export, on the docker compose
// Postgres with a schema that `authtempo migrate` wrote.

const WORKOS = FIXTURE_EXPORTS.workos.bundle.files;
const NAMES = ["users", "identities", "memberships", "organizations"] as const;
/** The four file flags, each with the file of the same name in the export folder. */
const ALL = NAMES.flatMap((name) => [`--${name}`, `${name}.json`]);
const PASSWORD_LINE =
  "workos: WorkOS exports no password hash; each user signs in by a magic link or sets a new password";

let db: Awaited<ReturnType<typeof freshDatabase>>;
const dirs: string[] = [];

/** A new folder with the four files of the WorkOS fixture export. */
function exportDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "authtempo-workos-"));
  dirs.push(dir);
  for (const name of NAMES) {
    const text = WORKOS[name];
    if (text === undefined) throw new Error(`the WorkOS fixture has no ${name} file`);
    writeFileSync(join(dir, `${name}.json`), text);
  }
  return dir;
}

/** Runs `authtempo import` in `dir`, with the test database as DATABASE_URL. */
const run = (args: readonly string[], dir: string) =>
  runBin(["import", ...args], { cwd: dir, env: { DATABASE_URL: db.url } });

beforeAll(async () => {
  assertFreshBuild();
  db = await freshDatabase();
  const m = runBin(["migrate", "--target", "postgres", "--url-env", "DATABASE_URL"], {
    env: { DATABASE_URL: db.url },
  });
  if (m.status !== 0) throw new Error(`authtempo migrate exited ${m.status}: ${m.stderr}`);
});
afterAll(async () => {
  await db.drop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

it("imports a WorkOS export with no --formats", () => {
  const dir = exportDir();
  const r = run(
    ["workos", ...ALL, "--target", "postgres", "--url-env", "DATABASE_URL", "--json"],
    dir,
  );
  expect(r.status, r.stderr).toBe(0);
  expect(linesOf(r.stdout)).toHaveLength(1);
  const doc = JSON.parse(r.stdout) as { report: ImportReport };
  expect(doc.report.created.user).toBe(2);
  expect(doc.report.created.organization).toBe(1);
  expect(doc.report.created.password).toBe(0);
  const err = linesOf(r.stderr);
  expect(err).toContain(PASSWORD_LINE);
  // Each file was given, so no line says that one is absent.
  expect(err.filter((l) => l.startsWith("workos: no --"))).toEqual([]);
});

it("refuses --legacy-verify for workos", () => {
  const dir = exportDir();
  // Before any file read: a path that does not exist gives the same message.
  for (const users of ["users.json", "no-such-users.json"]) {
    const r = run(
      [
        "workos",
        "--users",
        users,
        "--legacy-verify",
        "--target",
        "postgres",
        "--url-env",
        "DATABASE_URL",
      ],
      dir,
    );
    expect(r.status, users).toBe(2);
    expect(linesOf(r.stderr)[0], users).toBe(
      "workos takes no --legacy-verify: WorkOS exports no password hash",
    );
  }
});

it("prints one line for each file that it does not have", () => {
  const dir = exportDir();
  const r = run(
    [
      "workos",
      "--users",
      "users.json",
      "--target",
      "postgres",
      "--url-env",
      "DATABASE_URL",
      "--dry-run",
    ],
    dir,
  );
  expect(r.status, r.stderr).toBe(0);
  const err = linesOf(r.stderr);
  expect(err).toContain(PASSWORD_LINE);
  expect(err).toContain("workos: no --identities file; no social identity is imported");
  expect(err).toContain("workos: no --organizations file; no organization is imported");
});

it("stops on one file of the membership pair", () => {
  const dir = exportDir();
  const r = run(
    [
      "workos",
      "--users",
      "users.json",
      "--memberships",
      "memberships.json",
      "--target",
      "postgres",
      "--url-env",
      "DATABASE_URL",
    ],
    dir,
  );
  expect(r.status).toBe(2);
  const last = linesOf(r.stderr).at(-1) ?? "";
  expect(last).toMatch(/^stopped: /);
  expect(last).toContain("needs the organizations input");
  expect(last).toContain("nothing was written");
});

it("refuses --memberships for another provider", () => {
  const dir = exportDir();
  const r = run(
    [
      "clerk",
      "--csv",
      "users.csv",
      "--users",
      "users.json",
      "--memberships",
      "memberships.json",
      "--formats",
      "none",
      "--target",
      "postgres",
      "--url-env",
      "DATABASE_URL",
    ],
    dir,
  );
  expect(r.status).toBe(2);
  expect(linesOf(r.stderr)[0]).toBe("clerk takes no --memberships");
});

it("writes the WorkOS bundle for the D1 Worker", () => {
  const dir = exportDir();
  const r = run(["workos", ...ALL, "--target", "d1-bundle", "--out", "b.json"], dir);
  expect(r.status, r.stderr).toBe(0);
  const file = join(dir, "b.json");
  const doc = JSON.parse(readFileSync(file, "utf8")) as {
    bundle: { provider: string; files: Record<string, string> };
  };
  expect(doc.bundle.provider).toBe("workos");
  expect(Object.keys(doc.bundle.files).sort()).toEqual([
    "identities",
    "memberships",
    "organizations",
    "users",
  ]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});
