import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { betterAuthWarning } from "../src/better-auth-version.js";
import { assertFreshBuild, linesOf, PKG, runBin } from "./support/bin.js";
import { fakeIo } from "./support/fake-io.js";
import { freshDatabase } from "./support/pg.js";

/** The fixture projects: each holds node_modules/better-auth/package.json. */
const FIXTURES = join(PKG, "test/fixtures/better-auth");
const PACKAGE = "node_modules/better-auth/package.json";

/** The warning of a project folder /work whose package.json holds `text`. */
function warningOf(text: string): string | null {
  const io = fakeIo({ files: { [`/work/${PACKAGE}`]: text } });
  return betterAuthWarning(io, "/work");
}

/** The warning of the fixture project `name`. */
const fixture = (name: string) => warningOf(readFileSync(join(FIXTURES, name, PACKAGE), "utf8"));

const BELOW = (version: string) =>
  `warning: better-auth ${version} is below 1.7.7, which fixed a magic link takeover; upgrade it before the move, because the old system stays the rollback target`;

describe("betterAuthWarning (spec 23 item 12)", () => {
  it("warns on 1.7.2", () => {
    expect(fixture("1.7.2")).toBe(BELOW("1.7.2"));
  });

  it("warns on a prerelease of 1.7.7", () => {
    expect(fixture("1.7.7-beta.1")).toBe(BELOW("1.7.7-beta.1"));
  });

  it("prints nothing on 1.7.7 and on 1.8.0", () => {
    expect(fixture("1.7.7")).toBeNull();
    expect(fixture("1.8.0")).toBeNull();
  });

  it("prints nothing for the alias of the compatibility package", () => {
    expect(fixture("alias")).toBeNull();
  });

  it("warns when it cannot read the version", () => {
    expect(fixture("broken")).toBe(
      "warning: cannot read the version of better-auth in /work/node_modules/better-auth/package.json; upgrade Better Auth to 1.7.7 or later before the move",
    );
  });

  it("prints nothing without the package", () => {
    const io = fakeIo({ files: { "/work/package.json": '{ "name": "app" }' } });
    expect(betterAuthWarning(io, "/work")).toBeNull();
  });

  it("compares the versions as numbers", () => {
    expect(warningOf('{ "name": "better-auth", "version": "1.10.0" }')).toBeNull();
  });
});

describe("authtempo migrate --tables compat with the warning", () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  beforeAll(() => {
    assertFreshBuild();
  });
  beforeEach(async () => {
    db = await freshDatabase();
  });
  afterEach(async () => {
    await db.drop();
  });

  it("prints the warning on stderr of migrate --tables compat and goes on", () => {
    const run = (tables: string) =>
      runBin(
        ["migrate", "--target", "postgres", "--url-env", "TEST_DB_URL", "--tables", tables, "-n"],
        { cwd: join(FIXTURES, "1.7.2"), env: { TEST_DB_URL: db.url } },
      );
    const compat = run("compat");
    expect(compat.status, compat.stderr).toBe(0);
    expect(linesOf(compat.stderr)).toContain(BELOW("1.7.2"));
    expect(compat.stdout).toContain("version before: none; version after: none");
    const core = run("core");
    expect(core.status, core.stderr).toBe(0);
    expect(linesOf(core.stderr).filter((l) => l.startsWith("warning:"))).toEqual([]);
  });
});
