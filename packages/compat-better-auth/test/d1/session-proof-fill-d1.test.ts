import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import guide from "../../../../apps/site/src/content/docs/docs/migrate/better-auth.mdx?raw";
import shippedText from "../../migrations/d1/0013_compat_schema_v16.sql?raw";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { execD1 } from "./schema.js";
import { statementsOf } from "./sql.js";

// The fill of compat 0013 by hand on D1 (ruling 22 of plan 12p). The Better
// Auth guide gives the D1 limit of the one-statement fill. It also gives the
// steps by hand for an app over the ceiling, as the D1 README of core does.
// This test runs the commands of the guide on Better Auth's tables at compat
// version 12. The pages must mark the rows that the shipped file marks, and
// the storage must open after them.

/** The SQL of each `wrangler d1 execute` command of the guide's part on the 0013 fill, in order. */
function byHand(page: string): string[] {
  const start = page.indexOf("On D1, the fill of `0013_compat_schema_v16.sql` is one statement.");
  const end = page.indexOf("\n```\n", start);
  if (start < 0 || end < 0) throw new Error("the guide has no part on the D1 fill of compat 0013");
  return [
    ...page
      .slice(start, end)
      .matchAll(/wrangler d1 execute my-app --remote (?:--json )?--command "([^"]+)"/g),
  ].map((m) => m[1] ?? "");
}

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A Better Auth user and its sessions, as Better Auth 1.7 writes them: its own columns only. */
async function betterAuthUser(id: string, email: string, verified: 0 | 1, sessions: number) {
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt") VALUES (?, ?, ?, ?, NULL, ?, ?)',
  )
    .bind(id, id, email, verified, iso(now - HOUR), iso(now - HOUR))
    .run();
  for (let i = 0; i < sessions; i++)
    await env.DB.prepare(
      'INSERT INTO "session" ("id","expiresAt","token","createdAt","updatedAt","ipAddress","userAgent","userId","activeOrganizationId") VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL)',
    )
      .bind(
        `${id}-s${i}`,
        iso(now + 24 * HOUR),
        `${id}-t${i}`,
        iso(now - HOUR),
        iso(now - HOUR),
        id,
      )
      .run();
}

const proved = async () =>
  (
    await env.DB.prepare('SELECT "id", "taProved" AS v FROM "session" ORDER BY "id"').all<{
      id: string;
      v: number;
    }>()
  ).results;

describe("the fill of compat 0013 by hand on D1 (ruling 22 of plan 12p)", () => {
  it("marks in pages the sessions that the shipped file marks, and the storage opens after the steps", async () => {
    await execD1(BETTER_AUTH_SQLITE);
    const i0013 = env.COMPAT_MIGRATIONS.findIndex((m) => m.name.startsWith("0013_"));
    expect(i0013).toBe(12);
    await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS.slice(0, i0013));
    // Two verified users with an address, a claimant with an unverified one, and a verified placeholder.
    await betterAuthUser("u-ann", "ann@example.com", 1, 2);
    await betterAuthUser("u-cid", "cid@example.com", 1, 1);
    await betterAuthUser("u-bob", "bob@example.com", 0, 1);
    await betterAuthUser("u-phone", "+14155550100@phone.placeholder.invalid", 1, 1);
    const [count, column, page, version, compat, ...rest] = byHand(guide);
    expect(rest).toEqual([]);
    // The column and the two version writes are statements of the shipped file, with its names quoted.
    const shipped = statementsOf(shippedText);
    expect(shipped.map((s) => s.replaceAll('"', ""))).toEqual(
      expect.arrayContaining([column, version, compat]),
    );
    expect(await env.DB.prepare(count ?? "").first("sessions")).toBe(3);
    await env.DB.prepare(column ?? "").run();
    // Pages of 2 in place of 10,000. Each command runs again until it changes no row.
    expect((page ?? "").split("LIMIT 10000")).toHaveLength(2);
    const changes: number[] = [];
    for (let n = 1; n !== 0; ) {
      n = (await env.DB.prepare((page ?? "").replace("LIMIT 10000", "LIMIT 2")).run()).meta.changes;
      changes.push(n);
    }
    expect(changes).toEqual([2, 1, 0]);
    await env.DB.prepare(version ?? "").run();
    await env.DB.prepare(compat ?? "").run();
    const paged = await proved();
    expect(paged).toEqual([
      { id: "u-ann-s0", v: 1 },
      { id: "u-ann-s1", v: 1 },
      { id: "u-bob-s0", v: 0 },
      { id: "u-cid-s0", v: 1 },
      { id: "u-phone-s0", v: 0 },
    ]);
    // The fill of the shipped file marks the same rows.
    const fill = shipped.find((s) => s.startsWith('UPDATE "session" SET "taProved" = 1'));
    expect(fill).toBeDefined();
    await env.DB.prepare('UPDATE "session" SET "taProved" = 0').run();
    await env.DB.prepare(fill ?? "").run();
    expect(await proved()).toEqual(paged);
    const meta = await env.DB.prepare("SELECT key, value FROM ta_meta ORDER BY key").all();
    expect(meta.results).toEqual(
      expect.arrayContaining([
        { key: "compat_better_auth", value: "13" },
        { key: "schema_version", value: "16" },
      ]),
    );
    // The storage of version 16 opens, and it reads the flag of each session.
    const { storage } = betterAuthSchemaStorage({ dialect: "d1", db: env.DB });
    const rows = await storage.findMany("session", [], { sort: { field: "id", dir: "asc" } });
    expect(rows.map((r) => [r.id, r.proved])).toEqual(paged.map((r) => [r.id, r.v === 1]));
    // The guide gives the numbers of the D1 README of core.
    for (const words of [
      "more than 100,000 live sessions",
      "one page of 10,000 sessions",
      "The Cloudflare D1 limits page, read 2026-11-04",
    ])
      expect(guide.split(words)).toHaveLength(2);
  });
});
