import { createMemoryAdapter } from "@tempo-auth/core";
import { LEGACY_FORMATS } from "@tempo-auth/legacy-hashes";
import { describe, expect, it } from "vitest";
import { importUsers } from "../../src/import.js";
import { firebaseSource } from "../../src/readers/firebase.js";
import { all, FIRESCRYPT, now } from "./all.js";

describe("firebaseSource", () => {
  // Fields: firebase-tools src/accountExporter.ts, read 2026-10-11. The user is the firebase/scrypt README vector.
  // Unverified, checked by owner runbook item 5: the JSON type of createdAt (a
  // digit string and a number are both here) and the { "users": [...] } wrapper
  // (a bare array is tested too).
  const LIST = [
    {
      localId: "fbuid1",
      email: "user1@example.com",
      emailVerified: true,
      passwordHash:
        "lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==",
      salt: "42xEC+ixf3L2lw==",
      displayName: "User One",
      createdAt: "1600000000000",
      providerUserInfo: [
        { providerId: "apple.com", rawId: "001.apple" },
        { providerId: "facebook.com", rawId: "fb-1" },
      ],
    },
    {
      localId: "fbuid2",
      email: "off@example.com",
      emailVerified: true,
      disabled: true,
      createdAt: 1600000000000,
    },
    {
      localId: "fbuid3",
      email: "nopw@example.com",
      emailVerified: false,
      passwordHash: "",
      salt: "",
    },
  ];
  const USERS = JSON.stringify({ users: LIST });

  it("builds the firescrypt string from the project's rounds and mem_cost", async () => {
    const r = await all(firebaseSource({ users: USERS, hashConfig: { rounds: 8, memCost: 14 } }));
    expect(r[0]).toMatchObject({
      sourceId: "fbuid1",
      emailVerified: true,
      name: "User One",
      createdAt: new Date(1600000000000),
      identities: [
        { provider: "apple", subject: "001.apple" },
        { provider: "facebook", subject: "fb-1" },
      ],
      password: { hash: FIRESCRYPT },
    });
    expect(r[1]).toMatchObject({ skip: "disabled", createdAt: new Date(1600000000000) });
    expect(r[2]).toMatchObject({ sourceId: "fbuid3", emailVerified: false, password: null });
  });

  it("reads a bare array as the wrapped export", async () => {
    const config = { rounds: 8, memCost: 14 };
    expect(await all(firebaseSource({ users: JSON.stringify(LIST), hashConfig: config }))).toEqual(
      await all(firebaseSource({ users: USERS, hashConfig: config })),
    );
  });

  it("writes the email identity only for the verified user", async () => {
    const db = createMemoryAdapter();
    const report = await importUsers(
      db,
      firebaseSource({ users: USERS, hashConfig: { rounds: 8, memCost: 14 } }),
      { formats: LEGACY_FORMATS, now },
    );
    expect(
      (await db.findMany("identity", [])).map((i) => `${i.provider}:${i.subject}`).sort(),
    ).toEqual(["apple:001.apple", "email:user1@example.com"]);
    expect((await db.findMany("password", [])).map((p) => p.hash)).toEqual([FIRESCRYPT]);
    expect(report.skipped).toEqual([{ kind: "user", sourceId: "fbuid2", reason: "disabled" }]);
    expect(report.created.user).toBe(2);
    expect(report.dropped).toContainEqual({ sourceId: "fbuid1", item: "identity:facebook" });
  });
});

// Edge rows (review I-1, I-2, M-2 to M-5), same fields and date as above.
const HASH =
  "lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==";
const CONFIG = { rounds: 8, memCost: 14 };
const EDGE = JSON.stringify({
  users: [
    { localId: "dis_str", email: "ds@example.com", emailVerified: true, disabled: "true" },
    { localId: "dis_num", email: "dn@example.com", emailVerified: true, disabled: 1 },
    { localId: "nosalt", email: "ns@example.com", emailVerified: true, passwordHash: HASH },
    { localId: "nohash", email: "nh@example.com", emailVerified: true, salt: "42xEC+ixf3L2lw==" },
    {
      localId: "urlsafe",
      email: "us@example.com",
      emailVerified: true,
      passwordHash: HASH.replace(/\+/g, "-").replace(/\//g, "_"),
      salt: "42xEC+ixf3L2lw==",
    },
    { localId: "phone", phoneNumber: "+15550100", providerUserInfo: [] },
    {
      localId: "goog",
      email: "goog@example.com",
      emailVerified: true,
      providerUserInfo: [{ providerId: "google.com", rawId: "g-9" }, { providerId: "github.com" }],
    },
  ],
});

describe("firebaseSource edge rows", () => {
  it("fails a disable closed, refuses a half hash, and lists an entry with no rawId", async () => {
    const r = await all(firebaseSource({ users: EDGE, hashConfig: CONFIG }));
    const by = (id: string) => r.find((x) => x.kind === "user" && x.sourceId === id);
    expect(by("dis_str")).toMatchObject({ skip: "disabled" });
    expect(by("dis_num")).toMatchObject({ skip: "disabled" });
    expect(by("nosalt")).toMatchObject({ password: { refused: "firescrypt (no salt)" } });
    expect(by("nohash")).toMatchObject({ password: { refused: "firescrypt (no hash)" } });
    expect(by("goog")).toMatchObject({
      identities: [{ provider: "google", subject: "g-9" }],
      dropped: ["identity:github:no_subject"],
    });
  });

  it("reports every refusal path through the importer", async () => {
    const db = createMemoryAdapter();
    const report = await importUsers(db, firebaseSource({ users: EDGE, hashConfig: CONFIG }), {
      formats: LEGACY_FORMATS,
      now,
    });
    expect(await db.findMany("password", [])).toEqual([]);
    expect(report.refusedHashes).toEqual([
      { sourceId: "nosalt", format: "firescrypt (no salt)" },
      { sourceId: "nohash", format: "firescrypt (no hash)" },
      { sourceId: "urlsafe", format: "firescrypt (malformed or out of bounds)" },
    ]);
    for (const [id, reason] of [
      ["dis_str", "disabled"],
      ["dis_num", "disabled"],
      ["phone", "no_email"],
    ])
      expect(report.skipped).toContainEqual({ kind: "user", sourceId: id, reason });
    expect(report.dropped).toContainEqual({ sourceId: "goog", item: "identity:github:no_subject" });
    expect(
      (await db.findMany("identity", []))
        .filter((i) => i.provider === "google")
        .map((i) => i.subject),
    ).toEqual(["g-9"]);
  });

  it("throws on a file with no users array and on a hashConfig out of the grammar's bounds", async () => {
    await expect(
      all(firebaseSource({ users: JSON.stringify({ accounts: [] }), hashConfig: CONFIG })),
    ).rejects.toThrow("the firebase export has no users array");
    for (const bad of [
      { rounds: 8, memCost: 17 },
      { rounds: 8, memCost: 0 },
      { rounds: 0, memCost: 14 },
      { rounds: 8.5, memCost: 14 },
      // r has two digits in the grammar, so 100 is out of bounds though 2^1 * 100 is small.
      { rounds: 100, memCost: 1 },
    ])
      expect(() => firebaseSource({ users: EDGE, hashConfig: bad })).toThrow(
        "firebase hashConfig rounds and memCost must be integers of 1 to 99",
      );
    // 2^15 * 8 is the bound itself.
    expect(() =>
      firebaseSource({ users: EDGE, hashConfig: { rounds: 8, memCost: 15 } }),
    ).not.toThrow();
  });
});

describe("firebaseSource: a user with no localId (plan 9b2, Review Focus 4)", () => {
  it("skips it as no_source_id and names the item", async () => {
    const users = JSON.stringify({
      users: [{ email: "nid@example.com", emailVerified: true, providerUserInfo: [] }],
    });
    const r = await all(firebaseSource({ users, hashConfig: CONFIG }));
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
    const report = await importUsers(
      createMemoryAdapter(),
      firebaseSource({ users, hashConfig: CONFIG }),
      { formats: LEGACY_FORMATS, now },
    );
    expect(report.skipped).toEqual([
      { kind: "user", sourceId: "(none) users item 1", reason: "no_source_id" },
    ]);
  });
});

describe("firebaseSource: GitHub (plan 9b2)", () => {
  it("maps github.com with its rawId, and the importer keeps it", async () => {
    const users = JSON.stringify({
      users: [
        {
          localId: "f9",
          email: "oc@example.com",
          emailVerified: true,
          providerUserInfo: [{ providerId: "github.com", rawId: "583231" }],
        },
      ],
    });
    const db = createMemoryAdapter();
    const report = await importUsers(db, firebaseSource({ users, hashConfig: CONFIG }), {
      formats: LEGACY_FORMATS,
      now,
    });
    expect(report.dropped).toEqual([]);
    expect(
      (await db.findMany("identity", [])).map((i) => `${i.provider}:${i.subject}`).sort(),
    ).toEqual(["email:oc@example.com", "github:583231"]);
  });
});
