import { describe, expect, it } from "vitest";
import {
  deleteStatement,
  fixedChunks,
  insertManyStatement,
  MYSQL,
  POSTGRES,
  selectStatement,
  updateStatement,
} from "../src/storage/sql.js";
import { LONG_TEST_MS } from "./helpers.js";

// MySQL keeps one server prepared statement per SQL text (ruling 85 of plan 12d, MA-3 of
// the review). The server holds at most 16382 of them for all clients. A statement
// kind must have few texts over every list size and every insert size of the engine.

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
const at = new Date("2026-10-24T00:00:00.000Z");

describe("the SQL texts of MySQL over the list and insert sizes", () => {
  // It builds 2000 lists for each statement kind. It took 0.90 s alone at load 12.7 (2026-10-31).
  // It passed in 19 of the 20 evidence runs of 2026-10-30 to 2026-11-03, in up to 4.91 s, at
  // sampled peak load 36 to 56. In that time it timed out at the default 5 s in 7 runs, at 5.30
  // to 6.88 s. The last was the release rehearsal of 2026-11-03 (plan 12m).
  it("binds an in list of 1 to 2000 values in 56 texts per statement kind, padded by the last value", {
    timeout: LONG_TEST_MS,
  }, () => {
    const texts = {
      select: new Set<string>(),
      update: new Set<string>(),
      delete: new Set<string>(),
    };
    for (let n = 1; n <= 2000; n++) {
      const where = [{ field: "id" as const, op: "in" as const, value: ids(n) }];
      const select = selectStatement(MYSQL, "member", where);
      const update = updateStatement(MYSQL, "member", where, { role: "admin" });
      const del = deleteStatement(MYSQL, "member", where);
      if (!select || !update || !del) throw new Error("no statement");
      texts.select.add(select.sql);
      texts.update.add(update.sql);
      texts.delete.add(del.sql);
      // Each value once, in order, then the last value again up to the size.
      const size = select.params.length;
      expect(select.params.slice(0, n)).toEqual(ids(n));
      expect(new Set(select.params.slice(n))).toEqual(new Set(n === size ? [] : [`id-${n - 1}`]));
      expect(del.params).toEqual(select.params);
    }
    expect([texts.select.size, texts.update.size, texts.delete.size]).toEqual([56, 56, 56]);
    // Postgres does not prepare a statement of sql.unsafe, so it keeps one text per size.
    const pg = new Set<string>();
    for (let n = 1; n <= 2000; n++)
      pg.add(
        selectStatement(POSTGRES, "member", [{ field: "id", op: "in", value: ids(n) }])?.sql ?? "",
      );
    expect(pg.size).toBe(2000);
  });

  it("inserts 1 to 1000 rows in 55 texts, each row once and in order", () => {
    const sizes = new Set<number>();
    for (let n = 1; n <= 1000; n++) {
      const parts = fixedChunks(n, 1000);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(n);
      for (const size of parts) sizes.add(size);
    }
    const texts = new Set<string>();
    for (const size of sizes) {
      const rows = ids(size).map((id) => ({
        id,
        groupId: "g1",
        scimUserId: `su-${id}`,
        createdAt: at,
        updatedAt: at,
      }));
      texts.add(insertManyStatement(MYSQL, "scimGroupMember", rows).sql);
    }
    expect(texts.size).toBe(55);
    expect(fixedChunks(999, 1000)).toEqual([512, 256, 128, 64, 39]);
    expect(fixedChunks(1001, 1000)).toEqual([1000, 1]);
    expect(fixedChunks(63, 1000)).toEqual([50, 13]);
  });
});
