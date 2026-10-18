import { createMemoryAdapter } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { importUsers } from "../../src/import.js";
import { workosSource } from "../../src/readers/workos.js";
import { exitCode } from "../../src/report.js";
import { all, now } from "./all.js";

// Shapes: the WorkOS reference pages user-management/user,
// user-management/identity, user-management/organization-membership, and
// organization, read 2026-10-19 (plan 11f Task 1 Step 1). The guide's curl
// script saves the `data` array of every list page, and one object of user
// id to the identities array of `GET /user_management/users/{id}/identities`.
// Unverified, checked by owner runbook item 13: the provider values other
// than MicrosoftOAuth, and `idp_id` as the provider's own subject.
type User = Record<string, unknown>;

const user = (id: string, over: User = {}): User => ({
  object: "user",
  id,
  email: `${id}@example.com`,
  email_verified: true,
  first_name: null,
  last_name: null,
  name: null,
  profile_picture_url: null,
  created_at: "2024-03-01T09:00:00.000Z",
  updated_at: "2024-03-01T09:00:00.000Z",
  ...over,
});
const users = (...list: User[]) => JSON.stringify(list);
const identity = (provider: string, idp_id: string, type = "OAuth") => ({
  idp_id,
  type,
  provider,
});
const org = (id: string, name: string) => ({
  object: "organization",
  id,
  name,
  created_at: "2024-02-01T00:00:00.000Z",
  updated_at: "2024-02-01T00:00:00.000Z",
});
const membership = (
  user_id: string,
  organization_id: string,
  status: string,
  role: unknown = { slug: "member" },
) => ({
  object: "organization_membership",
  id: `om_${user_id}_${organization_id}`,
  user_id,
  organization_id,
  organization_name: "Acme",
  role,
  status,
  created_at: "2024-02-02T00:00:00.000Z",
});

describe("workosSource", () => {
  it("maps every field of a user", async () => {
    const r = await all(
      workosSource({
        users: users(
          user("user_01", {
            first_name: "Ada",
            last_name: "Lovelace",
            name: null,
            profile_picture_url: "https://example.com/ada.png",
            created_at: "2024-01-15T10:30:00.123Z",
          }),
        ),
      }),
    );
    expect(r).toEqual([
      {
        kind: "user",
        sourceId: "user_01",
        email: "user_01@example.com",
        emailVerified: true,
        name: "Ada Lovelace",
        image: "https://example.com/ada.png",
        createdAt: new Date("2024-01-15T10:30:00.123Z"),
        identities: [],
        password: null,
        passkeys: [],
        dropped: [],
      },
    ]);
  });

  it("takes name before first_name and last_name", async () => {
    const r = await all(
      workosSource({
        users: users(user("user_01", { name: "A. Lovelace", first_name: "Ada", last_name: "L" })),
      }),
    );
    expect(r[0]).toMatchObject({ name: "A. Lovelace" });
  });

  it("reads email_verified as true only for the JSON value true", async () => {
    const r = await all(
      workosSource({
        users: users(
          user("user_01", { email_verified: "true" }),
          user("user_02", { email_verified: 1 }),
          user("user_03", { email_verified: undefined }),
          user("user_04", { email_verified: true }),
        ),
      }),
    );
    expect(r.map((x) => (x.kind === "user" ? x.emailVerified : null))).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("maps the three OAuth providers and drops every other", async () => {
    const source = () =>
      workosSource({
        users: users(user("user_01")),
        identities: JSON.stringify({
          user_01: [
            identity("GoogleOAuth", "g-1"),
            identity("AppleOAuth", "001.apple"),
            identity("GitHubOAuth", "4242"),
            identity("MicrosoftOAuth", "ms-1"),
            identity("LinkedInOAuth", "li-1"),
          ],
        }),
      });
    const r = await all(source());
    expect(r[0]).toMatchObject({
      identities: [
        { provider: "google", subject: "g-1" },
        { provider: "apple", subject: "001.apple" },
        { provider: "github", subject: "4242" },
        { provider: "workos:MicrosoftOAuth", subject: "ms-1" },
        { provider: "linkedin_legacy", subject: "li-1" },
      ],
      dropped: [],
    });
    const db = createMemoryAdapter();
    const report = await importUsers(db, source(), { formats: [], now });
    expect(
      (await db.findMany("identity", [])).map((i) => `${i.provider}:${i.subject}`).sort(),
    ).toEqual(["apple:001.apple", "email:user_01@example.com", "github:4242", "google:g-1"]);
    expect(report.dropped).toEqual([
      { sourceId: "user_01", item: "identity:workos:MicrosoftOAuth" },
      { sourceId: "user_01", item: "identity:linkedin_legacy" },
    ]);
  });

  it("drops an identity of another type and an entry it cannot read", async () => {
    const r = await all(
      workosSource({
        users: users(user("user_01")),
        identities: JSON.stringify({
          user_01: [
            identity("OktaSAML", "s-1", "SSO"),
            { type: "OAuth", provider: "GoogleOAuth" },
            { type: "OAuth", idp_id: "g-2" },
            identity("GoogleOAuth", "g-1"),
          ],
        }),
      }),
    );
    expect(r[0]).toMatchObject({
      identities: [{ provider: "google", subject: "g-1" }],
      dropped: ["identity:type:SSO", "identity:unreadable", "identity:unreadable"],
    });
  });

  it("stops on a top-level value of the wrong shape", async () => {
    const one = users(user("user_01"));
    await expect(
      all(workosSource({ users: JSON.stringify({ data: [user("user_01")] }) })),
    ).rejects.toThrow(
      "authtempo import: the WorkOS users input is not an array (save the data array of every page)",
    );
    await expect(
      all(
        workosSource({ users: one, identities: JSON.stringify([identity("GoogleOAuth", "g-1")]) }),
      ),
    ).rejects.toThrow(
      "authtempo import: the WorkOS identities input is not an object (save one object of user id to identities)",
    );
    await expect(
      all(
        workosSource({
          users: one,
          memberships: JSON.stringify({ data: [] }),
          organizations: JSON.stringify([org("org_01", "Acme")]),
        }),
      ),
    ).rejects.toThrow(
      "authtempo import: the WorkOS memberships input is not an array (save the data array of every page)",
    );
    await expect(
      all(
        workosSource({
          users: one,
          memberships: JSON.stringify([]),
          organizations: JSON.stringify({ data: [org("org_01", "Acme")] }),
        }),
      ),
    ).rejects.toThrow(
      "authtempo import: the WorkOS organizations input is not an array (save the data array of every page)",
    );
  });

  it("needs memberships and organizations together", async () => {
    const message =
      "authtempo import: the WorkOS memberships input needs the organizations input, and the organizations input needs the memberships input";
    await expect(
      all(workosSource({ users: users(user("user_01")), memberships: JSON.stringify([]) })),
    ).rejects.toThrow(message);
    await expect(
      all(workosSource({ users: users(user("user_01")), organizations: JSON.stringify([]) })),
    ).rejects.toThrow(message);
  });

  it("imports only an active membership, and lists the others on the user", async () => {
    const r = await all(
      workosSource({
        users: users(user("user_01"), user("user_02"), user("user_03")),
        organizations: JSON.stringify([org("org_01", "Acme")]),
        memberships: JSON.stringify([
          membership("user_01", "org_01", "active"),
          membership("user_02", "org_01", "inactive"),
          membership("user_03", "org_01", "pending"),
        ]),
      }),
    );
    expect(r[3]).toEqual({
      kind: "organization",
      sourceId: "org_01",
      name: "Acme",
      slug: null,
      createdAt: new Date("2024-02-01T00:00:00.000Z"),
      members: [{ userSourceId: "user_01", roles: ["member"] }],
    });
    expect(r[0]).toMatchObject({ sourceId: "user_01", dropped: [] });
    expect(r[1]).toMatchObject({ sourceId: "user_02", dropped: ["member:inactive"] });
    expect(r[2]).toMatchObject({ sourceId: "user_03", dropped: ["member:pending"] });
  });

  it("maps the role slug, and the first admin becomes owner", async () => {
    const source = () =>
      workosSource({
        users: users(user("user_01"), user("user_02"), user("user_03")),
        organizations: JSON.stringify([org("org_01", "Acme")]),
        memberships: JSON.stringify([
          membership("user_01", "org_01", "active", { slug: "admin" }),
          membership("user_02", "org_01", "active", { slug: "member" }),
          membership("user_03", "org_01", "active", {}),
        ]),
      });
    const r = await all(source());
    expect(r[3]).toMatchObject({
      members: [
        { userSourceId: "user_01", roles: ["admin"] },
        { userSourceId: "user_02", roles: ["member"] },
        { userSourceId: "user_03", roles: ["member"] },
      ],
    });
    expect(r[2]).toMatchObject({ sourceId: "user_03", dropped: ["role:unreadable"] });
    const db = createMemoryAdapter();
    const report = await importUsers(db, source(), { formats: [], now });
    expect(report.created).toMatchObject({ organization: 1, member: 3 });
    const emailOf = new Map((await db.findMany("user", [])).map((u) => [u.id, u.email]));
    const byUser = new Map(
      (await db.findMany("member", [])).map((m) => [emailOf.get(m.userId), m.role]),
    );
    expect(byUser.get("user_01@example.com")).toBe("owner");
    expect(byUser.get("user_02@example.com")).toBe("member");
    expect(byUser.get("user_03@example.com")).toBe("member");
  });

  it("skips a user with no id and both users of one id", async () => {
    const r = await all(
      workosSource({
        users: users(
          user("user_01", { id: undefined }),
          user("user_02"),
          user("user_02", { email: "other@example.com" }),
        ),
      }),
    );
    expect(r[0]).toMatchObject({ sourceId: "(none) users[0]", skip: "no_source_id" });
    expect(r[1]).toMatchObject({ sourceId: "user_02", skip: "duplicate_row" });
    expect(r[2]).toMatchObject({ sourceId: "user_02", skip: "duplicate_row" });
  });

  it("keeps one credential for an unverified user with two identities", async () => {
    const db = createMemoryAdapter();
    const report = await importUsers(
      db,
      workosSource({
        users: users(user("user_01", { email_verified: false })),
        identities: JSON.stringify({
          user_01: [identity("GoogleOAuth", "g-1"), identity("GitHubOAuth", "4242")],
        }),
      }),
      { formats: [], now },
    );
    expect((await db.findMany("identity", [])).map((i) => `${i.provider}:${i.subject}`)).toEqual([
      "google:g-1",
    ]);
    expect(report.dropped).toEqual([
      { sourceId: "user_01", item: "unverified_extra_credential:github" },
    ]);
  });

  it("does not read a membership of a user that the users file lacks", async () => {
    // WorkOS deleted user_99 between the two fetches of the guide's script.
    const db = createMemoryAdapter();
    const report = await importUsers(
      db,
      workosSource({
        users: users(user("user_01")),
        organizations: JSON.stringify([org("org_01", "Acme")]),
        memberships: JSON.stringify([
          membership("user_01", "org_01", "active", { slug: "admin" }),
          membership("user_99", "org_01", "active", { slug: "member" }),
        ]),
      }),
      { formats: [], now },
    );
    expect(report.skipped).toEqual([]);
    expect(report.created).toMatchObject({ user: 1, organization: 1, member: 1 });
    expect(exitCode(report)).toBe(0);
  });

  it("lists a membership of an organization that the organizations file lacks", async () => {
    const r = await all(
      workosSource({
        users: users(user("user_01")),
        organizations: JSON.stringify([org("org_01", "Acme")]),
        memberships: JSON.stringify([membership("user_01", "org_99", "active")]),
      }),
    );
    expect(r[0]).toMatchObject({ dropped: ["member:unknown_organization"] });
    expect(r[1]).toMatchObject({ kind: "organization", sourceId: "org_01", members: [] });
  });
});
