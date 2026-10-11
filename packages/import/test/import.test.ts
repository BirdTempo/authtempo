import {
  createMemoryAdapter,
  createPbkdf2PasswordHash,
  LEGACY_VERIFY_HASH,
  type StorageAdapter,
} from "@tempo-auth/core";
import { describe, expect, it } from "vitest";
import { importId } from "../src/ids.js";
import { importUsers } from "../src/import.js";
import { ImportConflictError } from "../src/types.js";
import { AT, appUser, BCRYPT, listSource, org, user } from "./source.js";

const now = () => AT;

/** Every row of every model, so a test can see that a run wrote nothing. */
async function snapshot(db: StorageAdapter) {
  const models = [
    "user",
    "identity",
    "password",
    "passkey",
    "organization",
    "member",
    "session",
  ] as const;
  const out: Record<string, unknown[]> = {};
  for (const m of models) out[m] = await db.findMany(m, []);
  return out;
}

const records = () => [
  user("u1", {
    identities: [
      { provider: "google", subject: "g-1" },
      { provider: "github", subject: "gh-1" },
    ],
    password: { hash: BCRYPT },
  }),
  user("u2", {
    emailVerified: false,
    password: { hash: BCRYPT },
    identities: [{ provider: "apple", subject: "a-2" }],
  }),
  user("u3", { password: { hash: "$md5$abc" } }),
  user("u4", { skip: "anonymous" }),
  user("u5", { email: null }),
  org("o1", [
    { userSourceId: "u1", roles: ["owner"] },
    { userSourceId: "u2", roles: ["member"] },
    { userSourceId: "u9", roles: ["member"] },
  ]),
];

describe("importUsers", () => {
  it("writes the rows a sign-up or a claim writes, and lists what it left out", async () => {
    const db = createMemoryAdapter();
    const report = await importUsers(db, listSource(records()), { now });
    expect(report.created).toEqual({
      user: 3,
      identity: 3,
      password: 2,
      passkey: 0,
      organization: 1,
      member: 1,
    });
    const u1 = await importId("user", "supabase", "u1");
    const ids = (await db.findMany("identity", [{ field: "userId", op: "eq", value: u1 }])).map(
      (i) => `${i.provider}:${i.subject}`,
    );
    expect(ids.sort()).toEqual(["email:u1@example.com", "google:g-1"]);
    // An unverified user: no email identity, one credential (the password), the apple identity dropped.
    const u2 = await importId("user", "supabase", "u2");
    expect(await db.findMany("identity", [{ field: "userId", op: "eq", value: u2 }])).toEqual([]);
    expect((await db.findOne("user", [{ field: "id", op: "eq", value: u2 }]))?.emailVerified).toBe(
      false,
    );
    expect(report.dropped).toEqual([
      { sourceId: "u1", item: "identity:github" },
      { sourceId: "u2", item: "unverified_extra_credential:apple" },
    ]);
    expect(report.refusedHashes).toEqual([
      { sourceId: "u3", format: "md5 (malformed or out of bounds)" },
    ]);
    expect(report.skipped).toEqual([
      { kind: "user", sourceId: "u4", reason: "anonymous" },
      { kind: "user", sourceId: "u5", reason: "no_email" },
      { kind: "member", sourceId: "u2", reason: "user_unverified" },
      { kind: "member", sourceId: "u9", reason: "user_not_imported" },
    ]);
    expect((await db.findOne("user", [{ field: "id", op: "eq", value: u1 }]))?.createdAt).toEqual(
      new Date("2025-01-01T00:00:00.000Z"),
    );
  });

  it("changes zero rows on a second run of the same export", async () => {
    const db = createMemoryAdapter();
    await importUsers(db, listSource(records()), { now });
    const before = await snapshot(db);
    const again = await importUsers(db, listSource(records()), {
      now: () => new Date("2026-10-12T00:00:00.000Z"),
    });
    expect(again.created).toEqual({
      user: 0,
      identity: 0,
      password: 0,
      passkey: 0,
      organization: 0,
      member: 0,
    });
    expect(again.exists).toEqual({ user: 3, organization: 1 });
    expect(await snapshot(db)).toEqual(before);
  });

  it("does not restore a credential that a claim removed since the first run", async () => {
    const db = createMemoryAdapter();
    await importUsers(db, listSource(records()), { now });
    const u2 = await importId("user", "supabase", "u2");
    // A claim of the unverified u2, as core's claimEmail writes it: the flag
    // first, then the claimant's credentials go, then the owner's email identity.
    await db.update("user", [{ field: "id", op: "eq", value: u2 }], {
      emailVerified: true,
      updatedAt: AT,
    });
    await db.delete("password", [{ field: "userId", op: "eq", value: u2 }]);
    await db.create("identity", {
      id: "claim-email",
      userId: u2,
      provider: "email",
      subject: "u2@example.com",
      linkedAt: AT,
      createdAt: AT,
      updatedAt: AT,
    });
    const again = await importUsers(db, listSource(records()), { now });
    expect(await db.findMany("password", [{ field: "userId", op: "eq", value: u2 }])).toEqual([]);
    // The app changed the user since the first run, so it is not a half record.
    expect(again.partial).toEqual([]);
    expect(again.exists.user).toBe(3);
  });

  it("never rewrites a password row that a sign-in rehashed since the first run", async () => {
    const db = createMemoryAdapter();
    const export_ = () => [
      user("m", { password: { hash: LEGACY_VERIFY_HASH } }),
      user("b", { password: { hash: BCRYPT } }),
    ];
    await importUsers(db, listSource(export_()), { now, legacyVerify: true });
    // A sign-in (the legacy check, or a bcrypt match) rehashes each row to PBKDF2.
    const ids = [await importId("user", "supabase", "m"), await importId("user", "supabase", "b")];
    const seam = createPbkdf2PasswordHash();
    for (const userId of ids) {
      await db.update("password", [{ field: "userId", op: "eq", value: userId }], {
        hash: await seam.hash("the user's password"),
        updatedAt: AT,
      });
    }
    const before = await db.findMany("password", []);
    expect(before.map((p) => p.hash.startsWith("$"))).toEqual([false, false]);
    const again = await importUsers(db, listSource(export_()), { now, legacyVerify: true });
    expect(again.exists.user).toBe(2);
    expect(again.created.password).toBe(0);
    expect(await db.findMany("password", [])).toEqual(before);
  });

  it("never writes a password over an app user that holds the address", async () => {
    const db = createMemoryAdapter();
    // A password sign-up of the app: the user row and its PBKDF2 password row.
    await appUser(db, "app-1", "u1@example.com", false);
    const before = await db.findMany("password", []);
    const r = await importUsers(
      db,
      listSource([user("u1", { password: { hash: LEGACY_VERIFY_HASH } })]),
      { now, legacyVerify: true },
    );
    expect(r.skipped).toEqual([{ kind: "user", sourceId: "u1", reason: "email_taken" }]);
    expect(await db.findMany("password", [])).toEqual(before);
  });

  it("writes nothing on a dry run, and reports what a real run reports", async () => {
    const db = createMemoryAdapter();
    const dry = await importUsers(db, listSource(records()), { now, dryRun: true });
    expect(await snapshot(db)).toEqual(await snapshot(createMemoryAdapter()));
    const real = await importUsers(db, listSource(records()), { now });
    expect({ ...dry, dryRun: false }).toEqual(real);
  });

  it("skips a taken address and never merges, or stops the run with onEmailTaken fail", async () => {
    const db = createMemoryAdapter();
    await appUser(db, "app-1", "u1@example.com", true);
    const skip = await importUsers(db, listSource(records()), { now });
    expect(skip.skipped[0]).toEqual({ kind: "user", sourceId: "u1", reason: "email_taken" });
    // The app user keeps only the identity it had: nothing from u1 is merged into it.
    expect(
      (await db.findMany("identity", [{ field: "userId", op: "eq", value: "app-1" }])).map(
        (i) => `${i.provider}:${i.subject}`,
      ),
    ).toEqual(["email:u1@example.com"]);
    expect(await db.findMany("password", [{ field: "userId", op: "eq", value: "app-1" }])).toEqual(
      [],
    );
    const fresh = createMemoryAdapter();
    await appUser(fresh, "app-1", "u2@example.com", true);
    const err = await importUsers(fresh, listSource(records()), {
      now,
      onEmailTaken: "fail",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ImportConflictError);
    expect(err.reason).toBe("email_taken");
    expect(err.report.created.user).toBe(1);
    expect(await fresh.findMany("user", [])).toHaveLength(2);
  });

  it("skips a record whose social identity belongs to another account", async () => {
    const db = createMemoryAdapter();
    // A social sign-in of the app: the user row first, then its identities.
    await appUser(db, "app-1", "app-1@example.com", true, [{ provider: "google", subject: "g-1" }]);
    const r = await importUsers(db, listSource(records()), { now });
    expect(r.skipped[0]).toEqual({ kind: "user", sourceId: "u1", reason: "identity_taken" });
    expect(r.skipped.find((s) => s.kind === "organization")).toEqual({
      kind: "organization",
      sourceId: "o1",
      reason: "no_owner",
    });
  });

  it("imports an unverified source row as unverified, never verified (Review Focus 2)", async () => {
    const db = createMemoryAdapter();
    await importUsers(
      db,
      listSource([
        user("u7", { emailVerified: false, identities: [{ provider: "google", subject: "g-7" }] }),
      ]),
      { now },
    );
    const u = await db.findMany("user", []);
    expect(u.map((x) => x.emailVerified)).toEqual([false]);
    expect((await db.findMany("identity", [])).map((i) => i.provider)).toEqual(["google"]);
  });

  it("refuses a hash format the app does not verify, and the marker unless the app sets legacyVerify", async () => {
    const db = createMemoryAdapter();
    const r = await importUsers(
      db,
      listSource([
        user("a", { password: { hash: BCRYPT } }),
        user("b", { password: { hash: LEGACY_VERIFY_HASH } }),
      ]),
      { now, formats: ["argon2id"] },
    );
    expect(r.refusedHashes).toEqual([
      { sourceId: "a", format: "bcrypt" },
      { sourceId: "b", format: "legacy-verify" },
    ]);
    expect(await db.findMany("password", [])).toEqual([]);
    const ok = await importUsers(
      createMemoryAdapter(),
      listSource([user("b", { password: { hash: LEGACY_VERIFY_HASH } })]),
      { now, legacyVerify: true },
    );
    expect(ok.created.password).toBe(1);
  });

  it("maps roles, lists an unknown role as member, promotes the first admin, and needs an owner", async () => {
    const db = createMemoryAdapter();
    const r = await importUsers(
      db,
      listSource(
        [
          user("a"),
          user("b"),
          org("o1", [
            { userSourceId: "a", roles: ["org:member"] },
            { userSourceId: "b", roles: ["org:admin", "billing"] },
          ]),
          org("o2", [{ userSourceId: "a", roles: ["billing"] }]),
          org("o3", [{ userSourceId: "a", roles: ["org:admin"] }], { slug: "admin" }),
        ],
        { "org:admin": "admin", "org:member": "member" },
      ),
      { now },
    );
    const b = await importId("user", "supabase", "b");
    expect(
      (await db.findMany("member", [])).map((m) => [m.userId === b ? "b" : "a", m.role]).sort(),
    ).toEqual([
      ["a", "member"],
      ["b", "owner"],
    ]);
    expect(r.dropped).toEqual([
      { sourceId: "o1", item: "role:billing->member" },
      { sourceId: "o1", item: `promoted_owner:${b}` },
    ]);
    expect(r.skipped).toEqual([
      { kind: "organization", sourceId: "o2", reason: "no_owner" },
      { kind: "organization", sourceId: "o3", reason: "reserved_slug" },
    ]);
  });

  it("retries a record once after a unique_violation from a concurrent sign-up, outside the transaction", async () => {
    const db = createMemoryAdapter();
    let raced = false;
    const racing: StorageAdapter = {
      ...db,
      transaction: async (fn) => {
        if (!raced) {
          raced = true;
          // An app password sign-up takes the address between the importer's read and its write.
          return db.transaction(async (tx) => {
            const wrapped: StorageAdapter = {
              ...tx,
              create: async (model, data) => {
                if (model === "user") await appUser(db, "app-1", "u1@example.com", false);
                return tx.create(model, data);
              },
            };
            return fn(wrapped);
          });
        }
        return db.transaction(fn);
      },
    };
    const r = await importUsers(racing, listSource([user("u1")]), { now });
    expect(r.skipped).toEqual([{ kind: "user", sourceId: "u1", reason: "email_taken" }]);
    expect((await db.findMany("user", [])).map((u) => u.id)).toEqual(["app-1"]);
  });

  it("keeps names inside core's rules: drops an invalid user name, skips an invalid organization name", async () => {
    const db = createMemoryAdapter();
    const r = await importUsers(
      db,
      listSource([
        user("a", { name: "Ada" }),
        user("b", { name: "bad\u0000name" }),
        user("c", { name: "x".repeat(201) }),
        org("o1", [{ userSourceId: "a", roles: ["owner"] }], { name: "", slug: "one" }),
        org("o2", [{ userSourceId: "a", roles: ["owner"] }], { name: "y".repeat(121) }),
        org("o3", [{ userSourceId: "a", roles: ["owner"] }], { name: "Tab\there", slug: "three" }),
        org("o4", [{ userSourceId: "a", roles: ["owner"] }], { name: "z".repeat(120) }),
      ]),
      { now },
    );
    const names = await Promise.all(
      ["a", "b", "c"].map(async (s) => {
        const id = await importId("user", "supabase", s);
        return (await db.findOne("user", [{ field: "id", op: "eq", value: id }]))?.name;
      }),
    );
    expect(names).toEqual(["Ada", null, null]);
    expect(r.dropped).toEqual([
      { sourceId: "b", item: "name:invalid" },
      { sourceId: "c", item: "name:invalid" },
    ]);
    expect(r.skipped).toEqual([
      { kind: "organization", sourceId: "o1", reason: "invalid_name" },
      { kind: "organization", sourceId: "o2", reason: "invalid_name" },
      { kind: "organization", sourceId: "o3", reason: "invalid_name" },
    ]);
    expect((await db.findMany("organization", [])).map((o) => o.name)).toEqual(["z".repeat(120)]);
  });
});
