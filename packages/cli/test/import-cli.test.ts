import { join } from "node:path";
import { applyPostgresMigrations } from "@authtempo/adapter-postgres";
import { LEGACY_FORMATS } from "@authtempo/legacy-hashes";
import { afterAll, beforeAll, expect, it } from "vitest";
import { SUPABASE_FIXTURE_CREATED } from "../../import/test/fixtures/supabase-counts.js";
import { IMPORT_JSON_KEYS } from "../src/json.js";
import { assertFreshBuild, linesOf, PKG, runBin } from "./support/bin.js";
import { freshDatabase } from "./support/pg.js";

// `authtempo import` as a child process on the docker compose Postgres (plan
// 11c). Each run here is a dry run, so the database holds no user at any time.
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

it("prints the report of a dry run, writes nothing, and no line holds the connection string (spec 19)", async () => {
  const r = newRun([], db.url);
  // The fixture holds two hashes that no format verifies.
  expect(r.status, r.stderr).toBe(1);
  const out = linesOf(r.stdout);
  expect(out[0]).toBe("supabase (dry run, nothing written)");
  const c = SUPABASE_FIXTURE_CREATED;
  expect(out).toContain(
    `created: user ${c.user}, identity ${c.identity}, password ${c.password}, passkey 0, organization 0, member 0`,
  );
  expect(out.filter((l) => l.startsWith("refused hash "))).toHaveLength(2);
  // The fixture files of the repo are readable by other users, so the command
  // warns on each (plan 11f).
  const lines = linesOf(r.stderr).filter((l) => !l.startsWith("warning: "));
  expect(lines[0]).toMatch(/^connecting to \S+:\d+\/cli_/);
  expect(r.stdout + r.stderr).not.toContain(db.url);
  const rows = await db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM ta_user`;
  expect(rows[0]?.n).toBe("0");
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
