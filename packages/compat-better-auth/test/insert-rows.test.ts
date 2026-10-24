import type { TeamRow } from "@authtempo/core";
import { afterEach, describe, expect, it } from "vitest";
import { MAPPING } from "../src/storage/mapping.js";
import { resolveNames } from "../src/storage/names.js";
import { compatStatements } from "../src/storage/statements.js";

// The insert of many rows takes its columns from the first row (ruling 85 of plan 12d,
// LO-1). It binds the values of each row in that order. A row that names other columns
// throws.

/** The team map, writable for the test: the shipped map is read-only by type only. */
const map = MAPPING.team as {
  insertExtras?: ((row: TeamRow) => Record<string, unknown>) | undefined;
};
const extras = map.insertExtras;

afterEach(() => {
  map.insertExtras = extras;
});

const at = new Date("2026-10-24T00:00:00.000Z");
const team = (id: string) => ({
  id,
  organizationId: "o1",
  name: `Team ${id}`,
  createdAt: at,
  updatedAt: at,
});

describe("the insert of many rows of the Better Auth tables", () => {
  for (const dialect of ["sqlite", "postgres"] as const)
    it(`refuses rows that name other extra columns on ${dialect}`, () => {
      const st = compatStatements(dialect, resolveNames());
      // A later insertExtras that names its column for some rows only.
      map.insertExtras = (row) => (row.id === "t2" ? {} : { memberCount: 0 });
      expect(() => st.insertMany("team", [team("t1"), team("t2")])).toThrow(
        expect.objectContaining({ code: "invalid_argument" }),
      );
      map.insertExtras = extras;
      expect(st.insertMany("team", [team("t1"), team("t2")]).sql).toContain("memberCount");
    });
});
