import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkSupport,
  entry,
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

const check = (
  rows: SupportRow[],
  today = "2027-02-01",
  migrations: Record<string, number[]> = FULL,
) => checkSupport({ rows, today, schemaVersion: 11, migrations });

describe("check-support", () => {
  it("passes an empty table before the first release", () => {
    const r = check([]);
    expect(summaryLine(r)).toBe("check-support: PASS minors=0 current=0 security=0 failures=0");
    expect(r.notes).toEqual(["no release exists"]);
  });

  it("fails two current minors", () => {
    const r = check([current("0.1", "2026-11-02"), current("0.2", "2027-01-01")]);
    expect(r.failures).toEqual([
      "2 minors are current (0.1, 0.2); a released table has exactly one current minor",
    ]);
    expect(summaryLine(r)).toBe("check-support: FAIL minors=2 current=2 security=0 failures=1");
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
    expect(summaryLine(r)).toBe("check-support: FAIL minors=1 current=0 security=0 failures=1");
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

  it("fails a security date that is not 3 months after the next minor's release", () => {
    const ok = check(twoMinors("2027-04-02"));
    expect(ok.failures).toEqual([]);
    expect(summaryLine(ok)).toBe("check-support: PASS minors=2 current=1 security=1 failures=0");
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
      expect(readMigrations(root)).toEqual({
        migrations: { "adapter-d1": [1, 2], "adapter-postgres": [1] },
        failures: [
          "packages/adapter-mysql has no migrations or src/migrations folder",
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

  it("passes the real tree: support.json, SCHEMA_VERSION, and each adapter's migrations", () => {
    const { lines, code } = entry(new URL("../../../", import.meta.url).pathname, "2026-10-21");
    // Later plans add adapters and schema versions, so the last note has a pattern.
    expect(lines.slice(0, 2)).toEqual([
      "check-support: PASS minors=0 current=0 security=0 failures=0",
      "  note: no release exists",
    ]);
    expect(lines[2]).toMatch(
      /^ {2}note: adapters=[1-9]\d* \(adapter-d1, adapter-postgres.*\), SCHEMA_VERSION \d+$/,
    );
    expect(lines).toHaveLength(3);
    expect(code).toBe(0);
  });
});
