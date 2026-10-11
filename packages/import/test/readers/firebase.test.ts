import { createMemoryAdapter } from "@tempo-auth/core";
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
      { now },
    );
    expect(
      (await db.findMany("identity", [])).map((i) => `${i.provider}:${i.subject}`).sort(),
    ).toEqual(["apple:001.apple", "email:user1@example.com"]);
    expect((await db.findMany("password", [])).map((p) => p.hash)).toEqual([FIRESCRYPT]);
    expect(report.skipped).toEqual([{ kind: "user", sourceId: "fbuid2", reason: "disabled" }]);
    expect(report.created.user).toBe(2);
  });
});
