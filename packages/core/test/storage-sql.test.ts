import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, schema } from "../src/schema.js";
import { StorageError } from "../src/storage/port.js";
import {
  assertFields,
  assertModel,
  columnName,
  columnsOf,
  coreStatements,
  decodeRow,
  deleteStatement,
  encodeValue,
  fieldName,
  fieldsFromColumns,
  fieldsFromUniqueIndex,
  insertStatement,
  POSTGRES,
  SQLITE,
  schemaVersionGate,
  selectStatement,
  TABLES,
  USER_CHILD_MODELS,
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

  it("names a camel-case model's table in snake case (plan 8b)", () => {
    expect(TABLES.apiToken).toBe("ta_api_token");
    expect(uniqueIndexName("apiToken", ["tokenHash"])).toBe("ux_ta_api_token__token_hash");
    expect(fieldsFromUniqueIndex("apiToken", "ta_api_token_pkey")).toEqual(["id"]);
    expect(fieldsFromUniqueIndex("apiToken", "ux_ta_api_token__token_hash")).toEqual(["tokenHash"]);
    // The earlier names do not change.
    expect(Object.values(TABLES).slice(0, 9)).toEqual([
      "ta_user",
      "ta_identity",
      "ta_session",
      "ta_verification",
      "ta_passkey",
      "ta_organization",
      "ta_member",
      "ta_invitation",
      "ta_password",
    ]);
  });
  it("names the two version 6 tables in snake case (plan 9f)", () => {
    expect(TABLES.totp).toBe("ta_totp");
    expect(TABLES.trustedDevice).toBe("ta_trusted_device");
    expect(uniqueIndexName("totp", ["userId"])).toBe("ux_ta_totp__user_id");
    expect(fieldsFromUniqueIndex("trustedDevice", "ux_ta_trusted_device__token_hash")).toEqual([
      "tokenHash",
    ]);
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
    expect(p.sql).toContain("VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb)");
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

describe("review fixes", () => {
  it("validates every clause before it reports a where that never matches", () => {
    const bad = { field: "createdAt", op: "eq", value: "str" } as const;
    const empty = { field: "id", op: "in", value: [] } as const;
    expect(() => selectStatement(SQLITE, "user", [empty, bad])).toThrow(/invalid_argument/);
    expect(() => selectStatement(SQLITE, "user", [bad, empty])).toThrow(/invalid_argument/);
    const nullCmp = { field: "createdAt", op: "gt", value: null } as const;
    expect(() => deleteStatement(SQLITE, "user", [nullCmp, bad])).toThrow(/invalid_argument/);
    expect(() =>
      selectStatement(SQLITE, "user", [empty, { field: "id", op: "in", value: "a" }]),
    ).toThrow(/invalid_argument/);
  });
  it("decodes by dialect: jsonb stays as the driver gives it", () => {
    const row = {
      id: "v1",
      created_at: t0,
      updated_at: t0,
      purpose: "p",
      identifier: "i",
      value_hash: "h",
      expires_at: t0,
      consumed_at: null,
      data: "abc",
    };
    expect(decodeRow(POSTGRES, "verification", row).data).toBe("abc");
    expect(decodeRow(SQLITE, "verification", { ...row, data: '"abc"' }).data).toBe("abc");
  });
  it("decodes a postgres integer string and an ISO date string", () => {
    const pk = decodeRow(POSTGRES, "passkey", {
      id: "k1",
      created_at: t0,
      updated_at: t0,
      user_id: "u",
      credential_id: "c",
      public_key: "k",
      counter: "7",
      transports: null,
      device_type: "d",
      backed_up: false,
      name: null,
    });
    expect(pk.counter).toBe(7);
    const v = decodeRow(POSTGRES, "verification", {
      id: "v1",
      created_at: t0.toISOString(),
      updated_at: t0,
      purpose: "p",
      identifier: "i",
      value_hash: "h",
      expires_at: t0,
      consumed_at: null,
      data: null,
    });
    expect(v.createdAt.getTime()).toBe(t0.getTime());
  });
  it("round-trips names and unique index names for the real schema", () => {
    for (const model of Object.keys(schema) as (keyof typeof schema)[]) {
      for (const field of Object.keys(schema[model].fields)) {
        expect(fieldName(columnName(field))).toBe(field);
      }
      for (const key of schema[model].unique) {
        const name = uniqueIndexName(model, key);
        expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(63);
        expect(fieldsFromUniqueIndex(model, name)).toEqual([...key]);
      }
    }
  });
  it("rejects a json value whose text holds a NUL escape", () => {
    expect(() => encodeValue(POSTGRES, "json", { a: "x\u0000y" })).toThrow(/invalid_argument/);
    expect(() => encodeValue(SQLITE, "json", { a: "x\u0000y" })).toThrow(/invalid_argument/);
    expect(encodeValue(POSTGRES, "json", { a: "x\\u0000y" })).toBe('{"a":"x\\\\u0000y"}');
  });
});

describe("final review fixes", () => {
  it("casts a json parameter through text on postgres, for insert and update", () => {
    const u = updateStatement(POSTGRES, "verification", [{ field: "id", op: "eq", value: "v1" }], {
      data: { a: 1 },
    });
    expect(u?.sql).toBe("UPDATE ta_verification SET data = $1::text::jsonb WHERE id = $2");
    expect(u?.params).toEqual(['{"a":1}', "v1"]);
    const s = updateStatement(SQLITE, "verification", [{ field: "id", op: "eq", value: "v1" }], {
      data: { a: 1 },
    });
    expect(s?.sql).toBe("UPDATE ta_verification SET data = ? WHERE id = ?");
  });
  it("rejects a where clause on a json field on both dialects", () => {
    for (const d of [SQLITE, POSTGRES]) {
      expect(() =>
        selectStatement(d, "verification", [{ field: "data", op: "eq", value: { a: 1 } }]),
      ).toThrow(/invalid_argument/);
      expect(() =>
        selectStatement(d, "verification", [{ field: "data", op: "eq", value: null }]),
      ).toThrow(/invalid_argument/);
      expect(() =>
        deleteStatement(d, "verification", [{ field: "data", op: "in", value: [] }]),
      ).toThrow(/invalid_argument/);
    }
  });
  it("accepts only plain objects and arrays as json", () => {
    class Box {
      a = 1;
    }
    for (const d of [SQLITE, POSTGRES]) {
      for (const bad of [new Date(0), new Map([["a", 1]]), new Box(), "text", 5, true]) {
        expect(() => encodeValue(d, "json", bad)).toThrow(/invalid_argument/);
      }
      expect(encodeValue(d, "json", [1, { z: null }])).toBe('[1,{"z":null}]');
      expect(encodeValue(d, "json", Object.assign(Object.create(null), { a: 1 }))).toBe('{"a":1}');
    }
  });
  it("rejects a string that holds U+0000 on both dialects", () => {
    for (const d of [SQLITE, POSTGRES]) {
      expect(() => encodeValue(d, "string", "a\u0000b")).toThrow(/invalid_argument/);
      expect(encodeValue(d, "string", "a\\u0000b")).toBe("a\\u0000b");
      expect(() =>
        insertStatement(d, "user", {
          id: "u1",
          email: "a\u0000@example.com",
          emailVerified: false,
          name: null,
          image: null,
          createdAt: t0,
          updatedAt: t0,
        }),
      ).toThrow(/invalid_argument/);
    }
  });
});

describe("schemaVersionGate", () => {
  function fake(values: (string | null | Error)[]) {
    let calls = 0;
    const read = async () => {
      const v = values[Math.min(calls, values.length - 1)];
      calls++;
      if (v instanceof Error) throw v;
      return v ?? null;
    };
    return { read, calls: () => calls };
  }

  it("reads once and accepts the current and a newer version", async () => {
    for (const v of [String(SCHEMA_VERSION), String(SCHEMA_VERSION + 1)]) {
      const f = fake([v]);
      const gate = schemaVersionGate(f.read);
      await gate();
      await gate();
      await Promise.all([gate(), gate()]);
      expect(f.calls()).toBe(1);
    }
  });

  it("throws schema_mismatch for an older, missing, or non-integer version", async () => {
    for (const [v, field] of [
      ["0", "0"],
      [null, "none"],
      ["abc", "abc"],
      ["1.5", "1.5"],
    ] as const) {
      const gate = schemaVersionGate(fake([v]).read);
      const err = await gate().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StorageError);
      expect(err).toMatchObject({ code: "schema_mismatch", model: "meta", fields: [field] });
    }
  });

  it("resets after a failure, so the next call reads again", async () => {
    const f = fake(["0", String(SCHEMA_VERSION)]);
    const gate = schemaVersionGate(f.read);
    await expect(gate()).rejects.toMatchObject({ code: "schema_mismatch" });
    await expect(gate()).resolves.toBeUndefined();
    await gate();
    expect(f.calls()).toBe(2);
  });

  it("rethrows an error from read unchanged and retries on the next call", async () => {
    const boom = new Error("D1_ERROR: boom");
    const f = fake([boom, String(SCHEMA_VERSION)]);
    const gate = schemaVersionGate(f.read);
    const err = await gate().catch((e: unknown) => e);
    expect(err).toBe(boom);
    await expect(gate()).resolves.toBeUndefined();
    expect(f.calls()).toBe(2);
  });

  it("resets when read throws before it returns a promise", async () => {
    const boom = new Error("sync");
    let calls = 0;
    const gate = schemaVersionGate(() => {
      calls++;
      if (calls === 1) throw boom;
      return Promise.resolve(String(SCHEMA_VERSION));
    });
    await expect(gate()).rejects.toBe(boom);
    await expect(gate()).resolves.toBeUndefined();
  });
});

describe("the D1 undo of a user create (plan 8b)", () => {
  const user = (emailVerified: boolean) => ({
    id: "u1",
    email: "a@example.com",
    emailVerified,
    name: null,
    image: null,
    createdAt: t0,
    updatedAt: t0,
  });
  const children =
    " AND NOT EXISTS (SELECT 1 FROM ta_identity WHERE user_id = ?)" +
    " AND NOT EXISTS (SELECT 1 FROM ta_session WHERE user_id = ?)" +
    " AND NOT EXISTS (SELECT 1 FROM ta_passkey WHERE user_id = ?)" +
    " AND NOT EXISTS (SELECT 1 FROM ta_member WHERE user_id = ?)" +
    " AND NOT EXISTS (SELECT 1 FROM ta_password WHERE user_id = ?)" +
    " AND NOT EXISTS (SELECT 1 FROM ta_api_token WHERE user_id = ?)" +
    " AND NOT EXISTS (SELECT 1 FROM ta_totp WHERE user_id = ?)" +
    " AND NOT EXISTS (SELECT 1 FROM ta_trusted_device WHERE user_id = ?)";

  it("lists every model with a userId field as a child, from the schema", () => {
    expect(USER_CHILD_MODELS).toEqual([
      "identity",
      "session",
      "passkey",
      "member",
      "password",
      "apiToken",
      "totp",
      "trustedDevice",
    ]);
  });

  it("deletes a created user only while no child row names it, verified or not", () => {
    const st = coreStatements(SQLITE);
    expect(st.undoCreate("user", user(true))).toEqual({
      sql: `DELETE FROM ta_user WHERE id = ?${children}`,
      params: ["u1", "u1", "u1", "u1", "u1", "u1", "u1", "u1", "u1"],
    });
    expect(st.undoCreate("user", user(false))).toEqual({
      sql: `DELETE FROM ta_user WHERE id = ? AND email_verified = ?${children}`,
      params: ["u1", 0, "u1", "u1", "u1", "u1", "u1", "u1", "u1", "u1"],
    });
  });

  it("numbers the Postgres placeholders after the where", () => {
    const s = coreStatements(POSTGRES).undoCreate("user", user(true));
    expect(s.sql.endsWith("FROM ta_trusted_device WHERE user_id = $9)")).toBe(true);
    expect(s.params).toHaveLength(9);
  });

  it("keeps the undo of any other model a delete by id", () => {
    const s = coreStatements(SQLITE).undoCreate("session", {
      id: "s1",
      userId: "u1",
      tokenHash: "h",
      expiresAt: t0,
      lastSeenAt: t0,
      ip: null,
      userAgent: null,
      activeOrganizationId: null,
      createdAt: t0,
      updatedAt: t0,
    });
    expect(s).toEqual({ sql: "DELETE FROM ta_session WHERE id = ?", params: ["s1"] });
  });
});
