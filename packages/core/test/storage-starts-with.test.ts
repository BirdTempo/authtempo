import { describe, expect, it } from "vitest";
import { POSTGRES, SQLITE, selectStatement } from "../src/storage/sql.js";

describe("startsWith in the SQL builder (plan 12f)", () => {
  it("writes substr with the count of code points", () => {
    const where = [{ field: "email" as const, op: "startsWith" as const, value: "éa" }];
    const lite = selectStatement(SQLITE, "user", where);
    expect(lite?.sql).toContain(" WHERE substr(email, 1, ?) = ?");
    expect(lite?.params).toEqual([2, "éa"]);
    const pg = selectStatement(POSTGRES, "user", where);
    expect(pg?.sql).toContain(" WHERE substr(email, 1, $1) = $2");
    expect(pg?.params).toEqual([2, "éa"]);
    // One code point outside the BMP is two UTF-16 units: the count is still 1.
    expect(
      selectStatement(SQLITE, "user", [{ field: "email", op: "startsWith", value: "𝔞" }])?.params,
    ).toEqual([1, "𝔞"]);
  });
});
