import { describe, expect, it } from "vitest";
import { type FieldType, type ModelName, type Models, schema } from "../src/schema.js";
import type { Sort, Where } from "../src/storage/port.js";
import {
  columnName,
  coreStatements,
  type Dialect,
  decodeRow,
  deleteStatement,
  encodeValue,
  insertStatement,
  MYSQL,
  POSTGRES,
  SQLITE,
  type Statement,
  selectStatement,
  TABLES,
  updateStatement,
} from "../src/storage/sql.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");
const MODELS = Object.keys(schema) as ModelName[];

function fieldsOf(model: ModelName): [string, FieldType][] {
  return Object.entries(schema[model].fields as Record<string, { type: FieldType }>).map(
    ([f, def]) => [f, def.type],
  );
}

/** One value of each field type that every dialect accepts. */
function sample(type: FieldType, field: string): unknown {
  switch (type) {
    case "string":
      return `s-${field}`;
    case "boolean":
      return true;
    case "integer":
      return 7;
    case "date":
      return t0;
    case "json":
      return { a: 1 };
  }
}

/** A full row of `model`, as the engine writes it. */
function row<M extends ModelName>(model: M): Models[M] {
  return Object.fromEntries(
    fieldsOf(model).map(([f, type]) => [f, f === "id" ? "id-1" : sample(type, f)]),
  ) as unknown as Models[M];
}

/** The raw row that a database answers for `row(model)`, keyed by column. */
function rawRow(d: Dialect, model: ModelName): Record<string, unknown> {
  return Object.fromEntries(
    fieldsOf(model).map(([f, type]) => [
      columnName(f),
      encodeValue(d, type, f === "id" ? "id-1" : sample(type, f), model, f),
    ]),
  );
}

/** Every field but `id`: an update writes them all, json included. */
function updateData<M extends ModelName>(model: M): Partial<Omit<Models[M], "id">> {
  const { id: _, ...rest } = row(model) as unknown as Record<string, unknown>;
  return rest as Partial<Omit<Models[M], "id">>;
}

/** Each statement that core builds for `model` on `d`. */
function statementsOf(d: Dialect, model: ModelName): Record<string, Statement | null> {
  const s = coreStatements(d);
  const where = [
    { field: "id", op: "in", value: ["id-1", "id-2"] },
    { field: "id", op: "startsWith", value: "id-" },
  ] as Where<ModelName>[];
  const byId = [{ field: "id", op: "eq", value: "id-1" }] as Where<ModelName>[];
  const sortField = fieldsOf(model)[1]?.[0] ?? "id";
  return {
    insert: insertStatement(d, model, row(model)),
    select: selectStatement(d, model, where, {
      sort: [
        { field: sortField, dir: "desc" },
        { field: "id", dir: "asc" },
      ] as Sort<ModelName>[],
      limit: 5,
    }),
    update: updateStatement(d, model, byId, updateData(model)),
    delete: deleteStatement(d, model, where),
    undoSelect: s.undoSelect(model, byId),
    undoCreate: s.undoCreate(model, row(model)),
    restoreRow: s.restoreRow(model, rawRow(d, model), updateData(model)),
    reinsertRow: s.reinsertRow(model, rawRow(d, model)),
    deleteReturning: s.deleteReturning(model, byId),
  };
}

function allStatements(d: Dialect): Record<string, Statement | null> {
  const out: Record<string, Statement | null> = {};
  for (const m of MODELS)
    for (const [kind, st] of Object.entries(statementsOf(d, m))) out[`${m}.${kind}`] = st;
  return out;
}

/** Every table name and every column name of the schema. */
const IDENTIFIERS = new Set([
  ...Object.values(TABLES),
  ...MODELS.flatMap((m) => fieldsOf(m).map(([f]) => columnName(f))),
]);

describe("the dialects (plan 12g)", () => {
  it("keeps the SQLite and Postgres strings of every statement", () => {
    // The snapshot was written on the code before plan 12g, so the D1 and
    // Postgres text and parameters stay the same byte for byte.
    expect(allStatements(SQLITE)).toMatchSnapshot();
    expect(allStatements(POSTGRES)).toMatchSnapshot();
  });

  it("quotes every identifier on MySQL", () => {
    for (const [name, st] of Object.entries(allStatements(MYSQL))) {
      if (st === null) throw new Error(`${name} built no statement`);
      // What stays after each quoted name goes holds no bare table or column name.
      const bare = st.sql
        .replace(/`[^`]*`/g, " ")
        .split(/[^A-Za-z0-9_]+/)
        .filter((w) => IDENTIFIERS.has(w));
      expect(bare, name).toEqual([]);
      // A delete names no column but `id`, so only the other statements hold the two words.
      const lists = !/\.(delete|undoCreate)$/.test(name);
      if (lists && name.startsWith("oauthDevice.")) expect(st.sql, name).toContain("`interval`");
      if (lists && name.startsWith("organizationRole.")) expect(st.sql, name).toContain("`rank`");
      expect(st.sql, name).not.toContain("`key`");
    }
  });

  it("inlines the limit on MySQL after the integer check", () => {
    const s = selectStatement(MYSQL, "user", [], { limit: 5 });
    expect(s?.sql.endsWith(" LIMIT 5")).toBe(true);
    expect(s?.params).toEqual([]);
    expect(() => selectStatement(MYSQL, "user", [], { limit: 1.5 })).toThrow(/invalid_argument/);
    expect(() => selectStatement(MYSQL, "user", [], { limit: -1 })).toThrow(/invalid_argument/);
  });

  it("encodes MySQL dates and booleans as integers", () => {
    expect(encodeValue(MYSQL, "date", t0)).toBe(1767225600000);
    expect(encodeValue(MYSQL, "boolean", true)).toBe(1);
    expect(encodeValue(MYSQL, "boolean", false)).toBe(0);
    expect(encodeValue(MYSQL, "json", { a: [1, "b"] })).toBe('{"a":[1,"b"]}');
  });

  it("decodes a string of digits as a number on every dialect", () => {
    for (const d of [SQLITE, POSTGRES, MYSQL]) {
      const u = decodeRow(d, "user", {
        id: "u1",
        created_at: "1767225600000",
        updated_at: 1767225600000,
        email: "a@example.com",
        email_verified: 0,
      });
      expect(u.createdAt.getTime(), d.name).toBe(1767225600000);
      expect(u.updatedAt.getTime(), d.name).toBe(1767225600000);
      const p = decodeRow(d, "passkey", { id: "p1", counter: "42" });
      expect(p.counter, d.name).toBe(42);
    }
  });

  it("decodes MySQL json as an object or as text", () => {
    const data = { next: "/home", n: 1 };
    const parsed = decodeRow(MYSQL, "verification", { id: "v1", data });
    expect(parsed.data).toBe(data);
    const text = decodeRow(MYSQL, "verification", { id: "v1", data: '{"next":"/home","n":1}' });
    expect(text.data).toEqual(data);
  });

  it("restores each column with <=> on MySQL", () => {
    const s = coreStatements(MYSQL).restoreRow(
      "user",
      { id: "u1", name: null, email_verified: 0 },
      { name: "x", emailVerified: true },
    );
    expect(s.sql).toContain("`name` <=> ?");
    expect(s.sql).toContain("`email_verified` <=> ?");
    expect(s.sql).not.toContain("IS NOT DISTINCT FROM");
    expect(s.sql.endsWith("WHERE `id` = ?")).toBe(true);
  });
});
