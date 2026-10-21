import { type ModelName, schema } from "@authtempo/core";
import { columnType } from "@authtempo/core/ddl";
import { POSTGRES } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import { type CoreFieldType, postgresColumnType } from "../src/column-types.js";

describe("the Postgres column map (plan 12g)", () => {
  it("answers the type of core's column map for every field", () => {
    // One field name has one meaning across the schema: a second `counter`
    // that is not int64 would get bigint here, and this test would fail.
    for (const m of Object.keys(schema) as ModelName[])
      for (const [f, def] of Object.entries(
        schema[m].fields as Record<string, { type: CoreFieldType }>,
      ))
        expect(postgresColumnType(f, def.type), `${m}.${f}`).toBe(columnType(POSTGRES, m, f));
  });

  it("gives bigint to the two 64-bit integers and integer to the others", () => {
    expect(postgresColumnType("counter", "integer")).toBe("bigint");
    expect(postgresColumnType("lastStep", "integer")).toBe("bigint");
    expect(postgresColumnType("rank", "integer")).toBe("integer");
    expect(postgresColumnType("secretVersion", "integer")).toBe("integer");
  });
});
