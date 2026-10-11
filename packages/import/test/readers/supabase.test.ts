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
// one on each email sign-up (backfill migration 20221125140132). The SSO user
// has an `sso:<provider id>` identity and no email row (internal/api/samlacs.go,
// read 2026-10-11). Two Google identities on one user is a state core reaches:
// a second Google account with the same verified address links to the user.
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
      null,
      "banned",
      "sso_user",
      null,
      null,
    ]);
    expect(r[5]).toMatchObject({ password: { hash: FIRESCRYPT } });
    expect(r[11]).toMatchObject({
      identities: [
        { provider: "google", subject: "200000000001" },
        { provider: "google", subject: "200000000002" },
      ],
    });
  });

  it("imports an expired ban, and keeps out a future ban and a ban it cannot read", async () => {
    const r = await all(supabaseSource({ users, identities, now }));
    const skipOf = (id: string) => r.find((x) => x.sourceId === id && x.kind === "user");
    // 2024-06-01 is before now (2026-10-11): the ban is over.
    expect(skipOf("88888888-8888-4888-8888-888888888888")).not.toHaveProperty("skip");
    // 2099-01-01 is after now.
    expect(skipOf("55555555-5555-4555-8555-555555555555")).toMatchObject({ skip: "banned" });
    // Postgres prints a ban for ever as `infinity`, which parseTime does not read.
    expect(skipOf("99999999-9999-4999-8999-999999999999")).toMatchObject({ skip: "banned" });
    // A timestamp in DateStyle SQL, which parseTime does not read, also fails closed.
    const sqlStyle = users.replace("2099-01-01 00:00:00+00", "01/01/2099 00:00:00 UTC");
    const r2 = await all(supabaseSource({ users: sqlStyle, identities, now }));
    expect(r2[4]).toMatchObject({ skip: "banned" });
  });

  it("reads a jsonb null in raw_user_meta_data as no name and goes on", async () => {
    const r = await all(supabaseSource({ users, identities, now }));
    expect(r[10]).toMatchObject({
      sourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: null,
      image: null,
    });
    expect(r[10]).not.toHaveProperty("dropped");
    expect(r).toHaveLength(12);
  });

  it("lists raw_user_meta_data that is not JSON as dropped (a file edited by hand)", async () => {
    const broken = users.replace(
      "2024-02-10 08:00:00+00,null,",
      '2024-02-10 08:00:00+00,"{""full_name"": ",',
    );
    const r = await all(supabaseSource({ users: broken, identities, now }));
    expect(r[10]).toMatchObject({ name: null, dropped: ["meta:invalid"] });
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
    // Users: ada, bob, fire, argon, paroled, nullmeta, twogoogle.
    // Identities (9): ada's email and google (2); the email identity of fire,
    // argon, paroled, and nullmeta (4); twogoogle's email and two google (3). Bob is
    // unverified, so the importer writes no email identity for him.
    expect(report.created).toMatchObject({ user: 7, password: 3, identity: 9 });
    expect(report.skipped).toEqual([
      { kind: "user", sourceId: "33333333-3333-4333-8333-333333333333", reason: "anonymous" },
      { kind: "user", sourceId: "44444444-4444-4444-8444-444444444444", reason: "deleted" },
      { kind: "user", sourceId: "55555555-5555-4555-8555-555555555555", reason: "banned" },
      { kind: "user", sourceId: "99999999-9999-4999-8999-999999999999", reason: "banned" },
      { kind: "user", sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", reason: "sso_user" },
    ]);
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
    for (const subject of ["200000000001", "200000000002"])
      expect(
        await db.findOne("identity", [
          { field: "provider", op: "eq", value: "google" },
          { field: "subject", op: "eq", value: subject },
        ]),
      ).not.toBeNull();
  });
});
