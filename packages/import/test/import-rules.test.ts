import {
  createAuth,
  createMemoryAdapter,
  createPbkdf2PasswordHash,
  type StorageAdapter,
} from "@tempo-auth/core";
import { createLegacyPasswordHash, LEGACY_FORMATS } from "@tempo-auth/legacy-hashes";
import { describe, expect, it } from "vitest";
import { importId } from "../src/ids.js";
import { importUsers } from "../src/import.js";
import type { ImportPasskey, ImportRecord, Source, SourceName } from "../src/types.js";
import { AT, appUser, BCRYPT, listSource, org, user } from "./source.js";

const now = () => AT;

function named(name: SourceName, records: ImportRecord[]): Source {
  return {
    name,
    roles: {},
    async *records() {
      yield* records;
    },
  };
}

function passkey(credentialId: string): ImportPasskey {
  return {
    credentialId,
    publicKey: `key-${credentialId}`,
    counter: 7,
    transports: "internal,hybrid",
    deviceType: "multiDevice",
    backedUp: true,
    name: "Laptop",
  };
}

/** A dry run on a fresh database, then a real run on another: the two reports must agree. */
async function dryAndReal(source: () => Source) {
  const dry = await importUsers(createMemoryAdapter(), source(), {
    formats: LEGACY_FORMATS,
    now,
    dryRun: true,
  });
  const db = createMemoryAdapter();
  const real = await importUsers(db, source(), { formats: LEGACY_FORMATS, now });
  return { dry, real, db };
}

describe("importUsers: reserved slugs (I-1, M-3)", () => {
  it("reserves the app's platform organization slug", async () => {
    const r = await importUsers(
      createMemoryAdapter(),
      listSource([
        user("a"),
        org("o1", [{ userSourceId: "a", roles: ["owner"] }], { name: "Staff" }),
        org("o2", [{ userSourceId: "a", roles: ["owner"] }], { name: "Other", slug: "STAFF" }),
      ]),
      { formats: LEGACY_FORMATS, now, platformSlug: "Staff" },
    );
    expect(r.skipped).toEqual([
      { kind: "organization", sourceId: "o1", reason: "reserved_slug" },
      { kind: "organization", sourceId: "o2", reason: "reserved_slug" },
    ]);
    expect(r.refusals).toBe(2);
    expect(r.created.organization).toBe(0);
  });

  it("reserves the app's own entries in addition to core's defaults", async () => {
    const r = await importUsers(
      createMemoryAdapter(),
      listSource([
        user("a"),
        org("o1", [{ userSourceId: "a", roles: ["owner"] }], { name: "Acme" }),
        org("o2", [{ userSourceId: "a", roles: ["owner"] }], { name: "Admin" }),
        org("o3", [{ userSourceId: "a", roles: ["owner"] }], { name: "Free" }),
      ]),
      { formats: LEGACY_FORMATS, now, reservedSlugs: ["acme"] },
    );
    expect(r.skipped).toEqual([
      { kind: "organization", sourceId: "o1", reason: "reserved_slug" },
      { kind: "organization", sourceId: "o2", reason: "reserved_slug" },
    ]);
    expect(r.created.organization).toBe(1);
  });

  it("stops before any read when a reserved or platform slug is not a slug", async () => {
    await expect(
      importUsers(createMemoryAdapter(), listSource([]), {
        formats: LEGACY_FORMATS,
        now,
        platformSlug: "not a slug",
      }),
    ).rejects.toThrow(/not a slug: not a slug/);
    await expect(
      importUsers(createMemoryAdapter(), listSource([]), {
        formats: LEGACY_FORMATS,
        now,
        reservedSlugs: ["a b"],
      }),
    ).rejects.toThrow(/not a slug: a b/);
  });
});

describe("importUsers: passkeys (I-2)", () => {
  it("writes a verified Auth.js user's passkey, and drops one that is unverified, taken, or from another source", async () => {
    const db = createMemoryAdapter();
    const r = await importUsers(
      db,
      named("authjs", [
        user("v", { passkeys: [passkey("P1")] }),
        user("w", { emailVerified: false, password: { hash: BCRYPT }, passkeys: [passkey("P2")] }),
        user("x", { passkeys: [passkey("P1")] }),
      ]),
      { formats: LEGACY_FORMATS, now },
    );
    expect(r.created.passkey).toBe(1);
    expect(r.dropped).toEqual([
      { sourceId: "w", item: "passkey:unverified" },
      { sourceId: "x", item: "passkey:taken" },
    ]);
    const v = await importId("user", "authjs", "v");
    const rows = await db.findMany("passkey", []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: v, ...passkey("P1"), createdAt: AT, updatedAt: AT });

    const other = createMemoryAdapter();
    const s = await importUsers(other, listSource([user("v", { passkeys: [passkey("P1")] })]), {
      formats: LEGACY_FORMATS,
      now,
    });
    expect(s.dropped).toEqual([{ sourceId: "v", item: "passkey:not_authjs" }]);
    expect(await other.findMany("passkey", [])).toEqual([]);
  });

  it("imports an unverified user whose dropped passkeys repeat a verified user's credential", async () => {
    const db = createMemoryAdapter();
    const r = await importUsers(
      db,
      named("authjs", [
        user("w", {
          emailVerified: false,
          password: { hash: BCRYPT },
          passkeys: [passkey("P1"), passkey("P1")],
        }),
        user("v", { passkeys: [passkey("P1")] }),
      ]),
      { formats: LEGACY_FORMATS, now },
    );
    expect(r.skipped).toEqual([]);
    expect(r.created).toMatchObject({ user: 2, passkey: 1 });
    expect(r.dropped).toEqual([
      { sourceId: "w", item: "passkey:unverified" },
      { sourceId: "w", item: "passkey:unverified" },
    ]);
    const v = await importId("user", "authjs", "v");
    expect((await db.findMany("passkey", [])).map((p) => [p.userId, p.credentialId])).toEqual([
      [v, "P1"],
    ]);
  });

  it("skips a record that holds one credential twice, and the run goes on", async () => {
    const records = () =>
      named("authjs", [user("d", { passkeys: [passkey("P1"), passkey("P1")] }), user("e")]);
    const { dry, real, db } = await dryAndReal(records);
    expect(real.skipped).toEqual([{ kind: "user", sourceId: "d", reason: "duplicate_passkey" }]);
    expect(real.created.user).toBe(1);
    expect({ ...dry, dryRun: false }).toEqual(real);
    expect(await db.findMany("passkey", [])).toEqual([]);
  });

  it("skips a record whose passkey write races twice, outside the transaction, and keeps the report", async () => {
    const db = createMemoryAdapter();
    await appUser(db, "app-1", "app-1@example.com", true);
    let attempts = 0;
    const racing: StorageAdapter = {
      ...db,
      transaction: async (fn) => {
        if (attempts >= 2) return db.transaction(fn);
        attempts++;
        // A passkey registration of the app takes the credential between the importer's read and its write.
        return db.transaction(async (tx) =>
          fn({
            ...tx,
            create: async (model, data) => {
              if (model === "passkey") {
                const credentialId = (data as { credentialId: string }).credentialId;
                await db.create("passkey", {
                  ...passkey(credentialId),
                  id: `race-${credentialId}`,
                  userId: "app-1",
                  createdAt: AT,
                  updatedAt: AT,
                });
              }
              return tx.create(model, data);
            },
          }),
        );
      },
    };
    const r = await importUsers(
      racing,
      named("authjs", [user("p", { passkeys: [passkey("P1"), passkey("P2")] }), user("q")]),
      { formats: LEGACY_FORMATS, now },
    );
    expect(r.skipped).toEqual([{ kind: "user", sourceId: "p", reason: "duplicate_passkey" }]);
    expect(r.created.user).toBe(1);
    const p = await importId("user", "authjs", "p");
    expect(await db.findOne("user", [{ field: "id", op: "eq", value: p }])).toBeNull();
  });
});

describe("importUsers: a half record (I-3)", () => {
  it("lists a user that exists by its id without its rows as partial, never as exists, and repairs nothing", async () => {
    const db = createMemoryAdapter();
    const record = user("u1", {
      identities: [{ provider: "google", subject: "g-1" }],
      password: { hash: BCRYPT },
    });
    // A run on D1 that stopped after the user row: the isolate died, so no undo ran (spec 6).
    await db.create("user", {
      id: await importId("user", "supabase", "u1"),
      email: "u1@example.com",
      emailVerified: true,
      name: null,
      image: null,
      createdAt: AT,
      updatedAt: AT,
    });
    const r = await importUsers(db, listSource([record]), { formats: LEGACY_FORMATS, now });
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "u1", missing: ["identity:email", "identity:google", "password"] },
    ]);
    expect(r.exists.user).toBe(0);
    expect(await db.findMany("identity", [])).toEqual([]);
    expect(await db.findMany("password", [])).toEqual([]);
    const dry = await importUsers(db, listSource([record]), {
      formats: LEGACY_FORMATS,
      now,
      dryRun: true,
    });
    expect(dry.partial).toEqual(r.partial);
  });

  it("lists an organization with no member row as partial", async () => {
    const db = createMemoryAdapter();
    await importUsers(db, listSource([user("a")]), { formats: LEGACY_FORMATS, now });
    await db.create("organization", {
      id: await importId("organization", "supabase", "o1"),
      slug: "org-o1",
      name: "Org o1",
      metadata: null,
      createdAt: AT,
      updatedAt: AT,
    });
    const r = await importUsers(
      db,
      listSource([user("a"), org("o1", [{ userSourceId: "a", roles: ["owner"] }])]),
      { formats: LEGACY_FORMATS, now },
    );
    expect(r.partial).toEqual([{ kind: "organization", sourceId: "o1", missing: ["member"] }]);
    expect(r.exists).toEqual({ user: 1, organization: 0 });
    expect(await db.findMany("member", [])).toEqual([]);
  });
});

describe("importUsers: records the review named (M-1, M-3, M-4, M-5)", () => {
  it("treats constructor and __proto__ as unknown roles", async () => {
    const db = createMemoryAdapter();
    const r = await importUsers(
      db,
      listSource([
        user("a"),
        user("b"),
        org("o1", [
          { userSourceId: "a", roles: ["owner"] },
          { userSourceId: "b", roles: ["constructor", "__proto__"] },
        ]),
      ]),
      { formats: LEGACY_FORMATS, now },
    );
    expect(r.dropped).toEqual([
      { sourceId: "o1", item: "role:constructor->member" },
      { sourceId: "o1", item: "role:__proto__->member" },
    ]);
    expect((await db.findMany("member", [])).map((m) => m.role).sort()).toEqual([
      "member",
      "owner",
    ]);
  });

  it("stops before any read when a role map names a role core does not have", async () => {
    await expect(
      importUsers(createMemoryAdapter(), listSource([]), {
        formats: LEGACY_FORMATS,
        now,
        roleMap: JSON.parse('{"org:boss": "superuser"}'),
      }),
    ).rejects.toThrow(/role org:boss maps to superuser/);
  });

  it("skips the second of two records with one address, in a dry run as in a real run", async () => {
    const { dry, real } = await dryAndReal(() =>
      listSource([
        user("a", { email: "same@example.com" }),
        user("b", { email: "Same@Example.com" }),
      ]),
    );
    expect(real.skipped).toEqual([{ kind: "user", sourceId: "b", reason: "email_taken" }]);
    expect({ ...dry, dryRun: false }).toEqual(real);
  });

  it("skips the second of two records with one social identity, in a dry run as in a real run", async () => {
    const google = [{ provider: "google", subject: "g-same" }];
    const { dry, real } = await dryAndReal(() =>
      listSource([user("a", { identities: google }), user("b", { identities: google })]),
    );
    expect(real.skipped).toEqual([{ kind: "user", sourceId: "b", reason: "identity_taken" }]);
    expect({ ...dry, dryRun: false }).toEqual(real);
  });

  it("reports a hash the reader refused and imports the user with no password", async () => {
    const db = createMemoryAdapter();
    const r = await importUsers(
      db,
      listSource([user("f", { password: { refused: "firebase-scrypt (no project key given)" } })]),
      { formats: LEGACY_FORMATS, now },
    );
    expect(r.refusedHashes).toEqual([
      { sourceId: "f", format: "firebase-scrypt (no project key given)" },
    ]);
    expect(r.created).toMatchObject({ user: 1, password: 0 });
    expect(await db.findMany("password", [])).toEqual([]);
  });

  it("keeps an https image of at most 2048 characters and drops any other", async () => {
    const db = createMemoryAdapter();
    const long = `https://example.com/${"a".repeat(2048 - 20)}`;
    const r = await importUsers(
      db,
      listSource([
        user("a", { image: "https://example.com/a.png" }),
        user("b", { image: long }),
        user("c", { image: `${long}a` }),
        user("d", { image: "http://example.com/d.png" }),
        user("e", { image: "javascript:alert(1)" }),
        user("f", { image: "not a url" }),
      ]),
      { formats: LEGACY_FORMATS, now },
    );
    const images = await Promise.all(
      ["a", "b", "c", "d", "e", "f"].map(async (s) => {
        const id = await importId("user", "supabase", s);
        return (await db.findOne("user", [{ field: "id", op: "eq", value: id }]))?.image;
      }),
    );
    expect(long).toHaveLength(2048);
    expect(images).toEqual(["https://example.com/a.png", long, null, null, null, null]);
    expect(r.dropped).toEqual(
      ["c", "d", "e", "f"].map((sourceId) => ({ sourceId, item: "image:invalid" })),
    );
  });

  it("counts every invalid_ and reserved_ skip as a refusal, and no other skip", async () => {
    const db = createMemoryAdapter();
    await appUser(db, "app-1", "taken@example.com", true);
    const r = await importUsers(
      db,
      listSource([
        user("a"),
        user("t", { email: "taken@example.com" }),
        org("o1", [{ userSourceId: "a", roles: ["owner"] }], { name: "株式会社テンポ" }),
        org("o2", [{ userSourceId: "a", roles: ["owner"] }], { name: "" }),
        org("o3", [{ userSourceId: "a", roles: ["owner"] }], { name: "Admin" }),
        org("o4", [{ userSourceId: "b", roles: ["owner"] }], { name: "Lost" }),
        org("o5", [{ userSourceId: "a", roles: ["owner"] }], { name: "Tempo", slug: "tempo" }),
        // A reader that finds no name in the export gives null, never "".
        org("o6", [{ userSourceId: "a", roles: ["owner"] }], { name: null, slug: "six" }),
      ]),
      { formats: LEGACY_FORMATS, now },
    );
    expect(r.skipped).toEqual([
      { kind: "user", sourceId: "t", reason: "email_taken" },
      { kind: "organization", sourceId: "o1", reason: "invalid_slug" },
      { kind: "organization", sourceId: "o2", reason: "invalid_name" },
      { kind: "organization", sourceId: "o3", reason: "reserved_slug" },
      { kind: "organization", sourceId: "o4", reason: "no_owner" },
      { kind: "organization", sourceId: "o6", reason: "invalid_name" },
    ]);
    expect(r.refusals).toBe(4);
    expect((await db.findMany("organization", [])).map((o) => o.slug)).toEqual(["tempo"]);
  });
});

describe("importUsers: GitHub and LinkedIn identities (plan 9b2)", () => {
  it("keeps a GitHub numeric id and a LinkedIn sub, and drops and lists any other form", async () => {
    const db = createMemoryAdapter();
    const r = await importUsers(
      db,
      listSource([
        user("a", {
          identities: [
            { provider: "github", subject: "583231" },
            { provider: "linkedin", subject: "782bbtaQ" },
          ],
        }),
        user("b", {
          identities: [
            { provider: "github", subject: "octocat" },
            { provider: "github", subject: "0583231" },
            { provider: "github", subject: "9007199254740993" },
            { provider: "linkedin_legacy", subject: "yrZCpj2Z12" },
          ],
        }),
      ]),
      { formats: LEGACY_FORMATS, now },
    );
    const a = await importId("user", "supabase", "a");
    expect(
      (await db.findMany("identity", [{ field: "userId", op: "eq", value: a }]))
        .map((i) => `${i.provider}:${i.subject}`)
        .sort(),
    ).toEqual(["email:a@example.com", "github:583231", "linkedin:782bbtaQ"]);
    expect(r.dropped).toEqual([
      { sourceId: "b", item: "identity:github:subject_form" },
      { sourceId: "b", item: "identity:github:subject_form" },
      { sourceId: "b", item: "identity:github:subject_form" },
      { sourceId: "b", item: "identity:linkedin_legacy" },
    ]);
    expect(r.created).toMatchObject({ user: 2, identity: 4 });
  });
});

describe("importUsers: the repair mode (plan 9b2)", () => {
  /** A run on D1 that stopped after the user row of `u1` (an isolate that dies does not roll back, spec 6). */
  async function halfUser(db: StorageAdapter, verified = true) {
    await db.create("user", {
      id: await importId("user", "supabase", "u1"),
      email: "u1@example.com",
      emailVerified: verified,
      name: null,
      image: null,
      createdAt: AT,
      updatedAt: AT,
    });
  }
  const half = () =>
    user("u1", {
      identities: [{ provider: "google", subject: "g-1" }],
      password: { hash: BCRYPT },
    });
  const rowsOf = async (db: StorageAdapter) => ({
    identity: (await db.findMany("identity", [])).map((i) => `${i.provider}:${i.subject}`).sort(),
    password: (await db.findMany("password", [])).map((p) => p.hash),
  });

  it("writes only the missing rows, reports them under repaired, and writes nothing on a second run", async () => {
    const db = createMemoryAdapter();
    await halfUser(db);
    const dry = await importUsers(db, listSource([half()]), {
      formats: LEGACY_FORMATS,
      now,
      repair: true,
      dryRun: true,
    });
    expect(await rowsOf(db)).toEqual({ identity: [], password: [] });
    const r = await importUsers(db, listSource([half()]), {
      formats: LEGACY_FORMATS,
      now,
      repair: true,
    });
    expect(r.repaired).toEqual([
      {
        kind: "user",
        sourceId: "u1",
        rows: ["identity:email", "identity:google", "password"],
      },
    ]);
    expect({ ...dry, dryRun: false }).toEqual(r);
    expect(r.partial).toEqual([]);
    expect(r.created.user).toBe(0);
    expect(await rowsOf(db)).toEqual({
      identity: ["email:u1@example.com", "google:g-1"],
      password: [BCRYPT],
    });
    const again = await importUsers(db, listSource([half()]), {
      formats: LEGACY_FORMATS,
      now,
      repair: true,
    });
    expect(again.repaired).toEqual([]);
    expect(again.exists.user).toBe(1);
  });

  it("writes nothing when no record has a missing row (Review Focus 3)", async () => {
    const db = createMemoryAdapter();
    const records = () => [
      user("a", { password: { hash: BCRYPT }, identities: [{ provider: "github", subject: "7" }] }),
      user("b", { emailVerified: false, password: { hash: BCRYPT } }),
      org("o1", [{ userSourceId: "a", roles: ["owner"] }]),
    ];
    await importUsers(db, listSource(records()), { formats: LEGACY_FORMATS, now });
    const before = {
      ...(await rowsOf(db)),
      users: await db.findMany("user", []),
      members: await db.findMany("member", []),
    };
    const r = await importUsers(db, listSource(records()), {
      formats: LEGACY_FORMATS,
      now: () => new Date("2026-10-13T00:00:00.000Z"),
      repair: true,
    });
    expect(r.repaired).toEqual([]);
    expect(r.partial).toEqual([]);
    expect(r.exists).toEqual({ user: 2, organization: 1 });
    expect({
      ...(await rowsOf(db)),
      users: await db.findMany("user", []),
      members: await db.findMany("member", []),
    }).toEqual(before);
  });

  it("refuses to repair a user that a claim verified since the first run", async () => {
    const db = createMemoryAdapter();
    const claimant = () => [user("u2", { emailVerified: false, password: { hash: BCRYPT } })];
    await importUsers(db, listSource(claimant()), { formats: LEGACY_FORMATS, now });
    const u2 = await importId("user", "supabase", "u2");
    // A claim, as core's claimEmail writes it: the flag first, then the
    // claimant's password goes, then the owner's email identity.
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
    const r = await importUsers(db, listSource(claimant()), {
      formats: LEGACY_FORMATS,
      now,
      repair: true,
    });
    expect(r.partial).toEqual([
      {
        kind: "user",
        sourceId: "u2",
        missing: ["password"],
        repairRefused: "verified_since_import",
      },
    ]);
    expect(r.repaired).toEqual([]);
    expect(await db.findMany("password", [])).toEqual([]);
  });

  it("refuses a second credential for an unverified user, and an identity another user holds", async () => {
    const db = createMemoryAdapter();
    // The first export: an unverified user with a password, and a verified user with no GitHub.
    await importUsers(
      db,
      listSource([user("u3", { emailVerified: false, password: { hash: BCRYPT } }), user("u4")]),
      { formats: LEGACY_FORMATS, now },
    );
    // Another user of the app signs in with GitHub 583231.
    await appUser(db, "app-1", "app-1@example.com", true, [
      { provider: "github", subject: "583231" },
    ]);
    // A newer export: u3 has a Google identity and no password; u4 has GitHub 583231.
    const r = await importUsers(
      db,
      listSource([
        user("u3", { emailVerified: false, identities: [{ provider: "google", subject: "g-3" }] }),
        user("u4", { identities: [{ provider: "github", subject: "583231" }] }),
      ]),
      { formats: LEGACY_FORMATS, now, repair: true },
    );
    expect(r.partial).toEqual([
      {
        kind: "user",
        sourceId: "u3",
        missing: ["identity:google"],
        repairRefused: "credential_exists",
      },
      {
        kind: "user",
        sourceId: "u4",
        missing: ["identity:github"],
        repairRefused: "identity_taken",
      },
    ]);
    expect(r.repaired).toEqual([]);
    expect(
      (await db.findMany("identity", [{ field: "provider", op: "ne", value: "email" }])).map(
        (i) => `${i.userId}:${i.provider}:${i.subject}`,
      ),
    ).toEqual(["app-1:github:583231"]);
  });

  it("writes the member rows of an organization with none, and refuses one with no owner", async () => {
    const db = createMemoryAdapter();
    await importUsers(db, listSource([user("a")]), { formats: LEGACY_FORMATS, now });
    for (const sourceId of ["o1", "o2"])
      await db.create("organization", {
        id: await importId("organization", "supabase", sourceId),
        slug: `org-${sourceId}`,
        name: `Org ${sourceId}`,
        metadata: null,
        createdAt: AT,
        updatedAt: AT,
      });
    const r = await importUsers(
      db,
      listSource([
        user("a"),
        org("o1", [{ userSourceId: "a", roles: ["owner"] }]),
        org("o2", [{ userSourceId: "a", roles: ["member"] }]),
      ]),
      { formats: LEGACY_FORMATS, now, repair: true },
    );
    expect(r.repaired).toEqual([{ kind: "organization", sourceId: "o1", rows: ["member"] }]);
    expect(r.partial).toEqual([
      { kind: "organization", sourceId: "o2", missing: ["member"], repairRefused: "no_owner" },
    ]);
    const o1 = await importId("organization", "supabase", "o1");
    expect((await db.findMany("member", [])).map((m) => [m.organizationId === o1, m.role])).toEqual(
      [[true, "owner"]],
    );
  });

  it("refuses in a dry run, as in a real run, an identity an earlier record takes", async () => {
    const records = () => [
      user("n1", { identities: [{ provider: "google", subject: "g-1" }] }),
      half(),
    ];
    const dryDb = createMemoryAdapter();
    await halfUser(dryDb);
    const dry = await importUsers(dryDb, listSource(records()), {
      formats: LEGACY_FORMATS,
      now,
      repair: true,
      dryRun: true,
    });
    const db = createMemoryAdapter();
    await halfUser(db);
    const r = await importUsers(db, listSource(records()), {
      formats: LEGACY_FORMATS,
      now,
      repair: true,
    });
    expect(r.partial).toEqual([
      {
        kind: "user",
        sourceId: "u1",
        missing: ["identity:email", "identity:google", "password"],
        repairRefused: "identity_taken",
      },
    ]);
    expect({ ...dry, dryRun: false }).toEqual(r);
  });

  it("refuses a credential for a verified user that holds its email identity (a claim)", async () => {
    const db = createMemoryAdapter();
    await importUsers(
      db,
      listSource([user("u2", { emailVerified: false, password: { hash: BCRYPT } })]),
      { formats: LEGACY_FORMATS, now },
    );
    const u2 = await importId("user", "supabase", "u2");
    // A claim, as core's claimEmail writes it (see the test above).
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
    // A newer export that states the user verified, with the claimant's hash.
    const r = await importUsers(db, listSource([user("u2", { password: { hash: BCRYPT } })]), {
      formats: LEGACY_FORMATS,
      now,
      repair: true,
    });
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "u2", missing: ["password"], repairRefused: "claimed" },
    ]);
    expect(r.repaired).toEqual([]);
    expect(await db.findMany("password", [])).toEqual([]);
  });

  it("refuses the old email identity of a user whose address changed in the app", async () => {
    const db = createMemoryAdapter();
    const record = () => [user("u5", { email: "a@example.com" })];
    await importUsers(db, listSource(record()), { formats: LEGACY_FORMATS, now });
    const u5 = await importId("user", "supabase", "u5");
    // An address change, as the app writes it.
    await db.update("user", [{ field: "id", op: "eq", value: u5 }], {
      email: "b@example.com",
      updatedAt: AT,
    });
    await db.delete("identity", [
      { field: "userId", op: "eq", value: u5 },
      { field: "provider", op: "eq", value: "email" },
    ]);
    await db.create("identity", {
      id: "change-email",
      userId: u5,
      provider: "email",
      subject: "b@example.com",
      linkedAt: AT,
      createdAt: AT,
      updatedAt: AT,
    });
    const r = await importUsers(db, listSource(record()), {
      formats: LEGACY_FORMATS,
      now,
      repair: true,
    });
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "u5", missing: ["identity:email"], repairRefused: "email_changed" },
    ]);
    expect(r.repaired).toEqual([]);
    expect((await db.findMany("identity", [])).map((i) => `${i.provider}:${i.subject}`)).toEqual([
      "email:b@example.com",
    ]);
  });

  it("counts a second record of a repaired user as exists, in a dry run as in a real run", async () => {
    const dryDb = createMemoryAdapter();
    await halfUser(dryDb);
    const dry = await importUsers(dryDb, listSource([half(), half()]), {
      formats: LEGACY_FORMATS,
      now,
      repair: true,
      dryRun: true,
    });
    const db = createMemoryAdapter();
    await halfUser(db);
    const r = await importUsers(db, listSource([half(), half()]), {
      formats: LEGACY_FORMATS,
      now,
      repair: true,
    });
    expect(r.repaired.map((x) => x.sourceId)).toEqual(["u1"]);
    expect(r.exists.user).toBe(1);
    expect({ ...dry, dryRun: false }).toEqual(r);
  });

  /** A verified Auth.js user row of `u1` with no other row: a run that stopped after it. */
  async function halfAuthjs(db: StorageAdapter) {
    await db.create("user", {
      id: await importId("user", "authjs", "u1"),
      email: "u1@example.com",
      emailVerified: true,
      name: null,
      image: null,
      createdAt: AT,
      updatedAt: AT,
    });
  }

  it("repairs a missing passkey row", async () => {
    const db = createMemoryAdapter();
    await halfAuthjs(db);
    const r = await importUsers(db, named("authjs", [user("u1", { passkeys: [passkey("c1")] })]), {
      formats: LEGACY_FORMATS,
      now,
      repair: true,
    });
    expect(r.repaired).toEqual([
      { kind: "user", sourceId: "u1", rows: ["identity:email", "passkey"] },
    ]);
    const u1 = await importId("user", "authjs", "u1");
    expect((await db.findMany("passkey", [])).map((p) => [p.userId, p.credentialId])).toEqual([
      [u1, "c1"],
    ]);
  });

  it("repairs no passkey in a dry run that an earlier record takes, as in a real run", async () => {
    const records = () => [
      user("n1", { passkeys: [passkey("c1")] }),
      user("u1", { passkeys: [passkey("c1")] }),
    ];
    const dryDb = createMemoryAdapter();
    await halfAuthjs(dryDb);
    const dry = await importUsers(dryDb, named("authjs", records()), {
      formats: LEGACY_FORMATS,
      now,
      repair: true,
      dryRun: true,
    });
    const db = createMemoryAdapter();
    await halfAuthjs(db);
    const r = await importUsers(db, named("authjs", records()), {
      formats: LEGACY_FORMATS,
      now,
      repair: true,
    });
    // The real run finds the credential row of n1, so u1 lacks only its email identity.
    expect(r.repaired).toEqual([{ kind: "user", sourceId: "u1", rows: ["identity:email"] }]);
    expect({ ...dry, dryRun: false }).toEqual(r);
  });

  /**
   * The memory adapter with a claim that lands inside the next transaction,
   * after the guard reads and before the first write. The claim runs outside
   * that transaction, as on D1 (no isolation) or as a second connection on
   * Postgres: the memory adapter does not make a write outside a transaction
   * wait. It is core's `claimEmail` order: the flag first, then the
   * claimant's credentials go, then the owner's email identity.
   */
  function claimBeforeFirstWrite(db: StorageAdapter, userId: string, email: string) {
    let fired = false;
    const claim = async () => {
      await db.update("user", [{ field: "id", op: "eq", value: userId }], {
        emailVerified: true,
        updatedAt: AT,
      });
      await db.delete("password", [{ field: "userId", op: "eq", value: userId }]);
      await db.delete("identity", [{ field: "userId", op: "eq", value: userId }]);
      await db.create("identity", {
        id: "claim-email",
        userId,
        provider: "email",
        subject: email,
        linkedAt: AT,
        createdAt: AT,
        updatedAt: AT,
      });
    };
    const view: StorageAdapter = {
      ...db,
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            ...tx,
            create: async (model, data) => {
              if (!fired) {
                fired = true;
                await claim();
              }
              return tx.create(model, data);
            },
          }),
        ),
    };
    return { view, fired: () => fired };
  }

  it("writes nothing when a claim lands between the guard read and the repair write (I-3)", async () => {
    const db = createMemoryAdapter();
    // A run on D1 that stopped after the user row of an unverified u1.
    await halfUser(db, false);
    const u1 = await importId("user", "supabase", "u1");
    const race = claimBeforeFirstWrite(db, u1, "u1@example.com");
    const r = await importUsers(
      race.view,
      listSource([user("u1", { emailVerified: false, password: { hash: BCRYPT } })]),
      { formats: LEGACY_FORMATS, now, repair: true },
    );
    expect(race.fired()).toBe(true);
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "u1", missing: ["password"], repairRefused: "claimed" },
    ]);
    expect(r.repaired).toEqual([]);
    // The claimant's password is not on the user that the owner now holds.
    expect(await db.findMany("password", [])).toEqual([]);
    expect(await rowsOf(db)).toEqual({ identity: ["email:u1@example.com"], password: [] });
    expect((await db.findOne("user", [{ field: "id", op: "eq", value: u1 }]))?.emailVerified).toBe(
      true,
    );
  });

  it("refuses a sign-in with the repaired password before the repair's conditional update (fix round 2)", async () => {
    const db = createMemoryAdapter();
    await halfUser(db, false);
    const u1 = await importId("user", "supabase", "u1");
    const race = claimBeforeFirstWrite(db, u1, "u1@example.com");
    // The app signs in on a view with no isolation, as on D1: its writes do
    // not wait for the repair's open transaction.
    const open: StorageAdapter = { ...db, transaction: (fn) => fn(open) };
    const auth = createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: open,
      mail: { send: async () => {} },
      password: {
        hash: createLegacyPasswordHash({
          formats: ["bcrypt"],
          next: createPbkdf2PasswordHash({ iterations: 1000 }),
        }),
      },
    });
    const pw = auth.api.password;
    if (!pw) throw new Error("the password api is missing");
    // The claimant signs in after the password row is written and before
    // the conditional update of the user row.
    let signIn: Awaited<ReturnType<typeof pw.signIn>> | null = null;
    const view: StorageAdapter = {
      ...race.view,
      transaction: (fn) =>
        race.view.transaction((tx) =>
          fn({
            ...tx,
            create: async (model, data) => {
              const row = await tx.create(model, data);
              if (model === "password")
                signIn = await pw.signIn({
                  email: "u1@example.com",
                  password: "allmine",
                  ip: null,
                  userAgent: null,
                });
              return row;
            },
          }),
        ),
    };
    const r = await importUsers(
      view,
      listSource([user("u1", { emailVerified: false, password: { hash: BCRYPT } })]),
      { formats: LEGACY_FORMATS, now, repair: true },
    );
    expect(race.fired()).toBe(true);
    expect(signIn).toMatchObject({ ok: false, code: "invalid_credentials" });
    expect(await db.findMany("session", [])).toEqual([]);
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "u1", missing: ["password"], repairRefused: "claimed" },
    ]);
    expect(await db.findMany("password", [])).toEqual([]);
  });

  it("activates the repaired password row as its last statement", async () => {
    const db = createMemoryAdapter();
    await halfUser(db, false);
    const r = await importUsers(
      db,
      listSource([user("u1", { emailVerified: false, password: { hash: BCRYPT } })]),
      { formats: LEGACY_FORMATS, now, repair: true },
    );
    expect(r.repaired).toEqual([{ kind: "user", sourceId: "u1", rows: ["password"] }]);
    expect((await db.findMany("password", [])).map((p) => p.hash)).toEqual([BCRYPT]);
  });

  it("deletes every row it wrote, by id, when an address change lands before the repair write (I-3)", async () => {
    const db = createMemoryAdapter();
    await halfUser(db);
    const u1 = await importId("user", "supabase", "u1");
    // The app changes the address of the verified u1 after the guard read and
    // before the first write. The last statement then matches zero rows too.
    let fired = false;
    const view: StorageAdapter = {
      ...db,
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            ...tx,
            create: async (model, data) => {
              if (!fired) {
                fired = true;
                await db.update("user", [{ field: "id", op: "eq", value: u1 }], {
                  email: "new@example.com",
                  updatedAt: AT,
                });
              }
              return tx.create(model, data);
            },
          }),
        ),
    };
    const r = await importUsers(view, listSource([half()]), {
      formats: LEGACY_FORMATS,
      now,
      repair: true,
    });
    expect(fired).toBe(true);
    expect(r.partial).toEqual([
      {
        kind: "user",
        sourceId: "u1",
        missing: ["identity:email", "identity:google", "password"],
        repairRefused: "claimed",
      },
    ]);
    expect(await rowsOf(db)).toEqual({ identity: [], password: [] });
  });

  it("lists the same partial rows in a dry run without repair as in a real run, for a passkey an earlier record takes (M-8)", async () => {
    const records = () => [
      user("n1", { passkeys: [passkey("c1")] }),
      user("u1", { passkeys: [passkey("c1")] }),
    ];
    const dryDb = createMemoryAdapter();
    await halfAuthjs(dryDb);
    const dry = await importUsers(dryDb, named("authjs", records()), {
      formats: LEGACY_FORMATS,
      now,
      dryRun: true,
    });
    const db = createMemoryAdapter();
    await halfAuthjs(db);
    const r = await importUsers(db, named("authjs", records()), { formats: LEGACY_FORMATS, now });
    // The real run finds the credential row of n1, so u1 lacks only its email identity.
    expect(r.partial).toEqual([{ kind: "user", sourceId: "u1", missing: ["identity:email"] }]);
    expect({ ...dry, dryRun: false }).toEqual(r);
  });

  it("repairs nothing without the option, as before", async () => {
    const db = createMemoryAdapter();
    await halfUser(db);
    const r = await importUsers(db, listSource([half()]), { formats: LEGACY_FORMATS, now });
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "u1", missing: ["identity:email", "identity:google", "password"] },
    ]);
    expect(r.repaired).toEqual([]);
    expect(await rowsOf(db)).toEqual({ identity: [], password: [] });
  });
});
