import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

describe("schema version 10 on D1 (plan 12a)", () => {
  it("adds ta_session.fresh_at as a nullable integer, and a row that version 9 wrote reads null", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(ta_session)").all<{
      name: string;
      type: string;
      notnull: number;
    }>();
    expect(cols.results.find((c) => c.name === "fresh_at")).toMatchObject({
      type: "INTEGER",
      notnull: 0,
    });
    // A writer of version 9 names no fresh_at.
    await env.DB.prepare(
      "INSERT INTO ta_session (id, created_at, updated_at, user_id, token_hash, expires_at, last_seen_at) VALUES ('s9', 1, 1, 'u9', 'h9', 4102444800000, 1)",
    ).run();
    const db = createD1Adapter(env.DB);
    const row = await db.findOne("session", [{ field: "id", op: "eq", value: "s9" }]);
    expect(row?.freshAt).toBeNull();
    expect(
      await env.DB.prepare("SELECT value FROM ta_meta WHERE key = 'schema_version'").first("value"),
    ).toBe("10");
  });
});
