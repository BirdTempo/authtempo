import { env } from "cloudflare:test";
import { SCHEMA_VERSION } from "@authtempo/core";
import { afterEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

async function setVersion(value: string | null): Promise<void> {
  await env.DB.prepare("DELETE FROM ta_meta WHERE key = 'schema_version'").run();
  if (value !== null) {
    await env.DB.prepare("INSERT INTO ta_meta (key, value) VALUES ('schema_version', ?)")
      .bind(value)
      .run();
  }
}

describe("d1 schema version", () => {
  afterEach(() => setVersion(String(SCHEMA_VERSION)));

  it("throws schema_mismatch on the first operation when the version is older (Review Focus 5)", async () => {
    await setVersion("0");
    const db = createD1Adapter(env.DB);
    await expect(db.findMany("user", [])).rejects.toMatchObject({
      name: "StorageError",
      code: "schema_mismatch",
      fields: ["0"],
    });
  });

  it("throws schema_mismatch when the row is missing", async () => {
    await setVersion(null);
    const db = createD1Adapter(env.DB);
    await expect(db.findOne("user", [{ field: "id", op: "eq", value: "x" }])).rejects.toMatchObject(
      {
        code: "schema_mismatch",
        fields: ["none"],
      },
    );
  });

  it("accepts a newer version and checks only once", async () => {
    await setVersion(String(SCHEMA_VERSION + 1));
    const db = createD1Adapter(env.DB);
    await expect(db.findMany("user", [])).resolves.toEqual([]);
    await setVersion("0");
    await expect(db.findMany("user", [])).resolves.toEqual([]);
  });

  it("retries the check on the next call after a failed check", async () => {
    await setVersion("0");
    const db = createD1Adapter(env.DB);
    await expect(db.findMany("user", [])).rejects.toMatchObject({ code: "schema_mismatch" });
    await setVersion(String(SCHEMA_VERSION));
    await expect(db.findMany("user", [])).resolves.toEqual([]);
  });

  it("rejects two concurrent first calls, then recovers on the same adapter", async () => {
    await setVersion("0");
    const db = createD1Adapter(env.DB);
    const results = await Promise.allSettled([db.findMany("user", []), db.findMany("user", [])]);
    for (const r of results) {
      expect(r).toMatchObject({ status: "rejected", reason: { code: "schema_mismatch" } });
    }
    await setVersion(String(SCHEMA_VERSION));
    await expect(db.findMany("user", [])).resolves.toEqual([]);
  });

  it("passes a read error through unchanged, not as schema_mismatch, and retries", async () => {
    const boom = new Error("D1_ERROR: boom");
    let failing = true;
    const wrapped = {
      prepare: (sql: string) => {
        if (failing) throw boom;
        return env.DB.prepare(sql);
      },
      batch: (s: D1PreparedStatement[]) => env.DB.batch(s),
    } as unknown as D1Database;
    const db = createD1Adapter(wrapped);
    const err = await db.findMany("user", []).catch((e: unknown) => e);
    expect(err).toBe(boom);
    failing = false;
    await expect(db.findMany("user", [])).resolves.toEqual([]);
  });

  it("maps a missing ta_meta table to schema_mismatch none", async () => {
    const wrapped = {
      prepare: (sql: string) => env.DB.prepare(sql.replaceAll("ta_meta", "ta_meta_missing")),
    } as unknown as D1Database;
    await expect(createD1Adapter(wrapped).findMany("user", [])).rejects.toMatchObject({
      code: "schema_mismatch",
      fields: ["none"],
    });
  });
});
