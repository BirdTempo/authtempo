import { applyD1Migrations, env } from "cloudflare:test";
import { createPbkdf2PasswordHash, type UserRow } from "@authtempo/core";
import { expect, it } from "vitest";
import { betterAuthPasswordHash } from "../../src/hash.js";
import { organization } from "../../src/plugins.js";
import { betterAuth } from "../../src/server/better-auth.js";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { BETTER_AUTH_1421_TEAMS_SQLITE, BETTER_AUTH_SQLITE } from "../fixtures.js";
import { execD1 } from "./schema.js";
import { before17 } from "./sql.js";

// Ruling 41 of plan 12k: tables from before Better Auth 1.7 with the teams
// option of 1.4.21. Its team tables have no memberCount and no
// membershipKey, and its session and invitation hold the two teams columns.
// Such an app applies the d1-before-1.7 files with its own 0010: the shipped
// file without its two ADD COLUMN lines of session and invitation (ruling 19).
await execD1(
  `${before17(BETTER_AUTH_SQLITE)}${BETTER_AUTH_1421_TEAMS_SQLITE}
ALTER TABLE "session" ADD COLUMN "activeTeamId" text;
ALTER TABLE "invitation" ADD COLUMN "teamId" text;`,
);
const at = "2026-10-21T00:00:00.000Z";
// A team and a member row as Better Auth 1.4.21 writes them.
await execD1(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('u0', 'Bo', 'bo@example.com', 1, '${at}', '${at}');
INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('o0', 'Old', 'old', '${at}');
INSERT INTO "team" ("id", "name", "organizationId", "createdAt") VALUES ('t0', 'Old', 'o0', '${at}');
INSERT INTO "teamMember" ("id", "teamId", "userId", "createdAt") VALUES ('m0', 't0', 'u0', '${at}');`);
const teamsLines = [
  `ALTER TABLE "session" ADD COLUMN "activeTeamId" TEXT`,
  `ALTER TABLE "invitation" ADD COLUMN "teamId" TEXT`,
];
const own = env.COMPAT_MIGRATIONS_BEFORE_17.map((m) =>
  m.name.startsWith("0010_")
    ? { ...m, queries: m.queries.filter((q) => !teamsLines.some((l) => q.includes(l))) }
    : m,
);
await applyD1Migrations(env.DB, own);

it("migrates the team tables of Better Auth 1.4.21 with the d1-before-1.7 files, then creates an organization with its default team", async () => {
  const shipped = env.COMPAT_MIGRATIONS_BEFORE_17.find((m) => m.name.startsWith("0010_"));
  const ownFile = own.find((m) => m.name.startsWith("0010_"));
  expect((shipped?.queries.length ?? 0) - (ownFile?.queries.length ?? 0)).toBe(2);
  const columns = async (table: string) =>
    (
      await env.DB.prepare(
        `SELECT name, type, "notnull" AS nn, dflt_value AS d FROM pragma_table_info('${table}')`,
      ).all<{ name: string; type: string; nn: number; d: string | null }>()
    ).results;
  expect((await columns("team")).find((c) => c.name === "memberCount")).toEqual({
    name: "memberCount",
    type: "INTEGER",
    nn: 1,
    d: "0",
  });
  expect((await columns("teamMember")).find((c) => c.name === "membershipKey")).toEqual({
    name: "membershipKey",
    type: "TEXT",
    nn: 0,
    d: null,
  });
  const old = await env.DB.prepare(
    `SELECT t."memberCount" AS n, m."membershipKey" AS k FROM "team" t JOIN "teamMember" m ON m."teamId" = t."id"`,
  ).all();
  expect(old.results).toEqual([{ n: 0, k: null }]);
  const meta = await env.DB.prepare("SELECT key, value FROM ta_meta ORDER BY key").all();
  expect(meta.results).toEqual([
    { key: "compat_better_auth", value: "13" },
    { key: "schema_version", value: "16" },
  ]);

  const database = betterAuthSchemaStorage({ dialect: "d1", db: env.DB });
  const auth = betterAuth({
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    database,
    plugins: [
      organization({
        creatorRole: "owner",
        teams: { enabled: true },
        sendInvitationEmail: async () => {},
      }),
    ],
    authtempo: {
      passwordHash: betterAuthPasswordHash({
        pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
      }),
    },
  });
  const owner = (await database.storage.create("user", {
    id: "u1",
    email: "ada@example.com",
    emailVerified: true,
    name: null,
    image: null,
    bannedAt: null,
    banReason: null,
    banUntil: null,
    username: null,
    displayUsername: null,
    phone: null,
    isAnonymous: false,
    createdAt: new Date(at),
    updatedAt: new Date(at),
  })) as UserRow;
  const created = await auth.tempo.api.createOrganization({
    user: owner,
    slug: "acme",
    name: "Acme",
  });
  if (!created.ok) throw new Error(created.code);
  const rows = await env.DB.prepare(
    `SELECT t."name", t."memberCount" AS n, m."userId" AS u, m."membershipKey" AS k FROM "team" t JOIN "teamMember" m ON m."teamId" = t."id" WHERE t."organizationId" = ?`,
  )
    .bind(created.value.organization.id)
    .all<{ name: string; n: number; u: string; k: string }>();
  expect(rows.results).toEqual([
    { name: "Acme", n: 0, u: "u1", k: expect.stringMatching(/^[\w-]{43}$/) },
  ]);
  // The unique index of the added membershipKey.
  await expect(
    env.DB.prepare(
      `INSERT INTO "teamMember" ("id", "teamId", "userId", "membershipKey", "createdAt") VALUES ('m9', 't0', 'u1', ?, '${at}')`,
    )
      .bind(rows.results[0]?.k ?? "")
      .run(),
  ).rejects.toThrow(/UNIQUE constraint failed/);
});
