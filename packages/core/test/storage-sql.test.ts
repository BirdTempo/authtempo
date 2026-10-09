import { describe, expect, it } from "vitest";
import {
  assertFields,
  assertModel,
  columnName,
  columnsOf,
  decodeRow,
  deleteStatement,
  encodeValue,
  fieldName,
  fieldsFromColumns,
  fieldsFromUniqueIndex,
  insertStatement,
  POSTGRES,
  SQLITE,
  selectStatement,
  TABLES,
  uniqueIndexName,
  updateStatement,
} from "../src/storage/sql.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");

describe("names", () => {
  it("maps models to prefixed tables and fields to snake_case", () => {
    expect(TABLES.user).toBe("ta_user");
    expect(TABLES.verification).toBe("ta_verification");
    expect(columnName("tokenHash")).toBe("token_hash");
    expect(columnName("activeOrganizationId")).toBe("active_organization_id");
    expect(columnName("id")).toBe("id");
    expect(fieldName("active_organization_id")).toBe("activeOrganizationId");
    expect(columnsOf("user")).toEqual([
      "id",
      "created_at",
      "updated_at",
      "email",
      "email_verified",
      "name",
      "image",
    ]);
  });
  it("names unique indexes with double underscores and parses them back", () => {
    expect(uniqueIndexName("identity", ["provider", "subject"])).toBe(
      "ux_ta_identity__provider__subject",
    );
    expect(uniqueIndexName("session", ["tokenHash"])).toBe("ux_ta_session__token_hash");
    expect(fieldsFromUniqueIndex("identity", "ux_ta_identity__provider__subject")).toEqual([
      "provider",
      "subject",
    ]);
    expect(fieldsFromUniqueIndex("session", "ux_ta_session__token_hash")).toEqual(["tokenHash"]);
    expect(fieldsFromUniqueIndex("user", "ta_user_pkey")).toEqual(["id"]);
    expect(fieldsFromUniqueIndex("user", "something_else")).toBeNull();
    expect(fieldsFromColumns("user", ["email"])).toEqual(["email"]);
    expect(fieldsFromColumns("identity", ["provider", "subject"])).toEqual(["provider", "subject"]);
  });
  it("rejects unknown models and fields", () => {
    expect(() => assertModel("nope")).toThrow(/unknown_model/);
    expect(() => assertModel("toString")).toThrow(/unknown_model/);
    expect(() => assertFields("user", ["nope"])).toThrow(/unknown_field/);
    expect(() => assertFields("user", ["email"])).not.toThrow();
  });
});

describe("encode and decode", () => {
  it("encodes dates, booleans, and json per dialect", () => {
    expect(encodeValue(SQLITE, "date", t0)).toBe(t0.getTime());
    expect(encodeValue(POSTGRES, "date", t0)).toBe(t0);
    expect(encodeValue(SQLITE, "boolean", true)).toBe(1);
    expect(encodeValue(POSTGRES, "boolean", true)).toBe(true);
    expect(encodeValue(SQLITE, "json", { a: "it's \\ é" })).toBe('{"a":"it\'s \\\\ é"}');
    expect(encodeValue(POSTGRES, "json", { a: 1 })).toBe('{"a":1}');
    expect(encodeValue(SQLITE, "string", "x")).toBe("x");
    expect(encodeValue(SQLITE, "integer", 7)).toBe(7);
    expect(encodeValue(SQLITE, "date", null)).toBeNull();
  });
  it("rejects a value whose type does not match the column (Review Focus 1)", () => {
    expect(() => encodeValue(SQLITE, "date", "2026-01-01")).toThrow(/invalid_argument/);
    expect(() => encodeValue(POSTGRES, "string", 5)).toThrow(/invalid_argument/);
    expect(() => encodeValue(SQLITE, "integer", 1.5)).toThrow(/invalid_argument/);
    expect(() => encodeValue(SQLITE, "boolean", "true")).toThrow(/invalid_argument/);
    expect(() => encodeValue(SQLITE, "date", new Date(Number.NaN))).toThrow(/invalid_argument/);
  });
  it("decodes a sqlite row and a postgres row to the same shape", () => {
    const sqliteRow = {
      id: "v1",
      created_at: t0.getTime(),
      updated_at: t0.getTime(),
      purpose: "magic-link",
      identifier: "a@example.com",
      value_hash: "h",
      expires_at: t0.getTime() + 1,
      consumed_at: null,
      data: '{"next":"/x"}',
    };
    const pgRow = {
      id: "v1",
      created_at: t0,
      updated_at: t0,
      purpose: "magic-link",
      identifier: "a@example.com",
      value_hash: "h",
      expires_at: new Date(t0.getTime() + 1),
      consumed_at: null,
      data: { next: "/x" },
    };
    const a = decodeRow(SQLITE, "verification", sqliteRow);
    const b = decodeRow(POSTGRES, "verification", pgRow);
    expect(a).toEqual(b);
    expect(a.expiresAt.getTime()).toBe(t0.getTime() + 1);
    expect(a.data).toEqual({ next: "/x" });
    const u = decodeRow(SQLITE, "user", {
      id: "u1",
      created_at: 0,
      updated_at: 0,
      email: "a",
      email_verified: 1,
      name: null,
      image: null,
    });
    expect(u.emailVerified).toBe(true);
    expect(u.createdAt).toBeInstanceOf(Date);
  });
});

describe("statements", () => {
  it("builds an insert in schema column order", () => {
    const s = insertStatement(SQLITE, "user", {
      id: "u1",
      email: "a@example.com",
      emailVerified: false,
      name: null,
      image: null,
      createdAt: t0,
      updatedAt: t0,
    });
    expect(s.sql).toBe(
      "INSERT INTO ta_user (id, created_at, updated_at, email, email_verified, name, image) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    expect(s.params).toEqual(["u1", t0.getTime(), t0.getTime(), "a@example.com", 0, null, null]);
    const p = insertStatement(POSTGRES, "verification", {
      id: "v1",
      purpose: "magic-link",
      identifier: "a",
      valueHash: "h",
      expiresAt: t0,
      consumedAt: null,
      data: { n: 1 },
      createdAt: t0,
      updatedAt: t0,
    });
    expect(p.sql).toContain("VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)");
    expect(p.params[8]).toBe('{"n":1}');
  });
  it("builds selects with the null rules and the sort rules", () => {
    const s = selectStatement(
      SQLITE,
      "user",
      [
        { field: "name", op: "eq", value: null },
        { field: "email", op: "ne", value: "x" },
        { field: "id", op: "in", value: ["a", null, "b"] },
        { field: "createdAt", op: "gt", value: t0 },
      ],
      { sort: { field: "createdAt", dir: "asc" }, limit: 2 },
    );
    expect(s?.sql).toBe(
      "SELECT id, created_at, updated_at, email, email_verified, name, image FROM ta_user WHERE name IS NULL AND email <> ? AND id IN (?, ?) AND created_at > ? ORDER BY created_at IS NULL, created_at ASC LIMIT ?",
    );
    expect(s?.params).toEqual(["x", "a", "b", t0.getTime(), 2]);
    const d = selectStatement(SQLITE, "user", [], { sort: { field: "name", dir: "desc" } });
    expect(d?.sql).toContain("ORDER BY name IS NULL DESC, name DESC");
    const p = selectStatement(POSTGRES, "user", [{ field: "name", op: "ne", value: null }], {
      sort: { field: "name", dir: "asc" },
    });
    expect(p?.sql).toBe(
      "SELECT id, created_at, updated_at, email, email_verified, name, image FROM ta_user WHERE name IS NOT NULL ORDER BY name ASC",
    );
    expect(p?.params).toEqual([]);
  });
  it("returns null for a where that can never match", () => {
    expect(selectStatement(SQLITE, "user", [{ field: "id", op: "in", value: [] }])).toBeNull();
    expect(selectStatement(SQLITE, "user", [{ field: "id", op: "in", value: [null] }])).toBeNull();
    expect(
      updateStatement(SQLITE, "user", [{ field: "id", op: "in", value: [] }], { name: "x" }),
    ).toBeNull();
    expect(deleteStatement(SQLITE, "user", [{ field: "id", op: "in", value: [] }])).toBeNull();
  });
  it("validates where, sort, limit, and data before any SQL", () => {
    expect(() =>
      selectStatement(SQLITE, "user", [{ field: "nope" as "id", op: "eq", value: 1 }]),
    ).toThrow(/unknown_field/);
    expect(() =>
      selectStatement(SQLITE, "user", [], { sort: { field: "nope" as "id", dir: "asc" } }),
    ).toThrow(/unknown_field/);
    for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => selectStatement(SQLITE, "user", [], { limit })).toThrow(/invalid_argument/);
    }
    expect(() => selectStatement(SQLITE, "user", [{ field: "id", op: "in", value: "a" }])).toThrow(
      /invalid_argument/,
    );
    expect(() =>
      selectStatement(SQLITE, "user", [{ field: "id", op: "lt", value: null }]),
    ).not.toThrow();
    expect(() => updateStatement(SQLITE, "user", [], { name: "x" })).toThrow(/invalid_argument/);
    expect(() => deleteStatement(SQLITE, "user", [])).toThrow(/invalid_argument/);
    expect(() =>
      updateStatement(SQLITE, "user", [{ field: "id", op: "eq", value: "u1" }], {
        id: "x",
      } as never),
    ).toThrow(/unknown_field/);
    expect(() =>
      updateStatement(SQLITE, "user", [{ field: "id", op: "eq", value: "u1" }], {
        nope: 1,
      } as never),
    ).toThrow(/unknown_field/);
    expect(() => insertStatement(SQLITE, "user", { nope: 1 } as never)).toThrow(/unknown_field/);
  });
  it("builds update and delete", () => {
    const u = updateStatement(
      POSTGRES,
      "verification",
      [
        { field: "valueHash", op: "eq", value: "h" },
        { field: "consumedAt", op: "eq", value: null },
      ],
      { consumedAt: t0, updatedAt: t0 },
    );
    expect(u?.sql).toBe(
      "UPDATE ta_verification SET consumed_at = $1, updated_at = $2 WHERE value_hash = $3 AND consumed_at IS NULL",
    );
    expect(u?.params).toEqual([t0, t0, "h"]);
    const d = deleteStatement(SQLITE, "session", [{ field: "expiresAt", op: "lte", value: t0 }]);
    expect(d?.sql).toBe("DELETE FROM ta_session WHERE expires_at <= ?");
    expect(d?.params).toEqual([t0.getTime()]);
  });
  it("lt lte gt gte against a null value compile to a clause that never matches", () => {
    const s = selectStatement(SQLITE, "verification", [
      { field: "consumedAt", op: "gt", value: null },
    ]);
    expect(s).toBeNull();
  });
});
