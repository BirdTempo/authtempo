import { describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");

const user = (id: string, email: string) => ({
  id,
  email,
  emailVerified: false,
  name: null,
  image: null,
  createdAt: t0,
  updatedAt: t0,
});

describe("postgres nested transaction", () => {
  it("rolls back only the savepoint when the outer function catches the inner throw", async () => {
    const pg = await freshDatabase();
    try {
      const db = createPostgresAdapter(pg.sql);
      await db.transaction(async (tx) => {
        await tx.create("user", user("u1", "a@example.com"));
        await tx
          .transaction(async (inner) => {
            await inner.create("user", user("u2", "b@example.com"));
            throw new Error("inner");
          })
          .catch(() => {});
      });
      const rows = await db.findMany("user", []);
      expect(rows.map((r) => r.id)).toEqual(["u1"]);
    } finally {
      await pg.close();
    }
  });
});
