import { type ModelName, schema } from "@authtempo/core";
import { runAdapterConformance } from "@authtempo/core/conformance";
import { columnName, columnsOf, TABLES, uniqueIndexName } from "@authtempo/core/sql";
import { describe, expect, it } from "vitest";
import { type CoreFieldType, createPostgresAdapter, postgresColumnType } from "../src/index.js";
import { freshDatabase } from "./db.js";

runAdapterConformance("postgres", async () => {
  const db = await freshDatabase();
  return { adapter: createPostgresAdapter(db.sql), close: () => db.close() };
});

interface IndexShape {
  name: string;
  unique: boolean;
  columns: string;
}

function expectedIndexes(model: ModelName): IndexShape[] {
  const table = TABLES[model];
  const cols = (fields: readonly string[]) => fields.map(columnName);
  return [
    ...schema[model].unique.map((f) => ({
      name: uniqueIndexName(model, f),
      unique: true,
      columns: cols(f).join(", "),
    })),
    ...schema[model].indexes.map((f) => ({
      name: `ix_${table}__${cols(f).join("__")}`,
      unique: false,
      columns: cols(f).join(", "),
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

describe("postgres migration matches the core schema", () => {
  it("has every table with the columns core expects, in order", async () => {
    const db = await freshDatabase();
    try {
      for (const [model, table] of Object.entries(TABLES)) {
        const cols = await db.sql.unsafe<{ column_name: string }[]>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position",
          [table],
        );
        expect(cols.map((c) => c.column_name)).toEqual(columnsOf(model as ModelName));
      }
    } finally {
      await db.close();
    }
  });

  it("matches schema in NOT NULL and in column type", async () => {
    const db = await freshDatabase();
    try {
      for (const model of Object.keys(schema) as ModelName[]) {
        const cols = await db.sql.unsafe<
          { column_name: string; is_nullable: string; data_type: string }[]
        >(
          "SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1",
          [TABLES[model]],
        );
        const actual = Object.fromEntries(
          cols.map((c) => [c.column_name, `${c.data_type} ${c.is_nullable}`]),
        );
        const fields = schema[model].fields as Record<
          string,
          { type: CoreFieldType; nullable?: boolean }
        >;
        const expected = Object.fromEntries(
          Object.entries(fields).map(([f, def]) => [
            columnName(f),
            `${postgresColumnType(f, def.type)} ${def.nullable ? "YES" : "NO"}`,
          ]),
        );
        expect({ model, columns: actual }).toEqual({ model, columns: expected });
      }
    } finally {
      await db.close();
    }
  });

  it("has every unique index and index that schema lists, with core's names and column order", async () => {
    const db = await freshDatabase();
    try {
      for (const model of Object.keys(schema) as ModelName[]) {
        const rows = await db.sql.unsafe<{ indexname: string; indexdef: string }[]>(
          "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 AND indexname <> $2",
          [TABLES[model], `${TABLES[model]}_pkey`],
        );
        const actual = rows
          .map((r) => ({
            name: r.indexname,
            unique: r.indexdef.includes("CREATE UNIQUE INDEX"),
            columns: /\(([^)]*)\)$/.exec(r.indexdef)?.[1] ?? r.indexdef,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        expect({ model, indexes: actual }).toEqual({ model, indexes: expectedIndexes(model) });
      }
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
