import { createMemoryAdapter } from "@authtempo/core";
import { LEGACY_FORMATS } from "@authtempo/legacy-hashes";
import { describe, expect, it } from "vitest";
import { importUsers } from "../../src/import.js";
import { authjsSource } from "../../src/readers/authjs.js";
import { AUTHJS_TABLES as TABLES } from "../fixtures/readers.js";
import { all, now } from "./all.js";

describe("authjsSource", () => {
  it("maps the tables, takes the password column the operator names, and keeps passkeys only under the same rp id", async () => {
    const strict = await all(authjsSource({ tables: TABLES, passwordColumn: "passwordHash" }));
    expect(strict[0]).toMatchObject({
      emailVerified: true,
      identities: [{ provider: "google", subject: "g-1" }],
      password: { hash: "$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga" },
      passkeys: [],
      // The email account row is listed, not kept (review M-1).
      dropped: ["passkey:rp_id_not_confirmed", "account:email"],
    });
    expect(strict[1]).toMatchObject({ emailVerified: false, createdAt: null, password: null });
    const same = await all(authjsSource({ tables: TABLES, samePasskeyRpId: true }));
    expect(same[0]).toMatchObject({
      password: null,
      passkeys: [
        {
          credentialId: "AQID-_8",
          publicKey: "pQECAyYgASFYIPv_",
          counter: 4,
          transports: "internal,hybrid",
          deviceType: "multiDevice",
          backedUp: true,
          name: null,
        },
      ],
    });
  });

  it("writes the email identity and the passkey only for the verified user", async () => {
    const db = createMemoryAdapter();
    const report = await importUsers(
      db,
      authjsSource({ tables: TABLES, passwordColumn: "passwordHash", samePasskeyRpId: true }),
      { formats: LEGACY_FORMATS, now },
    );
    expect(
      (await db.findMany("identity", [])).map((i) => `${i.provider}:${i.subject}`).sort(),
    ).toEqual(["email:ida@example.com", "google:g-1"]);
    expect((await db.findMany("passkey", [])).map((p) => p.credentialId)).toEqual(["AQID-_8"]);
    expect(report.created).toMatchObject({ user: 2, password: 1, passkey: 1 });
    expect(report.dropped).toContainEqual({
      sourceId: "cuid2",
      item: "identity:github:subject_form",
    });
    expect(report.dropped).toContainEqual({ sourceId: "cuid2", item: "passkey:unverified" });
    expect(report.dropped).toContainEqual({ sourceId: "cuid1", item: "account:email" });
  });
});

// Edge rows (review I-1 to I-3, M-4 to M-6), same columns and date as above.
const KEY = "pQECAyYgASFYIPv/";
const key = (credentialID: string, userId: string, over: Record<string, unknown> = {}) => ({
  credentialID,
  userId,
  providerAccountId: "p",
  credentialPublicKey: KEY,
  counter: 7,
  credentialDeviceType: "multiDevice",
  credentialBackedUp: true,
  transports: null,
  ...over,
});
const EDGE = JSON.stringify({
  users: [
    { id: "e1", email: "e1@example.com", emailVerified: "2024-01-01T00:00:00.000Z" },
    { id: "e2", email: "e2@example.com", emailVerified: "false" },
    { id: "e3", email: "e3@example.com", emailVerified: 1700000000000 },
  ],
  accounts: [
    { userId: "e1", type: "credentials", provider: "credentials", providerAccountId: "e1" },
  ],
  authenticators: [
    key("", "e1"),
    key("AQID +/8=", "e1"),
    key("CAkK", "e1", { credentialPublicKey: "pQECAyYg+/==" }),
    key("DA0O", "e1", { counter: "41" }),
    key("EBES", "e1", { counter: -1 }),
    key("FBUW", "e1", { credentialDeviceType: "phone" }),
    key("GBka", "e1", { credentialBackedUp: 1 }),
    key("HB0e", "e1"),
    key("HB0e", "e3"),
    key("IB0f", "e1"),
  ],
});

describe("authjsSource edge rows", () => {
  it("refuses and lists every passkey that core could not have written", async () => {
    const r = await all(authjsSource({ tables: EDGE, samePasskeyRpId: true }));
    expect(r[0]).toMatchObject({
      sourceId: "e1",
      emailVerified: true,
      passkeys: [expect.objectContaining({ credentialId: "IB0f", counter: 7 })],
      dropped: [
        "passkey:invalid_credential_id",
        "passkey:invalid_credential_id",
        "passkey:invalid_public_key",
        "passkey:invalid_counter",
        "passkey:invalid_counter",
        "passkey:invalid_device",
        "passkey:invalid_device",
        "passkey:duplicate_credential_id",
        "account:credentials",
      ],
    });
  });

  it("reads emailVerified only as a date, and lists any other value", async () => {
    const r = await all(authjsSource({ tables: EDGE, samePasskeyRpId: true }));
    expect(r[1]).toMatchObject({
      sourceId: "e2",
      emailVerified: false,
      dropped: ["email_verified:unreadable"],
    });
    expect(r[2]).toMatchObject({
      sourceId: "e3",
      emailVerified: false,
      passkeys: [],
      dropped: ["passkey:duplicate_credential_id", "email_verified:unreadable"],
    });
  });

  it("counts a credential id by its base64url form: AQ== and AQ are one credential", async () => {
    const tables = JSON.stringify({
      users: [
        { id: "a", email: "a@example.com", emailVerified: "2024-01-01T00:00:00.000Z" },
        { id: "b", email: "b@example.com", emailVerified: "2024-01-01T00:00:00.000Z" },
      ],
      authenticators: [key("AQ==", "a"), key("AQ", "b")],
    });
    const r = await all(authjsSource({ tables, samePasskeyRpId: true }));
    for (const u of r)
      expect(u).toMatchObject({ passkeys: [], dropped: ["passkey:duplicate_credential_id"] });
  });

  it("refuses a counter above 2^32 - 1, the WebAuthn signCount range", async () => {
    const tables = JSON.stringify({
      users: [{ id: "a", email: "a@example.com", emailVerified: "2024-01-01T00:00:00.000Z" }],
      authenticators: [
        key("AQID", "a", { counter: 2 ** 32 - 1 }),
        key("BAUG", "a", { counter: 2 ** 32 }),
      ],
    });
    const [u] = await all(authjsSource({ tables, samePasskeyRpId: true }));
    expect(u).toMatchObject({
      passkeys: [expect.objectContaining({ credentialId: "AQID", counter: 2 ** 32 - 1 })],
      dropped: ["passkey:invalid_counter"],
    });
  });

  it("throws on a misshaped top level, never an empty list", async () => {
    const cases: [string, string][] = [
      ["[]", "the Auth.js tables input is not a JSON object"],
      ["{}", "the Auth.js tables input has no users array"],
      ['{"users":{}}', "the Auth.js tables input has no users array"],
      ['{"users":[],"accounts":{}}', "the Auth.js tables input field accounts is not an array"],
      [
        '{"users":[],"authenticators":null}',
        "the Auth.js tables input field authenticators is not an array",
      ],
    ];
    for (const [tables, message] of cases)
      await expect(all(authjsSource({ tables }))).rejects.toThrow(`authtempo import: ${message}`);
  });

  it("throws on a password column that no row has", async () => {
    await expect(
      all(authjsSource({ tables: EDGE, passwordColumn: "password_hash" })),
    ).rejects.toThrow('no Auth.js user row has the password column "password_hash"');
  });
});

describe("authjsSource: a user with no id (plan 9b2, Review Focus 4)", () => {
  it("skips it as no_source_id, names the item, and links no account to it", async () => {
    const tables = JSON.stringify({
      users: [{ email: "nid@example.com", emailVerified: "2024-01-01T00:00:00.000Z" }],
      accounts: [{ userId: "", type: "oidc", provider: "google", providerAccountId: "g-9" }],
    });
    const r = await all(authjsSource({ tables }));
    expect(r).toEqual([
      {
        kind: "user",
        sourceId: "(none) users item 1",
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
    const report = await importUsers(createMemoryAdapter(), authjsSource({ tables }), {
      formats: LEGACY_FORMATS,
      now,
    });
    expect(report.skipped).toEqual([
      { kind: "user", sourceId: "(none) users item 1", reason: "no_source_id" },
    ]);
  });

  it("keeps the order and the item number of a no-id user between two valid users, and links each account to its own user (parked Task 3 Minor)", async () => {
    const tables = JSON.stringify({
      users: [
        { id: "ja", email: "a@example.com", emailVerified: "2024-01-01T00:00:00.000Z" },
        { email: "nid@example.com", emailVerified: "2024-01-01T00:00:00.000Z" },
        { id: "jb", email: "b@example.com", emailVerified: "2024-01-01T00:00:00.000Z" },
      ],
      accounts: [
        { userId: "ja", type: "oidc", provider: "google", providerAccountId: "g-a" },
        { userId: "jb", type: "oidc", provider: "google", providerAccountId: "g-b" },
      ],
    });
    const source = () => authjsSource({ tables });
    expect(
      (await all(source())).map((r) => [
        r.sourceId,
        r.kind === "user" ? r.identities.map((x) => x.subject) : null,
      ]),
    ).toEqual([
      ["ja", ["g-a"]],
      ["(none) users item 2", []],
      ["jb", ["g-b"]],
    ]);
    const report = await importUsers(createMemoryAdapter(), source(), {
      formats: LEGACY_FORMATS,
      now,
    });
    expect(report.skipped).toEqual([
      { kind: "user", sourceId: "(none) users item 2", reason: "no_source_id" },
    ]);
    expect(report.created.user).toBe(2);
  });
});

describe("authjsSource: GitHub and LinkedIn (plan 9b2)", () => {
  it("keeps a LinkedIn account of type oidc and lists one of type oauth as linkedin_legacy", async () => {
    const tables = JSON.stringify({
      users: [{ id: "c9", email: "lin@example.com", emailVerified: "2024-01-01T00:00:00.000Z" }],
      accounts: [
        { userId: "c9", type: "oauth", provider: "github", providerAccountId: "583231" },
        { userId: "c9", type: "oidc", provider: "linkedin", providerAccountId: "782bbtaQ" },
        { userId: "c9", type: "oauth", provider: "linkedin", providerAccountId: "yrZCpj2Z12" },
      ],
    });
    const r = await all(authjsSource({ tables }));
    expect(r[0]).toMatchObject({
      identities: [
        { provider: "github", subject: "583231" },
        { provider: "linkedin", subject: "782bbtaQ" },
        { provider: "linkedin_legacy", subject: "yrZCpj2Z12" },
      ],
    });
  });
});
