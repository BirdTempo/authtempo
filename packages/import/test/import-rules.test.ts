import { createMemoryAdapter, type StorageAdapter } from "@tempo-auth/core";
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
  const dry = await importUsers(createMemoryAdapter(), source(), { now, dryRun: true });
  const db = createMemoryAdapter();
  const real = await importUsers(db, source(), { now });
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
      { now, platformSlug: "Staff" },
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
      { now, reservedSlugs: ["acme"] },
    );
    expect(r.skipped).toEqual([
      { kind: "organization", sourceId: "o1", reason: "reserved_slug" },
      { kind: "organization", sourceId: "o2", reason: "reserved_slug" },
    ]);
    expect(r.created.organization).toBe(1);
  });

  it("stops before any read when a reserved or platform slug is not a slug", async () => {
    await expect(
      importUsers(createMemoryAdapter(), listSource([]), { now, platformSlug: "not a slug" }),
    ).rejects.toThrow(/not a slug: not a slug/);
    await expect(
      importUsers(createMemoryAdapter(), listSource([]), { now, reservedSlugs: ["a b"] }),
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
      { now },
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
      { now },
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
      { now },
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
    const r = await importUsers(db, listSource([record]), { now });
    expect(r.partial).toEqual([
      { kind: "user", sourceId: "u1", missing: ["identity:email", "identity:google", "password"] },
    ]);
    expect(r.exists.user).toBe(0);
    expect(await db.findMany("identity", [])).toEqual([]);
    expect(await db.findMany("password", [])).toEqual([]);
    const dry = await importUsers(db, listSource([record]), { now, dryRun: true });
    expect(dry.partial).toEqual(r.partial);
  });

  it("lists an organization with no member row as partial", async () => {
    const db = createMemoryAdapter();
    await importUsers(db, listSource([user("a")]), { now });
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
      { now },
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
      { now },
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
      { now },
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
      { now },
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
      { now },
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
