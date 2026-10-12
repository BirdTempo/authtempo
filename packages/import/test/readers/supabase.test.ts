import { createMemoryAdapter } from "@tempo-auth/core";
import { LEGACY_FORMATS } from "@tempo-auth/legacy-hashes";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../../src/csv.js";
import { importUsers } from "../../src/import.js";
import { parseTime } from "../../src/readers/common.js";
import { supabaseSource } from "../../src/readers/supabase.js";
import identities from "../fixtures/supabase-identities.csv?raw";
import users from "../fixtures/supabase-users.csv?raw";
import { all, FIREBASE, FIRESCRYPT, now } from "./all.js";

/** The CSV text with one column taken out, quoted again as psql writes it. */
function withoutColumn(text: string, column: string): string {
  const rows = parseCsv(text);
  const at = rows[0]?.indexOf(column) ?? -1;
  if (at === -1) throw new Error(`fixture has no ${column} column`);
  const quote = (f: string) => (/[",\r\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f);
  return `${rows
    .map((r) =>
      r
        .filter((_, i) => i !== at)
        .map(quote)
        .join(","),
    )
    .join("\n")}\n`;
}

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

  it("reads is_sso_user and is_anonymous as false only for f or false, and skips on TRUE or 1", async () => {
    // Both columns are NOT NULL booleans. psql writes t or f; another tool can
    // write TRUE or 1, and a reader that misses them imports an SSO user.
    const header = users.slice(0, users.indexOf("\n") + 1);
    const row = (id: string, anon: string, sso: string) =>
      `${id},${id}@example.com,,,{},2024-02-02 08:00:00+00,${anon},,,${sso}\n`;
    const csv =
      header +
      row("sso-upper", "f", "TRUE") +
      row("sso-one", "f", "1") +
      row("anon-upper", "TRUE", "f") +
      row("anon-one", "1", "f") +
      row("plain", "false", "false");
    const r = await all(
      supabaseSource({ users: csv, identities: "provider,provider_id,user_id\n", now }),
    );
    const skipOf = (id: string) => r.find((x) => x.sourceId === id)?.skip;
    expect(skipOf("sso-upper")).toBe("sso_user");
    expect(skipOf("sso-one")).toBe("sso_user");
    expect(skipOf("anon-upper")).toBe("anonymous");
    expect(skipOf("anon-one")).toBe("anonymous");
    expect(skipOf("plain")).toBeUndefined();
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

  it("refuses an export with no banned_until, is_sso_user, or provider_id column, before it reads a record", () => {
    // The helper gives a well-formed CSV: every row has the nine other fields.
    expect(parseCsv(withoutColumn(users, "banned_until")).map((r) => r.length)).toEqual(
      Array(13).fill(9),
    );
    expect(() =>
      supabaseSource({ users: withoutColumn(users, "banned_until"), identities, now }),
    ).toThrow("tempo-auth import: the Supabase users file has no banned_until column");
    expect(() =>
      supabaseSource({ users: withoutColumn(users, "is_sso_user"), identities, now }),
    ).toThrow("tempo-auth import: the Supabase users file has no is_sso_user column");
    expect(() =>
      supabaseSource({ users, identities: withoutColumn(identities, "provider_id"), now }),
    ).toThrow("tempo-auth import: the Supabase identities file has no provider_id column");
  });

  it("imports the fixture: the bcrypt and Firebase rows, a refused argon2i, the github identity off the unverified user", async () => {
    const db = createMemoryAdapter();
    const report = await importUsers(
      db,
      supabaseSource({ users, identities, firebase: FIREBASE, now }),
      { formats: LEGACY_FORMATS, now },
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
    // Bob is unverified with a password, so his GitHub identity (4242) is a second credential.
    expect(report.dropped).toEqual([
      {
        sourceId: "22222222-2222-4222-8222-222222222222",
        item: "unverified_extra_credential:github",
      },
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

describe("supabaseSource: a row with no id (plan 9b2, Review Focus 4)", () => {
  it("skips a user row with no id as no_source_id and names the row", async () => {
    const header = users.split("\n")[0];
    const noId = `${header}\n,nid@example.com,,2024-02-12 08:00:00+00,{},2024-02-12 08:00:00+00,f,,,f\n`;
    const source = () =>
      supabaseSource({ users: noId, identities: "provider,provider_id,user_id\n", now });
    expect(await all(source())).toEqual([
      {
        kind: "user",
        sourceId: "(none) users csv row 2",
        email: null,
        emailVerified: false,
        name: null,
        image: null,
        createdAt: null,
        identities: [],
        password: null,
        passkeys: [],
        skip: "no_source_id",
      },
    ]);
    const report = await importUsers(createMemoryAdapter(), source(), {
      formats: LEGACY_FORMATS,
      now,
    });
    expect(report.skipped).toEqual([
      { kind: "user", sourceId: "(none) users csv row 2", reason: "no_source_id" },
    ]);
    expect(report.created.user).toBe(0);
  });

  it("keeps the order and the row number of a no-id row between two valid rows (parked Task 3 Minor)", async () => {
    const header = users.split("\n")[0];
    const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const row = (id: string, email: string) =>
      `${id},${email},,2024-02-12 08:00:00+00,{},2024-02-12 08:00:00+00,f,,,f`;
    const text = `${header}\n${row(A, "a@example.com")}\n${row("", "nid@example.com")}\n${row(B, "b@example.com")}\n`;
    const source = () =>
      supabaseSource({ users: text, identities: "provider,provider_id,user_id\n", now });
    expect(
      (await all(source())).map((r) => [r.sourceId, r.kind === "user" ? r.email : null]),
    ).toEqual([
      [A, "a@example.com"],
      ["(none) users csv row 3", null],
      [B, "b@example.com"],
    ]);
    const report = await importUsers(createMemoryAdapter(), source(), {
      formats: LEGACY_FORMATS,
      now,
    });
    expect(report.skipped).toEqual([
      { kind: "user", sourceId: "(none) users csv row 3", reason: "no_source_id" },
    ]);
    expect(report.created.user).toBe(2);
  });
});

describe("supabaseSource: GitHub and LinkedIn (plan 9b2)", () => {
  it("maps linkedin_oidc to linkedin and the older linkedin provider to linkedin_legacy", async () => {
    const header = users.split("\n")[0];
    const A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const row = (id: string, email: string) =>
      `${id},${email},,2024-02-12 08:00:00+00,{},2024-02-12 08:00:00+00,f,,,f`;
    const two = `${header}\n${row(A, "gh@example.com")}\n${row(B, "li@example.com")}\n`;
    const ids = `provider,provider_id,user_id\ngithub,583231,${A}\nlinkedin_oidc,782bbtaQ,${A}\nlinkedin,yrZCpj2Z12,${B}\n`;
    const r = await all(supabaseSource({ users: two, identities: ids, now }));
    expect(r[0]).toMatchObject({
      identities: [
        { provider: "github", subject: "583231" },
        { provider: "linkedin", subject: "782bbtaQ" },
      ],
    });
    expect(r[1]).toMatchObject({
      identities: [{ provider: "linkedin_legacy", subject: "yrZCpj2Z12" }],
    });
    const report = await importUsers(
      createMemoryAdapter(),
      supabaseSource({ users: two, identities: ids, now }),
      { formats: LEGACY_FORMATS, now },
    );
    expect(report.dropped).toEqual([{ sourceId: B, item: "identity:linkedin_legacy" }]);
  });
});
