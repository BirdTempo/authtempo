import { createMemoryAdapter } from "@tempo-auth/core";
import { describe, expect, it } from "vitest";
import { importUsers } from "../../src/import.js";
import { clerkSource } from "../../src/readers/clerk.js";
import { all, now } from "./all.js";

// Shapes: Clerk migration tool samples/clerk.csv and the Backend API spec 2026-05-12, read 2026-10-11.
// Unverified, checked by owner runbook item 3: the unit of created_at (both
// milliseconds and seconds are here), the password_hasher values of a real
// export, and the banned field.
const CLERK_CSV = `id,first_name,last_name,username,primary_email_address,primary_phone_number,verified_email_addresses,unverified_email_addresses,verified_phone_numbers,unverified_phone_numbers,totp_secret,password_digest,password_hasher
user_2a,Kim,Lee,,kim@example.com,,kim@example.com,,,,,$2b$10$U4C0ZY8OG8y41F9LusfKyu3HRMBL0rCZcKBVsXhgr.n8Ou6FPhzO2,bcrypt
user_2b,Max,,,max@example.com,,,max@example.com,,,,abc,md5
user_2c,Orphan,,,orphan@example.com,,orphan@example.com,,,,,,
`;
const CLERK_USERS = JSON.stringify([
  {
    id: "user_2a",
    first_name: "Kim",
    last_name: "Lee",
    image_url: "https://img.clerk.com/kim",
    primary_email_address_id: "idn_1",
    email_addresses: [
      { id: "idn_1", email_address: "kim@example.com", verification: { status: "verified" } },
    ],
    external_accounts: [
      { provider: "oauth_google", provider_user_id: "g-77" },
      { provider: "oauth_github", provider_user_id: "gh-77" },
    ],
    passkeys: [{ id: "pk_1", name: "Laptop" }],
    password_enabled: true,
    created_at: 1700000000000,
  },
  {
    id: "user_2b",
    primary_email_address_id: "idn_2",
    // A verified secondary address first: only the primary one counts (review I-2).
    email_addresses: [
      { id: "idn_9", email_address: "old@example.com", verification: { status: "verified" } },
      { id: "idn_2", email_address: "max@example.com", verification: { status: "expired" } },
    ],
    external_accounts: [],
    password_enabled: true,
    created_at: 1700000001000,
  },
  // The CSV says user_2A is not user_2a: no case fold (Review Focus 5).
  {
    id: "user_2A",
    primary_email_address_id: null,
    email_addresses: [],
    password_enabled: true,
    created_at: 1,
  },
]);
const CLERK_ORGS = JSON.stringify([
  {
    id: "org_1",
    name: "Acme",
    slug: "acme",
    created_at: 1700000002000,
    memberships: [
      { role: "org:admin", public_user_data: { user_id: "user_2a" } },
      { role: "org:billing", public_user_data: { user_id: "user_2b" } },
    ],
  },
  // No name: the reader passes no default, and the importer skips it (ruling I-5).
  {
    id: "org_2",
    slug: "nameless",
    created_at: 1700000003000,
    memberships: [{ role: "org:admin", public_user_data: { user_id: "user_2a" } }],
  },
]);

describe("clerkSource", () => {
  it("joins the CSV and the API JSON on the exact id", async () => {
    const r = await all(
      clerkSource({ csv: CLERK_CSV, users: CLERK_USERS, organizations: CLERK_ORGS }),
    );
    expect(r[0]).toEqual({
      kind: "user",
      sourceId: "user_2a",
      email: "kim@example.com",
      emailVerified: true,
      name: "Kim Lee",
      image: "https://img.clerk.com/kim",
      createdAt: new Date(1700000000000),
      identities: [
        { provider: "google", subject: "g-77" },
        { provider: "github", subject: "gh-77" },
      ],
      password: { hash: "$2b$10$U4C0ZY8OG8y41F9LusfKyu3HRMBL0rCZcKBVsXhgr.n8Ou6FPhzO2" },
      passkeys: [],
      dropped: ["passkey:no_public_key"],
    });
    expect(r[1]).toMatchObject({
      sourceId: "user_2b",
      email: "max@example.com",
      emailVerified: false,
      password: { refused: "md5" },
    });
    // An API user with no CSV row: the two files disagree (ruling M-3).
    expect(r[2]).toMatchObject({ sourceId: "user_2A", password: null, skip: "unmatched_row" });
    expect(r[3]).toMatchObject({ sourceId: "user_2c", skip: "unmatched_row" });
    expect(r[4]).toMatchObject({
      kind: "organization",
      slug: "acme",
      members: [
        { userSourceId: "user_2a", roles: ["org:admin"] },
        { userSourceId: "user_2b", roles: ["org:billing"] },
      ],
    });
    expect(r[5]).toMatchObject({ kind: "organization", sourceId: "org_2", name: null });
  });

  it("makes an org admin the owner and drops the unverified member", async () => {
    const db = createMemoryAdapter();
    const report = await importUsers(
      db,
      clerkSource({ csv: CLERK_CSV, users: CLERK_USERS, organizations: CLERK_ORGS }),
      { now },
    );
    expect((await db.findMany("member", [])).map((m) => m.role)).toEqual(["owner"]);
    expect(report.skipped).toContainEqual({
      kind: "member",
      sourceId: "user_2b",
      reason: "user_unverified",
    });
    for (const id of ["user_2A", "user_2c"])
      expect(report.skipped).toContainEqual({
        kind: "user",
        sourceId: id,
        reason: "unmatched_row",
      });
    expect(report.skipped).toContainEqual({
      kind: "organization",
      sourceId: "org_2",
      reason: "invalid_name",
    });
    // The verified user gets the email identity through the importer; the unverified one none (ruling M-4).
    expect(
      (await db.findMany("identity", [])).map((i) => `${i.provider}:${i.subject}`).sort(),
    ).toEqual(["email:kim@example.com", "google:g-77"]);
    expect(report.dropped).toContainEqual({ sourceId: "user_2a", item: "identity:github" });
    expect(report.dropped).toContainEqual({ sourceId: "user_2a", item: "passkey:no_public_key" });
  });
});

// Edge rows (review I-1 and M-1 to M-5), same shapes and date as above.
const HASH_OLD = "$2b$10$U4C0ZY8OG8y41F9LusfKyu3HRMBL0rCZcKBVsXhgr.n8Ou6FPhzO2";
const HASH_NEW = "$2b$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga";
const EDGE_CSV = `id,primary_email_address,password_digest,password_hasher
dup_csv,dc@example.com,${HASH_NEW},bcrypt
dup_csv,dc@example.com,${HASH_OLD},bcrypt
dup_api,da@example.com,${HASH_NEW},bcrypt
nodigest,nd@example.com,,
banned,ban@example.com,,
seconds,sec@example.com,,
noid,noid@example.com,,
`;
const verified = (email: string) => [
  { id: `idn_${email}`, email_address: email, verification: { status: "verified" } },
];
const EDGE_USERS = JSON.stringify([
  {
    id: "dup_csv",
    primary_email_address_id: "idn_dc@example.com",
    email_addresses: verified("dc@example.com"),
    password_enabled: true,
    created_at: 1700000000000,
  },
  {
    id: "dup_api",
    primary_email_address_id: "idn_da@example.com",
    email_addresses: verified("da@example.com"),
    password_enabled: true,
  },
  {
    id: "dup_api",
    primary_email_address_id: "idn_da@example.com",
    email_addresses: verified("da@example.com"),
    password_enabled: true,
  },
  {
    id: "nodigest",
    primary_email_address_id: "idn_nd@example.com",
    email_addresses: verified("nd@example.com"),
    password_enabled: true,
  },
  {
    id: "banned",
    primary_email_address_id: "idn_ban@example.com",
    email_addresses: verified("ban@example.com"),
    banned: "true",
  },
  {
    id: "seconds",
    primary_email_address_id: "idn_sec@example.com",
    email_addresses: verified("sec@example.com"),
    created_at: 1700000000,
  },
  // A null primary id and an address with no id (review M-1).
  {
    id: "noid",
    primary_email_address_id: null,
    email_addresses: [{ email_address: "noid@example.com", verification: { status: "verified" } }],
  },
]);

describe("clerkSource edge rows", () => {
  it("skips every copy of a duplicate id, fails a ban closed, reads seconds, and matches no null primary", async () => {
    const r = await all(clerkSource({ csv: EDGE_CSV, users: EDGE_USERS }));
    const by = (id: string) => r.filter((x) => x.kind === "user" && x.sourceId === id);
    expect(by("dup_csv")).toEqual([
      expect.objectContaining({ skip: "duplicate_row", password: null }),
    ]);
    expect(by("dup_api")).toEqual([
      expect.objectContaining({ skip: "duplicate_row", password: null }),
      expect.objectContaining({ skip: "duplicate_row", password: null }),
    ]);
    expect(by("nodigest")).toEqual([
      expect.objectContaining({ password: { refused: "missing (the CSV row has no digest)" } }),
    ]);
    expect(by("nodigest")[0]).not.toHaveProperty("skip");
    expect(by("banned")).toEqual([expect.objectContaining({ skip: "banned" })]);
    expect(by("seconds")).toEqual([
      expect.objectContaining({ createdAt: new Date(1700000000000) }),
    ]);
    expect(by("noid")).toEqual([expect.objectContaining({ email: null, emailVerified: false })]);
  });

  it("imports none of them but the missing-digest user, and reports the refusal", async () => {
    const db = createMemoryAdapter();
    const report = await importUsers(db, clerkSource({ csv: EDGE_CSV, users: EDGE_USERS }), {
      now,
    });
    expect((await db.findMany("user", [])).map((u) => u.email).sort()).toEqual([
      "nd@example.com",
      "sec@example.com",
    ]);
    expect(await db.findMany("password", [])).toEqual([]);
    expect(report.refusedHashes).toEqual([
      { sourceId: "nodigest", format: "missing (the CSV row has no digest)" },
    ]);
    expect(report.skipped).toContainEqual({ kind: "user", sourceId: "noid", reason: "no_email" });
    for (const id of ["dup_csv", "dup_api"])
      expect(report.skipped).toContainEqual({
        kind: "user",
        sourceId: id,
        reason: "duplicate_row",
      });
  });

  it("refuses a users or organizations value that is not an array", async () => {
    const wrapped = JSON.stringify({ data: [], total_count: 0 });
    await expect(all(clerkSource({ csv: EDGE_CSV, users: wrapped }))).rejects.toThrow(
      "the Clerk users input is not a JSON array",
    );
    await expect(
      all(clerkSource({ csv: EDGE_CSV, users: EDGE_USERS, organizations: wrapped })),
    ).rejects.toThrow("the Clerk organizations input is not a JSON array");
  });
});
