import { createMemoryAdapter } from "@tempo-auth/core";
import { describe, expect, it } from "vitest";
import { importUsers } from "../../src/import.js";
import { authjsSource } from "../../src/readers/authjs.js";
import { all, now } from "./all.js";

describe("authjsSource", () => {
  // Columns: the Prisma schema of nextauthjs/next-auth main, read 2026-10-11.
  const TABLES = JSON.stringify({
    users: [
      {
        id: "cuid1",
        name: "Ida",
        email: "ida@example.com",
        emailVerified: "2024-01-01T00:00:00.000Z",
        image: null,
        passwordHash: "$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga",
      },
      { id: "cuid2", name: null, email: "jo@example.com", emailVerified: null, image: null },
    ],
    accounts: [
      { userId: "cuid1", type: "oidc", provider: "google", providerAccountId: "g-1" },
      { userId: "cuid1", type: "email", provider: "resend", providerAccountId: "ida@example.com" },
      { userId: "cuid2", type: "oauth", provider: "github", providerAccountId: "gh-2" },
    ],
    authenticators: [
      {
        credentialID: "AQID+/8=",
        userId: "cuid1",
        providerAccountId: "x",
        // Canonical standard base64, as Auth.js writes it (review M-3).
        credentialPublicKey: "pQECAyYgASFYIPv/",
        counter: 4,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        transports: "internal,hybrid",
      },
      // The unverified user's passkey: the importer drops and lists it (review M-2).
      {
        credentialID: "BAUG",
        userId: "cuid2",
        providerAccountId: "y",
        credentialPublicKey: "pQECAyYgASFYIPv/",
        counter: 0,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        transports: null,
      },
    ],
  });

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
      { now },
    );
    expect(
      (await db.findMany("identity", [])).map((i) => `${i.provider}:${i.subject}`).sort(),
    ).toEqual(["email:ida@example.com", "google:g-1"]);
    expect((await db.findMany("passkey", [])).map((p) => p.credentialId)).toEqual(["AQID-_8"]);
    expect(report.created).toMatchObject({ user: 2, password: 1, passkey: 1 });
    expect(report.dropped).toContainEqual({ sourceId: "cuid2", item: "identity:github" });
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

  it("throws on a password column that no row has", async () => {
    await expect(
      all(authjsSource({ tables: EDGE, passwordColumn: "password_hash" })),
    ).rejects.toThrow('no Auth.js user row has the password column "password_hash"');
  });
});
