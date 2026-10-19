import { type ModelName, schema } from "@authtempo/core";
import { runAdapterConformance } from "@authtempo/core/conformance";
import { columnsOf, TABLES } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import { createPostgresAdapter, expectedPostgresShape, readPostgresShape } from "../src/index.js";
import { freshDatabase } from "./db.js";

runAdapterConformance("postgres", async () => {
  const db = await freshDatabase();
  return { adapter: createPostgresAdapter(db.sql), close: () => db.close() };
});

describe("postgres migration matches the core schema", () => {
  it("the fresh database has the shape of expectedPostgresShape()", async () => {
    const db = await freshDatabase();
    try {
      const live = await readPostgresShape(db.sql);
      // The expected shape holds no default, so compare the live shape without it.
      const withoutDefault = live.map((t) => ({
        ...t,
        columns: t.columns.map((c) => ({ name: c.name, type: c.type, notNull: c.notNull })),
      }));
      expect(withoutDefault).toEqual(expectedPostgresShape());
    } finally {
      await db.close();
    }
  });

  it("lists the columns of each model in the order of schema", () => {
    const shape = expectedPostgresShape();
    for (const model of Object.keys(schema) as ModelName[]) {
      const table = shape.find((t) => t.name === TABLES[model]);
      expect({ model, columns: table?.columns.map((c) => c.name) }).toEqual({
        model,
        columns: columnsOf(model),
      });
    }
  });

  it("reads an extra column with its default", async () => {
    const db = await freshDatabase();
    try {
      await db.sql.unsafe("ALTER TABLE ta_user ADD COLUMN nickname text DEFAULT 'x'");
      const user = (await readPostgresShape(db.sql)).find((t) => t.name === "ta_user");
      expect(user?.columns.find((c) => c.name === "nickname")).toEqual({
        name: "nickname",
        type: "text",
        notNull: false,
        hasDefault: true,
      });
      expect(user?.columns.find((c) => c.name === "email")).toEqual({
        name: "email",
        type: "text",
        notNull: true,
        hasDefault: false,
      });
    } finally {
      await db.close();
    }
  });

  it("stores a passkey counter above 2^31 - 1 and reads it back as a number", async () => {
    const db = await freshDatabase();
    try {
      const adapter = createPostgresAdapter(db.sql);
      const t0 = new Date("2026-01-01T00:00:00.000Z");
      await adapter.create("passkey", {
        id: "k1",
        userId: "u1",
        credentialId: "c1",
        publicKey: "pk",
        counter: 4_294_967_295,
        transports: null,
        deviceType: "multiDevice",
        backedUp: true,
        name: null,
        createdAt: t0,
        updatedAt: t0,
      });
      const row = await adapter.findOne("passkey", [{ field: "id", op: "eq", value: "k1" }]);
      expect(row?.counter).toBe(4_294_967_295);
    } finally {
      await db.close();
    }
  });

  it("applies migrations once", async () => {
    const db = await freshDatabase();
    try {
      const { applyPostgresMigrations } = await import("../src/migrations.js");
      expect(await applyPostgresMigrations(db.sql)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
