import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRecords, entry, RECORD_GLOBS, readInput, recordOf } from "../src/check-records.ts";
import { isAncestor } from "../src/lib/git.ts";
import { RECORDS_BASE } from "../src/lib/release-facts.ts";
import { summaryLine } from "../src/lib/report.ts";
import { makeRepo, makeUnrelatedRepo, type Repo } from "./support/git-repo.ts";

const read = (name: string) =>
  readFileSync(new URL(`./fixtures/records/${name}`, import.meta.url), "utf8");
const CHANGELOG = "packages/core/CHANGELOG.md";
const MIGRATION = "packages/adapter-d1/migrations/0001_schema_v1.sql";
const ADVISORIES = "docs/security/advisories.md";
const one = (path: string, base: string | null, head: string | null) =>
  checkRecords({ files: [{ path, base, head }] });

let repo: Repo | undefined;
afterEach(() => repo?.remove());

describe("check-records", () => {
  it("passes a new section above the newest one", () => {
    const r = one(CHANGELOG, read("changelog/0.1.0.md"), read("changelog/0.2.0.md"));
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toBe(
      "check-records: PASS files=1 changelogs=1 migrations=0 advisories=0 failures=0",
    );
  });

  it("fails an edit of an old section", () => {
    const r = one(CHANGELOG, read("changelog/0.2.0.md"), read("changelog/edited.md"));
    expect(r.failures).toEqual([
      "packages/core/CHANGELOG.md: the section ## 0.1.0 differs from the merge base",
    ]);
    expect(summaryLine(r)).toMatch(/^check-records: FAIL /);
    // The title and the order of the old sections are old bytes too.
    expect(one(CHANGELOG, read("changelog/0.2.0.md"), read("changelog/title.md")).failures).toEqual(
      ["packages/core/CHANGELOG.md: the title differs from the merge base"],
    );
    expect(one(CHANGELOG, read("changelog/0.2.0.md"), read("changelog/order.md")).failures).toEqual(
      ["packages/core/CHANGELOG.md: the old sections are in another order"],
    );
  });

  it("fails a new section below the newest one", () => {
    expect(
      one(CHANGELOG, read("changelog/0.1.0.md"), read("changelog/below.md")).failures,
    ).toContain(
      "packages/core/CHANGELOG.md: the new section ## 0.2.0 is below the old section ## 0.1.0",
    );
  });

  it("fails a removed section", () => {
    expect(
      one(CHANGELOG, read("changelog/0.2.0.md"), read("changelog/removed.md")).failures,
    ).toEqual(["packages/core/CHANGELOG.md: the section ## 0.1.0 is gone"]);
  });

  it("fails a changelog removed at head", () => {
    expect(one(CHANGELOG, read("changelog/0.1.0.md"), null).failures).toEqual([
      "packages/core/CHANGELOG.md: the record is gone",
    ]);
  });

  it("fails an edit of a shipped migration", () => {
    const r = one(
      MIGRATION,
      read("migration/0001_schema_v1.sql"),
      read("migration/0001_schema_v1-edited.sql"),
    );
    expect(r.failures).toEqual([
      "packages/adapter-d1/migrations/0001_schema_v1.sql: the migration differs from the merge base",
    ]);
  });

  it("fails a removed migration", () => {
    expect(one(MIGRATION, read("migration/0001_schema_v1.sql"), null).failures).toEqual([
      "packages/adapter-d1/migrations/0001_schema_v1.sql: the record is gone",
    ]);
  });

  it("passes a new migration file", () => {
    expect(summaryLine(one(MIGRATION, null, read("migration/0001_schema_v1.sql")))).toBe(
      "check-records: PASS files=1 changelogs=0 migrations=1 advisories=0 failures=0",
    );
  });

  it("holds the advisory record the same way", () => {
    expect(
      summaryLine(one(ADVISORIES, read("advisories/base.md"), read("advisories/appended.md"))),
    ).toBe("check-records: PASS files=1 changelogs=0 migrations=0 advisories=1 failures=0");
    expect(
      one(ADVISORIES, read("advisories/base.md"), read("advisories/edited.md")).failures,
    ).toEqual([
      "docs/security/advisories.md: the text at the merge base is not the start of the text now; a new entry goes at the end",
    ]);
    // A changelog grows at the top, so the same append fails there.
    expect(
      one(CHANGELOG, read("advisories/base.md"), read("advisories/appended.md")).failures,
    ).toContain(
      "packages/core/CHANGELOG.md: the new section ## 2026-10-20: fixture-package GHSA-0000-0000-0002 is below the old section ## 2026-10-14: fixture-package GHSA-0000-0000-0001",
    );
  });

  it("fails when it reads zero records", () => {
    const r = checkRecords({ files: [] });
    expect(r.failures).toEqual(["read 0 files"]);
    expect(summaryLine(r)).toBe(
      "check-records: FAIL files=0 changelogs=0 migrations=0 advisories=0 failures=1",
    );
  });

  it("matches each record glob and no other path", () => {
    expect(RECORD_GLOBS.map((g) => g.glob)).toEqual([
      "packages/*/CHANGELOG.md",
      "docs/security/advisories.md",
      "packages/*/migrations/**",
      "packages/*/src/migrations/**",
    ]);
    expect(recordOf("packages/core/CHANGELOG.md")?.kind).toBe("changelogs");
    expect(recordOf("docs/security/advisories.md")?.kind).toBe("advisories");
    expect(
      recordOf("packages/compat-better-auth/migrations/d1/0001_compat_better_auth.sql")?.kind,
    ).toBe("migrations");
    // The Postgres text of the compat runner is a record too (ruling 67 of plan 12j, Minor 2).
    expect(
      recordOf("packages/compat-better-auth/migrations/postgres/0001_compat_better_auth.sql")
        ?.kind,
    ).toBe("migrations");
    expect(recordOf("packages/adapter-postgres/src/migrations/0001_schema_v1.ts")?.kind).toBe(
      "migrations",
    );
    for (const path of [
      "CHANGELOG.md",
      "packages/import/worker/CHANGELOG.md",
      "packages/core/src/schema.ts",
      "packages/core/migrations",
      "docs/security/advisories.md.bak",
    ])
      expect(recordOf(path)).toBeUndefined();
    expect(() =>
      checkRecords({ files: [{ path: "README.md", base: "a\n", head: "a\n" }] }),
    ).toThrow("README.md matches no row of RECORD_GLOBS");
  });

  it("prints a FAIL line with the reason when no merge base exists", () => {
    repo = makeUnrelatedRepo();
    expect(entry(repo.root, "main")).toEqual({
      lines: [
        "check-records: FAIL files=0 changelogs=0 migrations=0 advisories=0 failures=1",
        "  no merge base of HEAD and main; fetch the full history (fetch-depth: 0)",
      ],
      code: 1,
    });
  });

  it("reads the records at the merge base and in the working tree", () => {
    repo = makeRepo();
    repo.write(CHANGELOG, read("changelog/0.1.0.md"));
    repo.write(MIGRATION, read("migration/0001_schema_v1.sql"));
    repo.write("packages/core/src/schema.ts", "export const SCHEMA_VERSION = 1;\n");
    repo.commit("first");
    repo.git(["checkout", "--quiet", "-b", "work"]);
    // One commit on the branch, so the merge base is before HEAD, as in a pull request.
    repo.write("packages/core/src/schema.ts", "export const SCHEMA_VERSION = 2;\n");
    repo.commit("work");
    // A change that is not committed counts, and so does a removal.
    repo.write(CHANGELOG, read("changelog/edited.md"));
    rmSync(join(repo.root, MIGRATION));
    repo.write("packages/adapter-d1/migrations/0002_schema_v2.sql", "-- Schema version 2.\n");
    const input = readInput(repo.root, "main");
    expect(input.files.map((f) => [f.path, f.base !== null, f.head !== null])).toEqual([
      ["packages/adapter-d1/migrations/0001_schema_v1.sql", true, false],
      ["packages/adapter-d1/migrations/0002_schema_v2.sql", false, true],
      ["packages/core/CHANGELOG.md", true, true],
    ]);
    const r = checkRecords(input);
    expect(summaryLine(r)).toBe(
      "check-records: FAIL files=3 changelogs=1 migrations=2 advisories=0 failures=2",
    );
  });
});

// A push to main and a tag of a main commit have a merge base equal to HEAD.
// The check then compared HEAD with itself and printed PASS (ruling 67 of
// plan 12j, Major 2, the probe of final review A).
describe("check-records at a merge base equal to HEAD", () => {
  /** A repository on main with a changelog and a migration, and the sha of that first commit. */
  function released(): { repo: Repo; first: string } {
    const r = makeRepo();
    r.write(CHANGELOG, read("changelog/0.1.0.md"));
    r.write(MIGRATION, read("migration/0001_schema_v1.sql"));
    r.commit("first");
    return { repo: r, first: r.git(["rev-parse", "HEAD"]).trim() };
  }

  it("compares with the newest release tag before HEAD", () => {
    const made = released();
    repo = made.repo;
    repo.git(["tag", "v0.1.0"]);
    // A commit on main that edits a shipped migration, then the tag of the next release on it.
    repo.write(MIGRATION, read("migration/0001_schema_v1-edited.sql"));
    repo.commit("edit");
    repo.git(["tag", "v0.2.0"]);
    expect(entry(repo.root, "main", made.first)).toEqual({
      lines: [
        "check-records: FAIL files=2 changelogs=1 migrations=1 advisories=0 failures=1",
        "  packages/adapter-d1/migrations/0001_schema_v1.sql: the migration differs from v0.1.0",
        "  note: the merge base with main is HEAD, so the base is v0.1.0, the newest release tag",
      ],
      code: 1,
    });
  });

  it("compares with RECORDS_BASE while no release tag exists", () => {
    const made = released();
    repo = made.repo;
    repo.write(CHANGELOG, read("changelog/edited.md"));
    repo.commit("edit");
    const short = made.first.slice(0, 8);
    expect(entry(repo.root, "main", made.first)).toEqual({
      lines: [
        "check-records: FAIL files=2 changelogs=1 migrations=1 advisories=0 failures=1",
        `  packages/core/CHANGELOG.md: the section ## 0.1.0 differs from RECORDS_BASE ${short}`,
        `  note: the merge base with main is HEAD and no release tag exists, so the base is RECORDS_BASE ${short}`,
      ],
      code: 1,
    });
  });

  it("holds a change that is not committed against HEAD too", () => {
    const made = released();
    repo = made.repo;
    // The advisory record is new after RECORDS_BASE, so only HEAD holds its old entry.
    repo.write(ADVISORIES, read("advisories/base.md"));
    repo.commit("advisory");
    repo.write(ADVISORIES, read("advisories/edited.md"));
    expect(entry(repo.root, "main", made.first).lines.slice(0, 2)).toEqual([
      "check-records: FAIL files=3 changelogs=1 migrations=1 advisories=1 failures=1",
      "  docs/security/advisories.md: the text at HEAD is not the start of the text now; a new entry goes at the end",
    ]);
  });

  it("never prints PASS with no compare", () => {
    const made = released();
    repo = made.repo;
    // RECORDS_BASE that this history lacks, and RECORDS_BASE equal to HEAD.
    const gone = "0123456789abcdef0123456789abcdef01234567";
    expect(entry(repo.root, "main", gone)).toEqual({
      lines: [
        "check-records: FAIL files=0 changelogs=0 migrations=0 advisories=0 failures=1",
        `  the merge base with main is HEAD, no release tag exists, and RECORDS_BASE ${gone} is not an ancestor of HEAD; fetch the full history (fetch-depth: 0)`,
      ],
      code: 1,
    });
    expect(entry(repo.root, "main", made.first)).toEqual({
      lines: [
        "check-records: FAIL files=0 changelogs=0 migrations=0 advisories=0 failures=1",
        "  the merge base with main and RECORDS_BASE are both HEAD, so no record was compared; set RECORDS_BASE to a commit before HEAD",
      ],
      code: 1,
    });
  });

  it("holds RECORDS_BASE to an ancestor of HEAD of this repository", () => {
    const root = new URL("../../../", import.meta.url).pathname;
    expect(RECORDS_BASE).toMatch(/^[0-9a-f]{40}$/);
    expect(isAncestor(decodeURIComponent(root), RECORDS_BASE)).toBe(true);
  });
});
