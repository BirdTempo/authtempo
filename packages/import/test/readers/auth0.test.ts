import { createMemoryAdapter } from "@tempo-auth/core";
import { LEGACY_FORMATS } from "@tempo-auth/legacy-hashes";
import { VECTORS } from "@tempo-auth/legacy-hashes/testing";
import { describe, expect, it } from "vitest";
import { importUsers } from "../../src/import.js";
import { auth0Source } from "../../src/readers/auth0.js";
import { all, now } from "./all.js";

// Shapes: Auth0 user profile structure and the support article on the hash export, read 2026-10-11.
// Unverified, checked by owner runbook item 4: the hash algorithm ($2b$10$ in
// every sample, never in the official docs), the hash file's field list, and
// whether user_id carries _id or alt_id.
const AUTH0_USERS = [
  {
    user_id: "auth0|o7p6",
    email: "ann@example.com",
    email_verified: true,
    created_at: "2023-05-01T10:00:00.000Z",
    name: "Ann",
    identities: [
      {
        provider: "auth0",
        user_id: "o7p6",
        connection: "Username-Password-Authentication",
        isSocial: false,
      },
    ],
  },
  {
    user_id: "google-oauth2|1035",
    email: "gus@example.com",
    email_verified: true,
    created_at: "2023-05-02T10:00:00.000Z",
    identities: [
      { provider: "google-oauth2", user_id: "1035", isSocial: true },
      { provider: "github", user_id: "99", isSocial: true },
    ],
  },
  {
    user_id: "auth0|b10c",
    email: "blocked@example.com",
    email_verified: true,
    blocked: true,
    identities: [],
  },
  { user_id: "auth0|e9e9", email: "eve@example.com", email_verified: false, identities: [] },
  // Two users that one hash line names, by _id and by alt_id (Review Focus 5).
  { user_id: "auth0|gg01", email: "gg01@example.com", email_verified: false, identities: [] },
  { user_id: "auth0|gg02", email: "gg02@example.com", email_verified: false, identities: [] },
]
  .map((u) => JSON.stringify(u))
  .join("\n");
const HASH = "$2b$10$U4C0ZY8OG8y41F9LusfKyu3HRMBL0rCZcKBVsXhgr.n8Ou6FPhzO2";
const AUTH0_HASHES = [
  { _id: { $oid: "o7p6" }, email: "ann@example.com", passwordHash: HASH },
  { _id: "e9e9", email: "mallory@example.com", passwordHash: HASH },
  { _id: "zz00", email: "nobody@example.com", passwordHash: HASH },
  { _id: "gg01", alt_id: "gg02", email: "gg01@example.com", passwordHash: HASH },
]
  .map((u) => JSON.stringify(u))
  .join("\n");
const AUTH0_ORGS = JSON.stringify([
  {
    id: "org_a",
    name: "acme-co",
    display_name: "Acme Co",
    members: [
      { user_id: "auth0|o7p6", roles: [{ id: "rol_1", name: "owner" }] },
      { user_id: "auth0|e9e9", roles: [{ id: "rol_2", name: "Editor" }] },
      // A verified member with a role core does not name (review M-3).
      { user_id: "google-oauth2|1035", roles: [{ id: "rol_2", name: "Editor" }] },
    ],
  },
  // No display_name and no name: the reader passes no default (ruling I-5).
  { id: "org_b", members: [{ user_id: "auth0|o7p6", roles: [{ id: "rol_1", name: "owner" }] }] },
]);

describe("auth0Source", () => {
  it("joins the hash file on auth0|_id and the address, and maps the social identity", async () => {
    const r = await all(
      auth0Source({ users: AUTH0_USERS, hashes: AUTH0_HASHES, organizations: AUTH0_ORGS }),
    );
    expect(r[0]).toMatchObject({
      sourceId: "auth0|o7p6",
      emailVerified: true,
      identities: [],
      password: { hash: expect.stringMatching(/^\$2b\$10\$/) },
    });
    expect(r[1]).toMatchObject({
      identities: [
        { provider: "google", subject: "1035" },
        { provider: "github", subject: "99" },
      ],
      password: null,
    });
    expect(r[2]).toMatchObject({ skip: "banned" });
    // A hash line whose address is not the user's address is refused (Review Focus 5).
    expect(r[3]).toMatchObject({
      sourceId: "auth0|e9e9",
      emailVerified: false,
      password: { refused: "hash_email_mismatch" },
    });
    // A line that names two users joins to neither (Review Focus 5).
    expect(r[4]).toMatchObject({ sourceId: "auth0|gg01", password: null });
    expect(r[5]).toMatchObject({ sourceId: "auth0|gg02", password: null });
    expect(r[6]).toMatchObject({ sourceId: "auth0|zz00", skip: "unmatched_row" });
    expect(r[7]).toMatchObject({ sourceId: "auth0|gg01", skip: "unmatched_row" });
    expect(r[8]).toMatchObject({ kind: "organization", name: "Acme Co", slug: "acme-co" });
    expect(r[9]).toMatchObject({ kind: "organization", sourceId: "org_b", name: null });
  });

  it("writes the email identity only for a verified user and skips a nameless organization", async () => {
    const db = createMemoryAdapter();
    const report = await importUsers(
      db,
      auth0Source({ users: AUTH0_USERS, hashes: AUTH0_HASHES, organizations: AUTH0_ORGS }),
      { formats: LEGACY_FORMATS, now },
    );
    expect(
      (await db.findMany("identity", [])).map((i) => `${i.provider}:${i.subject}`).sort(),
    ).toEqual(["email:ann@example.com", "email:gus@example.com", "github:99", "google:1035"]);
    expect(report.refusedHashes).toEqual([
      { sourceId: "auth0|e9e9", format: "hash_email_mismatch" },
    ]);
    expect(report.created.password).toBe(1);
    expect(report.skipped).toContainEqual({
      kind: "member",
      sourceId: "auth0|e9e9",
      reason: "user_unverified",
    });
    expect(report.skipped).toContainEqual({
      kind: "organization",
      sourceId: "org_b",
      reason: "invalid_name",
    });
    expect((await db.findMany("organization", [])).map((o) => o.name)).toEqual(["Acme Co"]);
    expect((await db.findMany("member", [])).map((m) => m.role).sort()).toEqual([
      "member",
      "owner",
    ]);
    expect(report.dropped).toContainEqual({ sourceId: "org_a", item: "role:Editor->member" });
    expect(report.dropped).not.toContainEqual({
      sourceId: "google-oauth2|1035",
      item: "identity:github",
    });
  });
});

describe("auth0Source roles", () => {
  it("maps a source role through the role map: Editor to admin, the owner kept", async () => {
    const db = createMemoryAdapter();
    await importUsers(
      db,
      auth0Source({ users: AUTH0_USERS, hashes: AUTH0_HASHES, organizations: AUTH0_ORGS }),
      { formats: LEGACY_FORMATS, now, roleMap: { Editor: "admin" } },
    );
    const idOf = async (email: string) =>
      (await db.findOne("user", [{ field: "email", op: "eq", value: email }]))?.id;
    const roleOf = async (email: string) => {
      const userId = await idOf(email);
      return (await db.findMany("member", [])).find((m) => m.userId === userId)?.role;
    };
    // The owner stays the owner, so no admin is promoted and the line below pins the map alone.
    expect(await roleOf("ann@example.com")).toBe("owner");
    // google-oauth2|1035, verified, with the source role Editor.
    expect(await roleOf("gus@example.com")).toBe("admin");
  });
});

// Edge rows (review I-1 to I-3, M-1, M-2), same shapes and date as above.
const EDGE_USERS = [
  { user_id: "auth0|dup1", email: "old@example.com", email_verified: true },
  { user_id: "auth0|dup1", email: "new@example.com", email_verified: true },
  { user_id: "auth0|argo", email: "argo@example.com", email_verified: true },
  { user_id: "auth0|twoh", email: "twoh@example.com", email_verified: true },
  { user_id: "auth0|blk", email: "blk@example.com", email_verified: true, blocked: "true" },
  { user_id: "auth0|badt", email: "badt@example.com", email_verified: true, created_at: "soon" },
]
  .map((u) => JSON.stringify(u))
  .join("\n");
const EDGE_HASHES = [
  { _id: "dup1", email: "new@example.com", passwordHash: HASH },
  // A valid Argon2id string: not a password Auth0 issued (review I-1).
  { _id: "argo", email: "argo@example.com", passwordHash: VECTORS.argon2id.stored },
  { _id: "twoh", email: "twoh@example.com", passwordHash: HASH },
  { _id: "twoh", email: "twoh@example.com", passwordHash: VECTORS.bcrypt2a.stored },
]
  .map((u) => JSON.stringify(u))
  .join("\n");

describe("auth0Source edge rows", () => {
  it("skips a duplicate user, refuses a non-bcrypt hash and a second hash line, and fails a block closed", async () => {
    const r = await all(auth0Source({ users: EDGE_USERS, hashes: EDGE_HASHES }));
    const by = (id: string) => r.filter((x) => x.kind === "user" && x.sourceId === id);
    expect(by("auth0|dup1")).toEqual([
      expect.objectContaining({ skip: "duplicate_row", password: null }),
    ]);
    expect(by("auth0|argo")).toEqual([
      expect.objectContaining({ password: { refused: "argon2id" } }),
    ]);
    expect(by("auth0|twoh")).toEqual([
      expect.objectContaining({ password: { refused: "duplicate_hash_line" } }),
    ]);
    expect(by("auth0|blk")).toEqual([expect.objectContaining({ skip: "banned" })]);
    expect(by("auth0|badt")).toEqual([
      expect.objectContaining({ createdAt: null, dropped: ["created_at:unreadable"] }),
    ]);
  });

  it("writes no password row for any of them and reports each refusal", async () => {
    const db = createMemoryAdapter();
    const report = await importUsers(db, auth0Source({ users: EDGE_USERS, hashes: EDGE_HASHES }), {
      formats: LEGACY_FORMATS,
      now,
    });
    expect(await db.findMany("password", [])).toEqual([]);
    expect(report.refusedHashes).toEqual([
      { sourceId: "auth0|argo", format: "argon2id" },
      { sourceId: "auth0|twoh", format: "duplicate_hash_line" },
    ]);
    expect(report.skipped).toContainEqual({
      kind: "user",
      sourceId: "auth0|dup1",
      reason: "duplicate_row",
    });
    const badt = await db.findOne("user", [
      { field: "email", op: "eq", value: "badt@example.com" },
    ]);
    expect(badt?.createdAt).toEqual(now());
  });

  it("throws on an organizations value that is not a JSON array, before any record", async () => {
    // The GET /api/v2/organizations?include_totals=true page is { "organizations": [...] }.
    const source = auth0Source({
      users: EDGE_USERS,
      organizations: JSON.stringify({ organizations: [] }),
    });
    await expect(source.records()[Symbol.asyncIterator]().next()).rejects.toThrow(
      "tempo-auth import: the Auth0 organizations input is not a JSON array",
    );
  });

  it("skips a user line and an organization with no id as no_source_id, never in silence", async () => {
    const users = `${EDGE_USERS}\n${JSON.stringify({ email: "noid@example.com", email_verified: true })}`;
    const organizations = JSON.stringify([
      { name: "first", members: [{ user_id: "auth0|argo", roles: [{ name: "owner" }] }] },
      { name: "second", members: [{ user_id: "auth0|argo", roles: [{ name: "owner" }] }] },
    ]);
    const report = await importUsers(createMemoryAdapter(), auth0Source({ users, organizations }), {
      formats: LEGACY_FORMATS,
      now,
    });
    expect(report.skipped).toContainEqual({
      kind: "user",
      sourceId: "(none) users line 7",
      reason: "no_source_id",
    });
    // Two organizations with no id would share one importId: the second would read as exists.
    expect(report.skipped).toContainEqual({
      kind: "organization",
      sourceId: "(none) organizations item 1",
      reason: "no_source_id",
    });
    expect(report.skipped).toContainEqual({
      kind: "organization",
      sourceId: "(none) organizations item 2",
      reason: "no_source_id",
    });
    expect(report.exists.organization).toBe(0);
    expect(report.created.organization).toBe(0);
  });
});

describe("auth0Source: GitHub and LinkedIn (plan 9b2)", () => {
  it("reads a numeric GitHub user_id as text and lists every LinkedIn identity as linkedin_legacy", async () => {
    const users = JSON.stringify({
      user_id: "github|583231",
      email: "oc@example.com",
      email_verified: true,
      identities: [
        { provider: "github", user_id: 583231, isSocial: true },
        { provider: "linkedin", user_id: "yrZCpj2Z12", isSocial: true },
      ],
    });
    const r = await all(auth0Source({ users }));
    expect(r[0]).toMatchObject({
      identities: [
        { provider: "github", subject: "583231" },
        { provider: "linkedin_legacy", subject: "yrZCpj2Z12" },
      ],
    });
  });
});
