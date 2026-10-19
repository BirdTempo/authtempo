import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostgresAdapter } from "@authtempo/adapter-postgres";
import { createAuth } from "@authtempo/core";
import { FIXTURE_EXPORTS } from "@authtempo/import/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IMPORT_JSON_KEYS } from "../src/json.js";
import { assertFreshBuild, linesOf, runBin } from "./support/bin.js";
import { freshDatabase } from "./support/pg.js";

// `authtempo import verify` (plan 11f Task 4; spec 23 item 7, owner decision
// 3 of 2026-10-14). The subcommand runs the dry run and exits 0 only when the
// database holds the whole export. Each database is made by a real
// `authtempo migrate`, and the records by a real `authtempo import`, both as
// child processes on the docker compose Postgres.

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
const PG = ["--target", "postgres", "--url-env", "TEST_DB_URL"];
const NOT_HELD =
  "verify: the database does not hold this export: 2 records would be written, 0 partial, 0 need a person";
const HELD = "verify: the database holds this export: user 2, organization 0";
const PROVIDERS = "name one provider: supabase, clerk, auth0, firebase, authjs, cognito, workos";

let dir: string;

beforeAll(() => {
  assertFreshBuild();
  dir = mkdtempSync(join(tmpdir(), "authtempo-verify-"));
  for (const name of ["users", "identities"] as const) {
    const text = SUPABASE.bundle.files[name];
    if (text === undefined) throw new Error(`the Supabase fixture has no ${name} file`);
    writeFileSync(join(dir, `${name}.csv`), text, { mode: 0o600 });
  }
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("on a database that authtempo migrate made", () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;

  /**
   * The child's URL and environment. The compose password `tempo` is a part
   * of `authtempo`, and the scrub of spec 19 writes `auth***` for it. So the
   * URL carries no password, and the driver reads PGPASSWORD.
   */
  function connection(): { url: string; password: string } {
    const u = new URL(db.url);
    const password = decodeURIComponent(u.password);
    u.password = "";
    return { url: u.href, password };
  }

  const run = (args: string[]) => {
    const c = connection();
    return runBin(args, { cwd: dir, env: { TEST_DB_URL: c.url, PGPASSWORD: c.password } });
  };

  /** The row count of each `ta_` table of the public schema, by name. */
  async function rowCounts(): Promise<Record<string, string>> {
    const tables = await db.sql<{ name: string }[]>`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'ta\\_%' ORDER BY table_name`;
    const out: Record<string, string> = {};
    for (const t of tables) {
      const n = await db.sql.unsafe<{ n: string }[]>(`SELECT count(*)::text AS n FROM ${t.name}`);
      out[t.name] = n[0]?.n ?? "";
    }
    return out;
  }

  /** The real run of the fixture, as the operator runs it before the verify. */
  function realRun(): void {
    const r = run(["import", ...FILES, ...PG]);
    expect(r.status, r.stderr).toBe(0);
    expect(linesOf(r.stdout)).toContain(
      "created: user 2, identity 2, password 2, passkey 0, organization 0, member 0",
    );
  }

  beforeEach(async () => {
    db = await freshDatabase();
    const m = run(["migrate", "--target", "postgres", "--url-env", "TEST_DB_URL"]);
    expect(m.status, m.stderr).toBe(0);
  });
  afterEach(async () => {
    await db.drop();
  });

  it("exits 1 on a fresh database and names the count", async () => {
    const r = run(["import", "verify", ...FILES, ...PG]);
    expect(r.status, r.stderr).toBe(1);
    expect(linesOf(r.stdout)).toContain(NOT_HELD);
    expect((await rowCounts()).ta_user).toBe("0");
  });

  it("exits 0 after the real run", () => {
    realRun();
    const r = run(["import", "verify", ...FILES, ...PG]);
    expect(r.status, r.stderr).toBe(0);
    expect(linesOf(r.stdout)).toContain(HELD);
  });

  it("prints the verify in the JSON document", () => {
    realRun();
    const r = run(["import", "verify", ...FILES, ...PG, "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(linesOf(r.stdout)).toHaveLength(1);
    const doc = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(Object.keys(IMPORT_JSON_KEYS).sort());
    expect(doc.verify).toEqual({ held: true, wouldWrite: 0, partial: 0, needPerson: 0, code: 0 });
    expect((doc.report as { dryRun: boolean }).dryRun).toBe(true);
    expect(doc.exit).toBe(0);
    // The verify line is a human line: under --json it goes to stderr.
    expect(linesOf(r.stderr)).toContain(HELD);

    const plain = run(["import", ...FILES, ...PG, "--dry-run", "--json"]);
    expect(plain.status, plain.stderr).toBe(0);
    expect((JSON.parse(plain.stdout) as Record<string, unknown>).verify).toBeNull();
  });

  it("exits 1 on a partial record after a claim", async () => {
    realRun();
    // Bob imports unverified with his password. A magic link sign-in over the
    // same database makes core's claim. The claim verifies him and deletes
    // the imported password, so his record lacks a row the export maps to.
    const sent: { to: string; text: string }[] = [];
    const auth = createAuth({
      baseURL: "https://api.example.com",
      trustedOrigins: [],
      secret: "0123456789abcdef0123456789abcdef",
      storage: createPostgresAdapter(db.sql),
      mail: {
        async send(m) {
          sent.push(m);
        },
      },
    });
    const post = (path: string, body: unknown) =>
      auth.handle(
        new Request(`https://api.example.com${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    expect((await post("/auth/magic-link/request", { email: "bob@example.com" })).status).toBe(200);
    const token = /token=([A-Za-z0-9_%-]+)/.exec(sent[0]?.text ?? "")?.[1] ?? "";
    expect(token).not.toBe("");
    const verify = await post("/auth/magic-link/verify", { token: decodeURIComponent(token) });
    expect(verify.status).toBe(200);
    const before = await rowCounts();
    expect(before.ta_password).toBe("1");

    const r = run(["import", "verify", ...FILES, ...PG]);
    expect(r.status, r.stderr).toBe(1);
    expect(linesOf(r.stdout)).toContain(
      "verify: the database does not hold this export: 0 records would be written, 1 partial, 0 need a person",
    );
    expect(await rowCounts()).toEqual(before);
  });
});

describe("the argument rules of import verify", () => {
  const run = (args: string[]) => runBin(args, { cwd: dir });

  it("refuses --repair, --dry-run, and --on-email-taken", () => {
    const repair = run(["import", "verify", ...FILES, ...PG, "--repair"]);
    expect(repair.status).toBe(2);
    expect(linesOf(repair.stderr)[0]).toBe("import verify reads only; it takes no --repair");
    const dryRun = run(["import", "verify", ...FILES, ...PG, "--dry-run"]);
    expect(dryRun.status).toBe(2);
    expect(linesOf(dryRun.stderr)[0]).toBe(
      "import verify always reads only; it takes no --dry-run",
    );
    // A stop at the first conflict gives no count (spec 23 item 7), so the flag is refused with either value.
    for (const value of ["fail", "skip"]) {
      const r = run(["import", "verify", ...FILES, ...PG, "--on-email-taken", value]);
      expect(r.status, value).toBe(2);
      expect(linesOf(r.stderr)[0], value).toBe(
        "import verify counts each conflict; it takes no --on-email-taken",
      );
    }
  });

  it("writes a verify bundle for the D1 Worker", () => {
    const out = join(dir, "v.json");
    const r = run(["import", "verify", ...FILES, "--target", "d1-bundle", "--out", out]);
    expect(r.status, r.stderr).toBe(0);
    const bundle = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    expect(bundle.verify).toBe(true);
    expect((bundle.options as { dryRun: boolean }).dryRun).toBe(true);
    expect((bundle.bundle as { provider: string }).provider).toBe("supabase");
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it("needs a provider after verify", () => {
    const r = run(["import", "verify"]);
    expect(r.status).toBe(2);
    expect(linesOf(r.stderr)[0]).toBe(PROVIDERS);
  });

  it("refuses --target memory", () => {
    const r = run(["import", "verify", ...FILES, "--target", "memory"]);
    expect(r.status).toBe(2);
    expect(linesOf(r.stderr)[0]).toBe(
      "import verify needs a database: --target postgres or --target d1-bundle",
    );
  });
});
