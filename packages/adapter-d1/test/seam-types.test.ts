import { env } from "cloudflare:test";
import { coreStatements, SQLITE } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import {
  createD1AdapterOn,
  type D1Subset,
  schemaVersionCheckOn,
  toStorageError,
} from "../src/seam-entry.js";

describe("the seam of plan 12g", () => {
  it("a D1 binding satisfies D1Subset", async () => {
    // The assignment is the type check: tsconfig.test.json fails it when the
    // binding's types no longer satisfy the seam.
    const s: D1Subset = env.DB;
    const sent = { statements: 0, ready: 0 };
    const db = createD1AdapterOn(s, {
      statements: coreStatements(SQLITE),
      toStorageError,
      ready: schemaVersionCheckOn(s, sent),
      sent,
    });
    expect(await db.findOne("user", [{ field: "id", op: "eq", value: "no-such-user" }])).toBeNull();
    expect(await db.readyStatements?.()).toBe(1);
  });
});
