import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPAT_FOLDERS,
  COMPAT_MIGRATIONS,
  checkSupport,
  entry,
  readCompat,
  readMigrationSources,
  readMigrations,
  readSchemaVersion,
  readSupport,
  type SupportRow,
} from "../src/check-support.ts";
import { summaryLine } from "../src/lib/report.ts";

/** Each adapter with each migration from the schema version 1 to 11. */
const FULL = {
  "adapter-d1": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  "adapter-postgres": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

const current = (minor: string, released: string, schemaFrom: number[] = [11]): SupportRow => ({
  minor,
  status: "current",
  released,
  schemaFrom,
});

/** Two minors: 0.1 has security fixes until `until`, and 0.2 is current from 2027-01-01. */
const twoMinors = (until: string): SupportRow[] => [
  {
    minor: "0.1",
    status: "security",
    released: "2026-11-02",
    securityUntil: until,
    schemaFrom: [9, 10, 11],
  },
  current("0.2", "2027-01-01"),
];

/**
 * The group version of a table: 0.0.0 with no row, and else the first patch of
 * the newest minor. The version pull request of a minor adds its row.
 */
const versionOf = (rows: SupportRow[]) => {
  const minors = rows.map((r) => r.minor.split(".").map(Number) as [number, number]);
  const newest = minors.sort((a, b) => a[0] - b[0] || a[1] - b[1]).at(-1);
  return newest === undefined ? "0.0.0" : `${newest[0]}.${newest[1]}.0`;
};
const check = (
  rows: SupportRow[],
  today = "2027-02-01",
  migrations: Record<string, number[]> = FULL,
  version = versionOf(rows),
) => checkSupport({ rows, today, schemaVersion: 11, migrations, version });

describe("check-support", () => {
  it("passes an empty table before the first release", () => {
    const r = check([]);
    expect(summaryLine(r)).toBe(
      "check-support: PASS minors=0 current=0 security=0 adapters=2 compat=0 failures=0",
    );
    expect(r.notes).toEqual(["no release exists"]);
  });

  it("fails an empty table above 0.0.0, and counts the adapters at 0.0.0 (ruling 47)", () => {
    // A release with no support row is a release with no promise.
    const released = check([], "2026-11-02", FULL, "0.1.0");
    expect(released.failures).toEqual([
      "the group is at 0.1.0, and release/support.json has no row; a release has a support row",
    ]);
    expect(released.notes).toEqual([]);
    expect(summaryLine(released)).toBe(
      "check-support: FAIL minors=0 current=0 security=0 adapters=2 compat=0 failures=1",
    );
    // At 0.0.0 the empty table is the expected state; the adapters keep the count above zero.
    const before = check([], "2026-11-02", FULL, "0.0.0");
    expect(before.failures).toEqual([]);
    expect(before.counts.adapters).toBe(2);
    expect(check([], "2026-11-02", {}, "0.0.0").failures).toEqual(["read 0 adapters"]);
    // The row of the first minor passes at its version.
    expect(check([current("0.1", "2026-11-02")], "2026-11-02", FULL, "0.1.0").failures).toEqual([]);
  });

  it("fails a table with no row of the minor of the group version (ruling 52)", () => {
    // The version pull request of 0.2.0 that forgot the row of 0.2.
    expect(check([current("0.1", "2026-11-02")], "2027-01-01", FULL, "0.2.0").failures).toEqual([
      "the group is at 0.2.0, and release/support.json has no row of its minor 0.2; each release minor has a support row",
    ]);
    // A patch of an older minor reads the row of that minor, also with the status security.
    expect(check(twoMinors("2027-04-01"), "2027-02-01", FULL, "0.1.3").failures).toEqual([]);
    expect(check(twoMinors("2027-04-01"), "2027-02-01", FULL, "0.2.4").failures).toEqual([]);
    expect(check(twoMinors("2027-04-01"), "2027-02-01", FULL, "0.3.0").failures).toEqual([
      "the group is at 0.3.0, and release/support.json has no row of its minor 0.3; each release minor has a support row",
    ]);
  });

  it("fails two current minors", () => {
    const r = check([current("0.1", "2026-11-02"), current("0.2", "2027-01-01")]);
    expect(r.failures).toEqual([
      "2 minors are current (0.1, 0.2); a released table has exactly one current minor",
    ]);
    expect(summaryLine(r)).toBe(
      "check-support: FAIL minors=2 current=2 security=0 adapters=2 compat=0 failures=1",
    );
  });

  it("fails a released table with no current minor (review m3)", () => {
    const unsupported: SupportRow = {
      minor: "0.1",
      status: "unsupported",
      released: "2026-11-02",
      schemaFrom: [],
    };
    const r = check([unsupported]);
    expect(r.failures).toEqual([
      "0 minors are current; a released table has exactly one current minor",
    ]);
    expect(summaryLine(r)).toBe(
      "check-support: FAIL minors=1 current=0 security=0 adapters=2 compat=0 failures=1",
    );
  });

  it("fails a current minor that is not the newest minor (review m3)", () => {
    const rows: SupportRow[] = [
      current("0.1", "2026-11-02"),
      { minor: "0.2", status: "unsupported", released: "2027-01-01", schemaFrom: [] },
    ];
    expect(check(rows).failures).toEqual([
      "0.1 is current and 0.2 is newer; the newest minor is the current minor",
    ]);
    // The order of the minors is by number: 0.10 is newer than 0.9.
    expect(
      check([
        {
          minor: "0.9",
          status: "security",
          released: "2026-11-02",
          securityUntil: "2027-04-01",
          schemaFrom: [11],
        },
        current("0.10", "2027-01-01"),
      ]).failures,
    ).toEqual([]);
  });

  it("fails two rows of one minor (review L1)", () => {
    const rows: SupportRow[] = [
      {
        minor: "0.1",
        status: "security",
        released: "2026-11-02",
        securityUntil: "2027-02-02",
        schemaFrom: [11],
      },
      current("0.1", "2026-11-02"),
    ];
    expect(check(rows).failures).toContain("the minor 0.1 has 2 rows; each minor has one row");
  });

  it("fails a minor that is not released after the older minor (review L1)", () => {
    const rows = (released: string): SupportRow[] => [
      { minor: "0.1", status: "unsupported", released: "2027-03-01", schemaFrom: [] },
      current("0.2", released),
    ];
    expect(check(rows("2027-01-01"), "2027-06-01").failures).toEqual([
      "0.2 released 2027-01-01, not after 0.1 released 2027-03-01; a newer minor is released later",
    ]);
    expect(check(rows("2027-03-01"), "2027-06-01").failures).toEqual([
      "0.2 released 2027-03-01, not after 0.1 released 2027-03-01; a newer minor is released later",
    ]);
    expect(check(rows("2027-03-02"), "2027-06-01").failures).toEqual([]);
  });

  it("fails a security date that is not 3 months after the next minor's release", () => {
    const ok = check(twoMinors("2027-04-02"));
    expect(ok.failures).toEqual([]);
    expect(summaryLine(ok)).toBe(
      "check-support: PASS minors=2 current=1 security=1 adapters=2 compat=0 failures=0",
    );
    expect(check(twoMinors("2027-05-01")).failures).toEqual([
      "0.1 has security fixes until 2027-05-01; owner decision 3 needs 3 months after 0.2 released 2027-01-01, from 2027-04-01 to 2027-04-08",
    ]);
    expect(check(twoMinors("2027-03-31")).failures).toEqual([
      "0.1 has security fixes until 2027-03-31; owner decision 3 needs 3 months after 0.2 released 2027-01-01, from 2027-04-01 to 2027-04-08",
    ]);
    // A security row needs a date and a newer minor.
    const [old] = twoMinors("2027-04-01");
    if (old === undefined) throw new Error("no row");
    const { securityUntil: _, ...noDate } = old;
    expect(check([noDate, current("0.2", "2027-01-01")]).failures).toEqual([
      "0.1 has the status security and no securityUntil",
    ]);
    expect(check([old]).failures).toEqual([
      "0 minors are current; a released table has exactly one current minor",
      "0.1 has the status security and no newer minor",
    ]);
    // 3 months after 30 November is the last day of February.
    const late: SupportRow[] = [
      { ...old, securityUntil: "2027-02-28" },
      current("0.2", "2026-11-30"),
    ];
    expect(check(late, "2027-01-01").failures).toEqual([]);
  });

  it("fails a minor past its security date that is not unsupported", () => {
    expect(check(twoMinors("2027-04-01"), "2027-04-02").failures).toEqual([
      "0.1 is past its security date 2027-04-01 and its status is security, not unsupported",
    ]);
    expect(check(twoMinors("2027-04-01"), "2027-04-01").failures).toEqual([]);
    const ended: SupportRow[] = [
      {
        minor: "0.1",
        status: "unsupported",
        released: "2026-11-02",
        securityUntil: "2027-04-01",
        schemaFrom: [],
      },
      current("0.2", "2027-01-01"),
    ];
    expect(check(ended, "2027-06-01").failures).toEqual([]);
    // An unsupported minor needs no migration chain: an adapter may drop its old migrations.
    const dropped = { ...FULL, "adapter-d1": [5, 6, 7, 8, 9, 10, 11] };
    const old = ended.map((r) => (r.minor === "0.1" ? { ...r, schemaFrom: [3] } : r));
    expect(check(old, "2027-06-01", dropped).failures).toEqual([]);
  });

  it("fails a schema version that no migration chain reaches", () => {
    const rows = [current("0.1", "2026-11-02", [3, 11])];
    expect(check(rows).failures).toEqual([]);
    expect(
      check(rows, "2027-02-01", { ...FULL, "adapter-d1": [5, 6, 7, 8, 9, 10, 11] }).failures,
    ).toEqual([
      "adapter-d1 has no migration to the schema version 4, so 0.1 cannot reach 11 from 3",
    ]);
    expect(
      check(rows, "2027-02-01", { ...FULL, "adapter-postgres": [1, 2, 3, 4, 5, 7, 8, 9, 10, 11] })
        .failures,
    ).toEqual([
      "adapter-postgres has no migration to the schema version 6, so 0.1 cannot reach 11 from 3",
    ]);
    expect(check(rows, "2027-02-01", {}).failures).toEqual(["read 0 adapters"]);
  });

  it("fails a supported schema version above SCHEMA_VERSION", () => {
    expect(check([current("0.1", "2026-11-02", [11, 12])]).failures).toEqual([
      "0.1 supports the schema version 12, above SCHEMA_VERSION 11",
    ]);
  });

  it("fails a support file of another shape", () => {
    expect(readSupport("[]")).toEqual({ rows: [], failures: [] });
    expect(readSupport("{}").failures).toEqual(["release/support.json is not an array"]);
    expect(readSupport("[").failures).toEqual(["release/support.json is not JSON"]);
    expect(
      readSupport(
        JSON.stringify([
          { minor: "1", status: "current", released: "2026-11-02", schemaFrom: [11] },
          { minor: "0.2", status: "old", released: "2026-11-02", schemaFrom: [11] },
          { minor: "0.3", status: "current", released: "2026-02-30", schemaFrom: [11] },
          { minor: "0.4", status: "current", released: "2026-11-02", schemaFrom: ["11"] },
          {
            minor: "0.5",
            status: "security",
            released: "2026-11-02",
            securityUntil: "soon",
            schemaFrom: [],
          },
          { minor: "0.6", status: "current", released: "2026-11-02", schemaFrom: [], extra: 1 },
        ]),
      ).failures,
    ).toEqual([
      "row 1: minor is 1; it must be <major>.<minor>",
      "row 2: status is old; it must be current, security, or unsupported",
      "row 3: released is 2026-02-30; it must be a real date YYYY-MM-DD",
      "row 4: schemaFrom must be a list of whole numbers",
      "row 5: securityUntil is soon; it must be a real date YYYY-MM-DD",
      "row 6: extra is not a key of a support row",
    ]);
  });

  it("reads each adapter's migration files and SCHEMA_VERSION", () => {
    const root = mkdtempSync(join(tmpdir(), "check-support-"));
    try {
      const write = (path: string, text = "") => {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write("packages/adapter-d1/migrations/0001_schema_v1.sql");
      write("packages/adapter-d1/migrations/0002_schema_v2.sql");
      write("packages/adapter-postgres/src/migrations/0001_schema_v1.ts");
      write("packages/adapter-postgres/src/migrations/notes.md");
      write("packages/adapter-mysql/package.json", "{}");
      write("packages/core/src/schema.ts", "export const SCHEMA_VERSION = 2;\n");
      write("release/migration-sources.json", "{}");
      expect(readMigrations(root)).toEqual({
        migrations: { "adapter-d1": [1, 2], "adapter-postgres": [1] },
        failures: [
          "packages/adapter-mysql has no migrations or src/migrations folder and no entry in release/migration-sources.json",
          "packages/adapter-postgres: notes.md is not a migration file name",
        ],
      });
      expect(readSchemaVersion(root)).toBe(2);
      write("packages/core/src/schema.ts", "export const SCHEMA_VERSION = SOME;\n");
      expect(readSchemaVersion(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("release/migration-sources.json (ruling 38)", () => {
    /** The proof of the SQLite entry, as the real file names it. */
    const PROOF = "packages/adapter-sqlite/test/migrations-copy.test.ts";
    const sqlite = (entry: Record<string, unknown> = {}) =>
      JSON.stringify({
        "adapter-sqlite": {
          from: "packages/adapter-d1/migrations",
          reason: "The build copies the D1 files.",
          proof: PROOF,
          ...entry,
        },
      });

    /** A tree with a D1 folder of two files, a SQLite package with no folder, and its proof. */
    const withTree = (fn: (root: string, write: (path: string, text?: string) => void) => void) => {
      const root = mkdtempSync(join(tmpdir(), "check-support-sources-"));
      try {
        const write = (path: string, text = "") => {
          mkdirSync(join(root, path, ".."), { recursive: true });
          writeFileSync(join(root, path), text);
        };
        write("packages/adapter-d1/migrations/0001_schema_v1.sql");
        write("packages/adapter-d1/migrations/0002_schema_v2.sql");
        write("packages/adapter-sqlite/package.json", "{}");
        write(PROOF);
        fn(root, write);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    it("takes the versions of the from folder for an adapter with an entry", () => {
      withTree((root, write) => {
        write("release/migration-sources.json", sqlite());
        expect(readMigrations(root)).toEqual({
          migrations: { "adapter-d1": [1, 2], "adapter-sqlite": [1, 2] },
          failures: [],
        });
      });
    });

    it("fails an adapter with neither a folder nor an entry", () => {
      withTree((root, write) => {
        write("release/migration-sources.json", "{}");
        expect(readMigrations(root)).toEqual({
          migrations: { "adapter-d1": [1, 2] },
          failures: [
            "packages/adapter-sqlite has no migrations or src/migrations folder and no entry in release/migration-sources.json",
          ],
        });
      });
    });

    it("fails an entry whose from folder has no migrations", () => {
      withTree((root, write) => {
        mkdirSync(join(root, "packages/adapter-d1/empty"));
        write("release/migration-sources.json", sqlite({ from: "packages/adapter-d1/empty" }));
        expect(readMigrations(root)).toEqual({
          migrations: { "adapter-d1": [1, 2] },
          failures: [
            "release/migration-sources.json: adapter-sqlite: packages/adapter-d1/empty has no migrations",
          ],
        });
        write("release/migration-sources.json", sqlite({ from: "packages/adapter-d1/gone" }));
        expect(readMigrations(root).failures).toEqual([
          "release/migration-sources.json: adapter-sqlite: packages/adapter-d1/gone has no migrations",
        ]);
      });
    });

    it("fails an entry whose proof file does not exist", () => {
      withTree((root, write) => {
        write(
          "release/migration-sources.json",
          sqlite({ proof: "packages/adapter-sqlite/test/gone.test.ts" }),
        );
        expect(readMigrations(root)).toEqual({
          migrations: { "adapter-d1": [1, 2] },
          failures: [
            "release/migration-sources.json: adapter-sqlite: the proof packages/adapter-sqlite/test/gone.test.ts does not exist",
          ],
        });
      });
    });

    it("fails an entry that names an adapter with its own folder", () => {
      withTree((root, write) => {
        write("packages/adapter-sqlite/src/migrations/0001_schema_v1.ts");
        write("release/migration-sources.json", sqlite());
        expect(readMigrations(root)).toEqual({
          migrations: { "adapter-d1": [1, 2], "adapter-sqlite": [1] },
          failures: [
            "release/migration-sources.json: packages/adapter-sqlite has its own migrations folder, so it takes no entry",
          ],
        });
      });
    });

    it("fails an entry that names no adapter package", () => {
      withTree((root, write) => {
        const entries = JSON.parse(sqlite());
        write(
          "release/migration-sources.json",
          JSON.stringify({ ...entries, "adapter-gone": entries["adapter-sqlite"] }),
        );
        expect(readMigrations(root).failures).toEqual([
          "release/migration-sources.json: adapter-gone is not an adapter package of packages/",
        ]);
      });
    });

    it("fails an entry whose from names a file (ruling 42)", () => {
      withTree((root, write) => {
        write("release/migration-sources.json", sqlite({ from: "packages/adapter-d1/one.sql" }));
        write("packages/adapter-d1/one.sql");
        expect(readMigrations(root)).toEqual({
          migrations: { "adapter-d1": [1, 2] },
          failures: [
            "release/migration-sources.json: adapter-sqlite: packages/adapter-d1/one.sql has no migrations",
          ],
        });
      });
    });

    it("fails an adapter whose own folder is empty (ruling 42)", () => {
      withTree((root, write) => {
        write("release/migration-sources.json", sqlite());
        mkdirSync(join(root, "packages/adapter-x/src/migrations"), { recursive: true });
        expect(readMigrations(root)).toEqual({
          migrations: { "adapter-d1": [1, 2], "adapter-sqlite": [1, 2], "adapter-x": [] },
          failures: ["packages/adapter-x: src/migrations has no migrations"],
        });
      });
    });

    it("fails a proof that is not a file under the test folder of the adapter (ruling 42)", () => {
      withTree((root, write) => {
        write("package.json", "{}");
        write("packages/adapter-d1/test/copy.test.ts");
        mkdirSync(join(root, "packages/adapter-sqlite/test/fixtures"));
        for (const proof of [
          "package.json",
          "packages",
          "packages/adapter-sqlite/test",
          "packages/adapter-sqlite/test/fixtures",
          "packages/adapter-d1/test/copy.test.ts",
        ]) {
          write("release/migration-sources.json", sqlite({ proof }));
          expect(readMigrations(root)).toEqual({
            migrations: { "adapter-d1": [1, 2] },
            failures: [
              `release/migration-sources.json: adapter-sqlite: the proof ${proof} is not a file under packages/adapter-sqlite/test/`,
            ],
          });
        }
      });
    });

    it("fails a __proto__ key as an entry with no package (ruling 42)", () => {
      withTree((root, write) => {
        const entries = JSON.parse(sqlite());
        const text = `{ "adapter-sqlite": ${JSON.stringify(entries["adapter-sqlite"])}, "__proto__": ${JSON.stringify(entries["adapter-sqlite"])} }`;
        expect(Object.keys(readMigrationSources(text).sources)).toEqual([
          "adapter-sqlite",
          "__proto__",
        ]);
        write("release/migration-sources.json", text);
        expect(readMigrations(root).failures).toEqual([
          "release/migration-sources.json: __proto__ is not an adapter package of packages/",
        ]);
      });
    });

    it("fails a missing file and a file of another shape", () => {
      withTree((root, write) => {
        expect(readMigrations(root).failures).toEqual([
          "release/migration-sources.json does not exist",
          "packages/adapter-sqlite has no migrations or src/migrations folder and no entry in release/migration-sources.json",
        ]);
        write("release/migration-sources.json", "[]");
        expect(readMigrations(root).failures[0]).toBe(
          "release/migration-sources.json is not an object",
        );
      });
      expect(readMigrationSources("{").failures).toEqual([
        "release/migration-sources.json is not JSON",
      ]);
      expect(
        readMigrationSources(
          JSON.stringify({
            a: 1,
            b: { from: "../x", reason: " ", proof: "p.ts", extra: true },
          }),
        ),
      ).toEqual({
        sources: {},
        failures: [
          "release/migration-sources.json: a is not an object",
          "release/migration-sources.json: b: extra is not a key of a migration source",
          "release/migration-sources.json: b: from ../x is not a path under the repository root",
          "release/migration-sources.json: b: reason must be a text that is not empty",
        ],
      });
    });
  });

  it("passes the real tree: support.json, SCHEMA_VERSION, and each adapter's migrations", () => {
    const root = new URL("../../../", import.meta.url).pathname;
    // The group version of the tree: check-packages holds core at it. The
    // version pull request moves it, and the test then holds the released table.
    const { version } = JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8"));
    const { lines, code } = entry(root, new Date().toISOString().slice(0, 10));
    if (version === "0.0.0") {
      expect(lines[0]).toMatch(
        /^check-support: PASS minors=0 current=0 security=0 adapters=[1-9]\d* compat=[1-9]\d* failures=0$/,
      );
      expect(lines[1]).toBe("  note: no release exists");
      expect(lines).toHaveLength(3);
    } else {
      // The current minor is the minor of the group version.
      const { rows } = readSupport(readFileSync(join(root, "release/support.json"), "utf8"));
      expect(rows.find((r) => r.status === "current")?.minor).toBe(
        version.split(".").slice(0, 2).join("."),
      );
      expect(lines[0]).toMatch(
        /^check-support: PASS minors=[1-9]\d* current=1 security=\d+ adapters=[1-9]\d* compat=[1-9]\d* failures=0$/,
      );
      expect(lines).toHaveLength(2);
    }
    // Later plans add adapters and schema versions, so the last note has a pattern.
    const note =
      /^ {2}note: adapters=([1-9]\d*) \((.*)\), compat=([1-9]\d*) \((.*)\), SCHEMA_VERSION \d+$/.exec(
        lines.at(-1) ?? "",
      );
    // The compat chains of `authtempo migrate --tables compat` (ruling 26 of plan 12j, L5).
    expect(note?.[4]?.split(", ")).toEqual(expect.arrayContaining(["compat-better-auth/d1"]));
    expect(note).not.toBeNull();
    // The SQLite adapter is read through its entry in release/migration-sources.json.
    expect(note?.[2]?.split(", ")).toEqual(
      expect.arrayContaining(["adapter-d1", "adapter-mysql", "adapter-postgres", "adapter-sqlite"]),
    );
    expect(code).toBe(0);
  });
});

// `authtempo migrate --tables compat` runs the compat migrations, and owner
// decision 3 holds them too. check-support read the adapters only (ruling
// 26 of plan 12j, L5, held by ruling 64, Minor 3).
describe("check-support on the compat chains", () => {
  /** A tree with the compat folders `files`, each folder to its file names. */
  function compatTree(files: Record<string, string[]>): string {
    const root = mkdtempSync(join(tmpdir(), "authtempo-check-support-compat-"));
    for (const [folder, names] of Object.entries(files)) {
      mkdirSync(join(root, COMPAT_MIGRATIONS, folder), { recursive: true });
      for (const name of names) writeFileSync(join(root, COMPAT_MIGRATIONS, folder, name), "--\n");
    }
    return root;
  }

  it("fails a supported schema version with no compat step to SCHEMA_VERSION", () => {
    const r = checkSupport({
      rows: [current("0.1", "2026-11-02", [9])],
      today: "2026-11-03",
      schemaVersion: 11,
      migrations: FULL,
      compat: { "compat-better-auth/d1": [5, 6, 7, 8, 9, 10] },
      version: "0.1.0",
    });
    expect(r.failures).toEqual([
      "compat-better-auth/d1 has no migration to the schema version 11, so 0.1 cannot reach 11 from 9",
    ]);
    expect(summaryLine(r)).toBe(
      "check-support: FAIL minors=1 current=1 security=0 adapters=2 compat=1 failures=1",
    );
  });

  it("reads each chain, holds each overlay to its chain, and fails a folder of no row", () => {
    const ok = compatTree({
      d1: ["0001_compat_better_auth.sql", "0002_compat_schema_v5.sql", "0003_compat_schema_v6.sql"],
      "d1-before-1.7": ["0001_compat_better_auth.sql"],
    });
    try {
      expect(readCompat(ok)).toEqual({ compat: { "compat-better-auth/d1": [5, 6] }, failures: [] });
    } finally {
      rmSync(ok, { recursive: true, force: true });
    }
    const bad = compatTree({
      d1: ["0001_compat_better_auth.sql", "notes.txt"],
      "d1-before-1.7": ["0002_compat_schema_v5.sql"],
      postgres: ["0001_compat_better_auth.sql"],
    });
    try {
      expect(readCompat(bad).failures).toEqual([
        `${COMPAT_MIGRATIONS}/postgres is neither a chain nor an overlay of COMPAT_FOLDERS`,
        `${COMPAT_MIGRATIONS}/d1: notes.txt is not a compat migration file name`,
        `${COMPAT_MIGRATIONS}/d1 has no compat migration`,
        `${COMPAT_MIGRATIONS}/d1-before-1.7: 0002_compat_schema_v5.sql has no file of the same name in its chain d1`,
      ]);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });

  it("names each folder of the real compat migrations", () => {
    const root = new URL("../../../", import.meta.url).pathname;
    const { compat, failures } = readCompat(decodeURIComponent(root));
    expect(failures).toEqual([]);
    expect(Object.keys(compat).length).toBe(
      Object.values(COMPAT_FOLDERS).filter((chain) => chain === null).length,
    );
  });
});
