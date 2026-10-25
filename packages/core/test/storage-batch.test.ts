import { describe, expect, it } from "vitest";
import { findManyIn, IN_CHUNK } from "../src/storage/batch.js";
import { createMemoryAdapter } from "../src/storage/memory.js";

describe("findManyIn", () => {
  it("reads a list longer than one chunk, once per value, with extra where clauses", async () => {
    const db = createMemoryAdapter();
    const at = new Date("2026-01-01T00:00:00.000Z");
    const ids: string[] = [];
    for (let i = 0; i < IN_CHUNK * 2 + 3; i++) {
      const id = `u${String(i).padStart(3, "0")}`;
      ids.push(id);
      await db.create("user", {
        id,
        email: `${id}@example.com`,
        emailVerified: i % 2 === 0,
        name: null,
        image: null,
        bannedAt: null,
        banReason: null,
        banUntil: null,
        username: null,
        displayUsername: null,
        phone: null,
        isAnonymous: false,
        createdAt: at,
        updatedAt: at,
      });
    }
    const calls: number[] = [];
    const counting = {
      ...db,
      findMany: ((m, w, o) => {
        const inClause = w.find((c) => c.op === "in");
        calls.push((inClause?.value as unknown[] | undefined)?.length ?? -1);
        return db.findMany(m, w, o);
      }) as typeof db.findMany,
    };
    const rows = await findManyIn(
      counting,
      "user",
      "id",
      [...ids, ...ids],
      [{ field: "emailVerified", op: "eq", value: true }],
    );
    expect(rows).toHaveLength(Math.ceil(ids.length / 2));
    expect(calls).toEqual([IN_CHUNK, IN_CHUNK, 3]);
    expect(await findManyIn(db, "user", "id", [])).toEqual([]);
  });

  it("refuses an in clause in the caller's where", async () => {
    const db = createMemoryAdapter();
    await expect(
      findManyIn(
        db,
        "user",
        "id",
        ["u1"],
        [{ field: "email", op: "in", value: ["a@example.com"] }],
      ),
    ).rejects.toMatchObject({ code: "invalid_argument", model: "user", fields: ["where"] });
  });
});
