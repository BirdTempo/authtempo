import { describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations.js";
import { freshSchema } from "./db.js";

describe("schema version 10 on Postgres (plan 12a)", () => {
  it("adds ta_session.fresh_at as a nullable timestamptz, and a row of version 9 reads null", async () => {
    const { a, close } = await freshSchema();
    try {
      // 0010 by its name: later migrations follow it (0011 since plan 12e).
      const i0010 = MIGRATIONS.findIndex((m) => m.name === "0010_schema_v10");
      expect(i0010).toBe(9);
      const last = MIGRATIONS[i0010];
      for (const m of MIGRATIONS.slice(0, i0010)) await a.unsafe(m.sql);
      // A writer of version 9 names no fresh_at.
      await a.unsafe(
        "INSERT INTO ta_session (id, created_at, updated_at, user_id, token_hash, expires_at, last_seen_at) VALUES ('s9', now(), now(), 'u9', 'h9', now() + interval '1 day', now())",
      );
      if (last) await a.unsafe(last.sql);
      const cols = await a.unsafe<{ is_nullable: string; data_type: string }[]>(
        "SELECT is_nullable, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ta_session' AND column_name = 'fresh_at'",
      );
      expect([...cols]).toEqual([{ is_nullable: "YES", data_type: "timestamp with time zone" }]);
      // The adapter reads only a database of the current version: apply the later migrations first.
      for (const m of MIGRATIONS.slice(i0010 + 1)) await a.unsafe(m.sql);
      const db = createPostgresAdapter(a);
      const row = await db.findOne("session", [{ field: "id", op: "eq", value: "s9" }]);
      expect(row?.freshAt).toBeNull();
    } finally {
      await close();
    }
  });
});
