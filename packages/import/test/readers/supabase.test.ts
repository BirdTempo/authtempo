import { createMemoryAdapter } from "@tempo-auth/core";
import { describe, expect, it } from "vitest";
import { importUsers } from "../../src/import.js";
import { parseTime } from "../../src/readers/common.js";
import { supabaseSource } from "../../src/readers/supabase.js";
import identities from "../fixtures/supabase-identities.csv?raw";
import users from "../fixtures/supabase-users.csv?raw";
import { all, FIREBASE, FIRESCRYPT, now } from "./all.js";

describe("parseTime", () => {
  it("reads Postgres timestamptz text", () => {
    expect(parseTime("2024-01-15 10:30:00.123456+00")?.toISOString()).toBe(
      "2024-01-15T10:30:00.123Z",
    );
    expect(parseTime("2024-01-15 12:30:00+02")?.toISOString()).toBe("2024-01-15T10:30:00.000Z");
    expect(parseTime("")).toBeNull();
    expect(parseTime("yesterday")).toBeNull();
  });
});

// The fixture is in the column shape of the README's \copy select; columns
// checked in the supabase/auth migrations on 2026-10-11 (plan 9b research 1a).
// Unverified, and the owner runbook checks them:
// - banned_until: seen in Clerk's sample CSV of auth.users, not read in a migration.
// - The CSV quoting and the timestamptz text form: from Clerk's sample CSV, not a Supabase-made file.
// - The Argon2 base64 alphabet in a real Supabase row: the argon2i row here is made up and malformed.
// - A $fbscrypt$ row with no sk: no real row was seen; this reader refuses it.
// Every user with an address has its email identity row, as Supabase writes
// one on each email sign-up (backfill migration 20221125140132).
describe("supabaseSource", () => {
  it("maps every field it reads and marks the edges", async () => {
    const r = await all(supabaseSource({ users, identities, firebase: FIREBASE, now }));
    expect(r[0]).toEqual({
      kind: "user",
      sourceId: "11111111-1111-4111-8111-111111111111",
      email: "ada@example.com",
      emailVerified: true,
      name: "Ada Lovelace",
      image: "https://example.com/ada.png",
      createdAt: new Date("2024-01-15T10:29:00.500Z"),
      identities: [{ provider: "google", subject: "109876543210" }],
      password: { hash: "$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga" },
      passkeys: [],
    });
    expect(r[1]).toMatchObject({
      emailVerified: false,
      identities: [{ provider: "github", subject: "4242" }],
    });
    expect(r.map((x) => (x.kind === "user" ? (x.skip ?? null) : null))).toEqual([
      null,
      null,
      "anonymous",
      "deleted",
      "banned",
      null,
      null,
    ]);
    expect(r[5]).toMatchObject({ password: { hash: FIRESCRYPT } });
  });

  it("refuses a $fbscrypt$ row when no Firebase project is given", async () => {
    const r = await all(supabaseSource({ users, identities, now }));
    expect(r[5]).toMatchObject({
      password: { refused: "fbscrypt (not this import's Firebase project)" },
    });
  });

  it("refuses a $fbscrypt$ row of another Firebase project: another signer key or salt separator", async () => {
    const otherKey = await all(
      supabaseSource({
        users,
        identities,
        firebase: { ...FIREBASE, signerKey: `A${FIREBASE.signerKey.slice(1)}` },
        now,
      }),
    );
    expect(otherKey[5]).toMatchObject({
      password: { refused: "fbscrypt (not this import's Firebase project)" },
    });
    const otherSeparator = await all(
      supabaseSource({ users, identities, firebase: { ...FIREBASE, saltSeparator: "CA==" }, now }),
    );
    expect(otherSeparator[5]).toMatchObject({
      password: { refused: "fbscrypt (not this import's Firebase project)" },
    });
  });

  it("imports the fixture: the bcrypt and Firebase rows, a refused argon2i, the github identity dropped", async () => {
    const db = createMemoryAdapter();
    const report = await importUsers(
      db,
      supabaseSource({ users, identities, firebase: FIREBASE, now }),
      { now },
    );
    // Identities: ada's email and google, and the email identity of fire and argon.
    // Bob is unverified, so the importer writes no email identity for him.
    expect(report.created).toMatchObject({ user: 4, password: 3, identity: 4 });
    expect(report.refusedHashes).toEqual([
      {
        sourceId: "77777777-7777-4777-8777-777777777777",
        format: "argon2i (malformed or out of bounds)",
      },
    ]);
    expect(report.dropped).toEqual([
      { sourceId: "22222222-2222-4222-8222-222222222222", item: "identity:github" },
    ]);
    const bob = await db.findOne("user", [{ field: "email", op: "eq", value: "bob@example.com" }]);
    expect(bob).toMatchObject({ emailVerified: false });
    const bobEmail = await db.findOne("identity", [
      { field: "provider", op: "eq", value: "email" },
      { field: "subject", op: "eq", value: "bob@example.com" },
    ]);
    expect(bobEmail).toBeNull();
    const adaEmail = await db.findOne("identity", [
      { field: "provider", op: "eq", value: "email" },
      { field: "subject", op: "eq", value: "ada@example.com" },
    ]);
    expect(adaEmail).not.toBeNull();
  });
});
