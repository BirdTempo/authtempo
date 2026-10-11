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
        Attributes: [
          { Name: "sub", Value: "sub-3" },
          { Name: "email", Value: "off@example.com" },
        ],
        Enabled: false,
        UserStatus: "CONFIRMED",
      },
      {
        Username: "fed-bad",
        Attributes: [
          { Name: "sub", Value: "sub-4" },
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
    expect(r[2]).toMatchObject({ sourceId: "sub-3", skip: "disabled" });
    expect(r[3]).toMatchObject({
      sourceId: "sub-4",
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

// Edge rows (review I-1, I-2, M-1 to M-7, N-3), same fields and date as above.
const user = (
  username: string,
  attrs: Record<string, string>,
  over: Record<string, unknown> = {},
) => ({
  Username: username,
  Attributes: Object.entries(attrs).map(([Name, Value]) => ({ Name, Value })),
  Enabled: true,
  UserStatus: "CONFIRMED",
  ...over,
});
const verified = (sub: string) => ({
  sub,
  email: `${sub}@example.com`,
  email_verified: "true",
});
const STATUSES = [
  "UNCONFIRMED",
  "FORCE_CHANGE_PASSWORD",
  "RESET_REQUIRED",
  "COMPROMISED",
  "ARCHIVED",
];
const EDGE = JSON.stringify({
  Users: [
    ...STATUSES.map((st) => user(st, verified(`st-${st}`), { UserStatus: st })),
    user("nostatus", verified("st-none"), { UserStatus: undefined }),
    user("enabled-str", verified("en-str"), {
      Enabled: "false",
      UserCreateDate: "November 14 2023",
    }),
    user("enabled-none", verified("en-none"), { Enabled: undefined }),
    // A native user an admin linked to Apple, and a custom provider named "Apple" (review I-2, M-2).
    user(
      "linked",
      {
        ...verified("linked"),
        identities: JSON.stringify([
          { providerName: "SignInWithApple", userId: "a-1" },
          { providerName: "Apple", userId: "x-1" },
          { providerName: "Google" },
        ]),
      },
      { UserCreateDate: "2023-11-14T22:13:20.000000+00:00" },
    ),
    user("fed-none", verified("fed-none"), { UserStatus: "EXTERNAL_PROVIDER" }),
    user(
      "fed-obj",
      { ...verified("fed-obj"), identities: '{"a":1}' },
      { UserStatus: "EXTERNAL_PROVIDER" },
    ),
    user("nosub", { email: "nosub@example.com", email_verified: "true" }),
    user("dup-a", verified("dup")),
    user("dup-b", verified("dup")),
  ],
});

describe("cognitoSource edge rows", () => {
  it("writes the marker only for CONFIRMED and skips every other status", async () => {
    const r = await all(cognitoSource({ users: EDGE }));
    const by = (id: string) => r.find((x) => x.kind === "user" && x.sourceId === id);
    for (const st of STATUSES)
      expect(by(`st-${st}`)).toMatchObject({
        password: null,
        skip: `status_${st.toLowerCase()}`,
      });
    expect(by("st-none")).toMatchObject({ password: null, skip: "status_unknown" });
    expect(by("linked")).toMatchObject({ password: { hash: LEGACY_VERIFY_HASH } });
    expect(by("linked")).not.toHaveProperty("skip");
  });

  it("fails Enabled closed, maps only the built-in providers, and lists every unreadable identity", async () => {
    const r = await all(cognitoSource({ users: EDGE }));
    const by = (id: string) => r.find((x) => x.kind === "user" && x.sourceId === id);
    // A loose date is unreadable, not read as local time (review M-7).
    expect(by("en-str")).toMatchObject({ skip: "disabled", createdAt: null });
    expect(by("en-none")).toMatchObject({ skip: "disabled" });
    expect(by("linked")).toMatchObject({
      identities: [
        { provider: "apple", subject: "a-1" },
        { provider: "cognito:Apple", subject: "x-1" },
      ],
      dropped: ["identity:unreadable"],
      createdAt: new Date("2023-11-14T22:13:20.000Z"),
    });
    expect(by("fed-none")).toMatchObject({ identities: [], dropped: ["identity:unreadable"] });
    expect(by("fed-obj")).toMatchObject({ identities: [], dropped: ["identity:unreadable"] });
  });

  it("skips a record with no sub and every copy of a duplicate sub", async () => {
    const r = await all(cognitoSource({ users: EDGE }));
    expect(r.filter((x) => x.kind === "user" && x.sourceId === "username:nosub")).toEqual([
      expect.objectContaining({ skip: "no_source_id" }),
    ]);
    expect(r.filter((x) => x.kind === "user" && x.sourceId === "dup")).toEqual([
      expect.objectContaining({ skip: "duplicate_row" }),
      expect.objectContaining({ skip: "duplicate_row" }),
    ]);
  });

  it("imports the linked user with the Apple identity and lists the custom provider", async () => {
    const db = createMemoryAdapter();
    const report = await importUsers(db, cognitoSource({ users: EDGE }), {
      now,
      legacyVerify: true,
    });
    expect((await db.findMany("user", [])).map((u) => u.email).sort()).toEqual([
      "fed-none@example.com",
      "fed-obj@example.com",
      "linked@example.com",
    ]);
    expect(
      (await db.findMany("identity", []))
        .filter((i) => i.provider === "apple")
        .map((i) => i.subject),
    ).toEqual(["a-1"]);
    expect(report.dropped).toContainEqual({ sourceId: "linked", item: "identity:cognito:Apple" });
    expect(report.created.password).toBe(1);
    // The status reaches the report through the reason.
    for (const [sourceId, reason] of [
      ["st-COMPROMISED", "status_compromised"],
      ["st-none", "status_unknown"],
      ["username:nosub", "no_source_id"],
    ])
      expect(report.skipped).toContainEqual({ kind: "user", sourceId, reason });
  });
});
