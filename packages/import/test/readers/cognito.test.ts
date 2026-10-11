import { createMemoryAdapter, LEGACY_VERIFY_HASH } from "@tempo-auth/core";
import { describe, expect, it } from "vitest";
import { importUsers } from "../../src/import.js";
import { cognitoSource } from "../../src/readers/cognito.js";
import { all, now } from "./all.js";

describe("cognitoSource", () => {
  // Fields: the ListUsers API reference, read 2026-10-11.
  // Unverified, checked by owner runbook item 6: that Cognito exports no
  // password hash (the reference shows none, so every password user gets the
  // marker), and the shape of the identities attribute (an unreadable one is
  // dropped and listed: user "fed-bad").
  const USERS = JSON.stringify({
    Users: [
      {
        Username: "c0ffee",
        Attributes: [
          { Name: "sub", Value: "sub-1" },
          { Name: "email", Value: "cara@example.com" },
          { Name: "email_verified", Value: "true" },
        ],
        UserCreateDate: 1700000000.5,
        Enabled: true,
        UserStatus: "CONFIRMED",
      },
      {
        Username: "Google_123",
        Attributes: [
          { Name: "sub", Value: "sub-2" },
          { Name: "email", Value: "gail@example.com" },
          { Name: "email_verified", Value: "false" },
          { Name: "identities", Value: '[{"providerName":"Google","userId":"123"}]' },
        ],
        UserCreateDate: "2023-11-14T22:13:20.000Z",
        Enabled: true,
        UserStatus: "EXTERNAL_PROVIDER",
      },
      {
        Username: "off",
        Attributes: [{ Name: "email", Value: "off@example.com" }],
        Enabled: false,
        UserStatus: "CONFIRMED",
      },
      {
        Username: "fed-bad",
        Attributes: [
          { Name: "email", Value: "fed@example.com" },
          { Name: "identities", Value: "not json" },
        ],
        Enabled: true,
        UserStatus: "EXTERNAL_PROVIDER",
      },
    ],
  });

  it("gives every password user the legacy-verify marker, and maps a federated user's identity", async () => {
    const r = await all(cognitoSource({ users: USERS }));
    expect(r[0]).toMatchObject({
      sourceId: "sub-1",
      emailVerified: true,
      createdAt: new Date(1700000000500),
      password: { hash: LEGACY_VERIFY_HASH },
    });
    expect(r[1]).toMatchObject({
      sourceId: "sub-2",
      emailVerified: false,
      identities: [{ provider: "google", subject: "123" }],
      password: null,
      createdAt: new Date("2023-11-14T22:13:20.000Z"),
    });
    expect(r[2]).toMatchObject({ sourceId: "off", skip: "disabled" });
    expect(r[3]).toMatchObject({
      sourceId: "fed-bad",
      identities: [],
      password: null,
      dropped: ["identity:unreadable"],
    });
  });

  it("writes the marker only under legacyVerify, and the email identity only for the verified user", async () => {
    const db = createMemoryAdapter();
    await importUsers(db, cognitoSource({ users: USERS }), { now, legacyVerify: true });
    expect((await db.findMany("password", [])).map((p) => p.hash)).toEqual([LEGACY_VERIFY_HASH]);
    expect(
      (await db.findMany("identity", [])).map((i) => `${i.provider}:${i.subject}`).sort(),
    ).toEqual(["email:cara@example.com", "google:123"]);
    const refused = await importUsers(createMemoryAdapter(), cognitoSource({ users: USERS }), {
      now,
    });
    expect(refused.refusedHashes).toEqual([{ sourceId: "sub-1", format: "legacy-verify" }]);
  });
});
