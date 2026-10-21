import { type ModelName, schema } from "@authtempo/core";
import { columnType } from "@authtempo/core/ddl";
import { SQLITE } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import { d1ColumnType } from "../src/shape.js";

type CoreFieldType = Parameters<typeof d1ColumnType>[0];

describe("the D1 column map (plan 12g)", () => {
  it("answers the type of core's column map for every field", () => {
    for (const m of Object.keys(schema) as ModelName[])
      for (const [f, def] of Object.entries(
        schema[m].fields as Record<string, { type: CoreFieldType }>,
      ))
        expect(columnType(SQLITE, m, f), `${m}.${f}`).toBe(d1ColumnType(def.type));
  });
});
