import { env } from "cloudflare:test";
import { createAuth } from "@authtempo/core";
import { beforeEach, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

// Migration 0008 (plan 12c) copies each enabled ta_totp row into
// ta_second_factor with the same id. A backup code hash is keyed by the row
// id (spec 8.11 item 3), so the same id keeps every stored code valid. The
// test runs the copy statement as the migration ships it, on rows that the
// adapter wrote, so the JSON text of `methods` must equal the adapter's own
// encoding of a json field.

const at = new Date("2026-10-14T00:00:00.000Z");

/** The INSERT ... SELECT statement of 0008_schema_v8, as the file ships it. */
function copyStatement(): string {
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0008_"));
  const q = m?.queries.find((s) => s.includes("INSERT INTO ta_second_factor"));
  if (!q) throw new Error("0008_schema_v8 has no copy statement");
  return q;
}

function totpRow(id: string, userId: string, enabledAt: Date | null, backupCodes: string[]) {
  return {
    id,
    userId,
    secret: "sealed",
    enabledAt,
    lastStep: 5,
    backupCodes,
    createdAt: at,
    updatedAt: at,
    secretVersion: 1,
  };
}

beforeEach(async () => {
  await env.DB.batch(
    ["ta_second_factor", "ta_totp", "ta_user"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
});

it("deletes each unconfirmed totp setup at 0008 and keeps the enabled row (plan 12c)", async () => {
  const db = createD1Adapter(env.DB);
  await db.create("totp", totpRow("f1", "u1", at, ["h1"]));
  await db.create("totp", totpRow("f2", "u2", null, ["h2"]));
  // The data statements of 0008 as the file ships them: the copy and the delete.
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0008_"));
  for (const q of m?.queries ?? [])
    if (/^(INSERT|DELETE)\b/.test(q.replace(/^\s*--.*$/gm, "").trim()))
      await env.DB.prepare(q).run();
  expect((await db.findMany("totp", [])).map((r) => r.id)).toEqual(["f1"]);
  expect((await db.findMany("secondFactor", [])).map((r) => r.id)).toEqual(["f1"]);
});

it("copies each enabled totp row with the same id and version 1, and skips an unconfirmed setup (plan 12c)", async () => {
  const db = createD1Adapter(env.DB);
  await db.create("totp", totpRow("f1", "u1", at, ["h1", "h2"]));
  await db.create("totp", totpRow("f2", "u2", null, ["h3"]));
  await env.DB.prepare(copyStatement()).run();
  expect(await db.findMany("secondFactor", [])).toEqual([
    {
      id: "f1",
      userId: "u1",
      enabledAt: at,
      methods: ["totp"],
      backupCodes: ["h1", "h2"],
      backupCodesVersion: 1,
      createdAt: at,
      updatedAt: at,
      // The copy of 0008 names no secret_version: the column default of 0009.
      secretVersion: 1,
    },
  ]);
});

/** HMAC-SHA256 hex of `text` under `key`: the backup code hash of spec 8.11 item 3. */
async function hmacHex(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

it("lets a plan 9f backup code of 8 characters pass through the engine after the copy, and the replacement writes version 2 (plan 12c)", async () => {
  const db = createD1Adapter(env.DB);
  const secret = "0123456789abcdef0123456789abcdef";
  const auth = createAuth({
    baseURL: "https://api.example.com",
    secret,
    trustedOrigins: [],
    storage: db,
    mail: { send: async () => {} },
    password: {},
  });
  const user = await db.create("user", {
    id: "u1",
    email: "ada@example.com",
    emailVerified: true,
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
  const code = "abcd2345";
  await db.create("totp", totpRow("f1", "u1", at, [await hmacHex(secret, `f1:${code}`)]));
  await env.DB.prepare(copyStatement()).run();
  const totp = auth.api.totp;
  if (!totp) throw new Error("totp is off");
  expect((await totp.regenerateBackupCodesWithCode({ user, code })).ok).toBe(true);
  expect(await db.findOne("secondFactor", [{ field: "id", op: "eq", value: "f1" }])).toMatchObject({
    backupCodesVersion: 2,
  });
});
