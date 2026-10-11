import { createMemoryAdapter } from "@tempo-auth/core";
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
    identities: [{ provider: "google-oauth2", user_id: "1035", isSocial: true }],
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
      identities: [{ provider: "google", subject: "1035" }],
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
      { now },
    );
    expect(
      (await db.findMany("identity", [])).map((i) => `${i.provider}:${i.subject}`).sort(),
    ).toEqual(["email:ann@example.com", "email:gus@example.com", "google:1035"]);
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
  });
});
