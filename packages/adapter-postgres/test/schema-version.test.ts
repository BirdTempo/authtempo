import { SCHEMA_VERSION } from "@authtempo/core";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

describe("postgres schema version", () => {
  it("throws schema_mismatch on the first operation when the version is older (Review Focus 5)", async () => {
    const db = await freshDatabase();
    try {
      await db.sql.unsafe("UPDATE ta_meta SET value = '0' WHERE key = 'schema_version'");
      const adapter = createPostgresAdapter(db.sql);
      await expect(adapter.findMany("user", [])).rejects.toMatchObject({
        code: "schema_mismatch",
        fields: ["0"],
      });
    } finally {
      await db.close();
    }
  });

  it("throws schema_mismatch when the row is missing, and accepts a newer version once", async () => {
    const db = await freshDatabase();
    try {
      await db.sql.unsafe("DELETE FROM ta_meta");
      await expect(createPostgresAdapter(db.sql).findMany("user", [])).rejects.toMatchObject({
        code: "schema_mismatch",
        fields: ["none"],
      });
      await db.sql.unsafe(
        `INSERT INTO ta_meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION + 1}')`,
      );
      const adapter = createPostgresAdapter(db.sql);
      await expect(adapter.findMany("user", [])).resolves.toEqual([]);
      await db.sql.unsafe("UPDATE ta_meta SET value = '0'");
      await expect(adapter.findMany("user", [])).resolves.toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("retries the check on the next call after a failed check", async () => {
    const db = await freshDatabase();
    try {
      await db.sql.unsafe("UPDATE ta_meta SET value = '0' WHERE key = 'schema_version'");
      const adapter = createPostgresAdapter(db.sql);
      await expect(adapter.findMany("user", [])).rejects.toMatchObject({ code: "schema_mismatch" });
      await db.sql.unsafe(
        `UPDATE ta_meta SET value = '${SCHEMA_VERSION}' WHERE key = 'schema_version'`,
      );
      await expect(adapter.findMany("user", [])).resolves.toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("rejects two concurrent first calls, then recovers on the same adapter", async () => {
    const db = await freshDatabase();
    try {
      await db.sql.unsafe("UPDATE ta_meta SET value = '0' WHERE key = 'schema_version'");
      const adapter = createPostgresAdapter(db.sql);
      const results = await Promise.allSettled([
        adapter.findMany("user", []),
        adapter.findMany("user", []),
      ]);
      for (const r of results) {
        expect(r).toMatchObject({ status: "rejected", reason: { code: "schema_mismatch" } });
      }
      await db.sql.unsafe(
        `UPDATE ta_meta SET value = '${SCHEMA_VERSION}' WHERE key = 'schema_version'`,
      );
      await expect(adapter.findMany("user", [])).resolves.toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("passes a read error through unchanged, not as schema_mismatch", async () => {
    const boom = new Error("connection reset");
    const sql = {
      unsafe: () => {
        throw boom;
      },
    } as unknown as Sql;
    const err = await createPostgresAdapter(sql)
      .findMany("user", [])
      .catch((e: unknown) => e);
    expect(err).toBe(boom);
  });

  it("maps an undefined ta_meta table (42P01) to schema_mismatch none", async () => {
    const db = await freshDatabase();
    try {
      await db.sql.unsafe("DROP TABLE ta_meta");
      await expect(createPostgresAdapter(db.sql).findMany("user", [])).rejects.toMatchObject({
        code: "schema_mismatch",
        fields: ["none"],
      });
    } finally {
      await db.close();
    }
  });
});
