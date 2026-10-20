import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { adminApp, adminShim, PASSWORD } from "../admin-helpers.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { execD1 } from "./schema.js";

// Plan 12f Task 13 on D1: Better Auth's ban-user path through core's ban
// route, by a platform operator. D1 Free allows 50 queries per invocation
// (D1 limits page updated 21 April 2026, read 2026-10-21). The shim reads
// the user row once after the route, for Better Auth's `{ user }`. This
// test counts each statement that reaches the binding, each statement of a
// batch as one, and checks the ban across a restart of the shim.

await execD1(BETTER_AUTH_SQLITE);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

/** The key that gives the statement of the binding under a counting view. */
const RAW = Symbol("raw");

/** A view of `db` that counts each statement it runs, and each statement of a batch. */
function counting(db: D1Database) {
  const count = { queries: 0 };
  const wrapStatement = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === "bind") return (...values: unknown[]) => wrapStatement(target.bind(...values));
        if (key === "run" || key === "all" || key === "first" || key === "raw")
          return (...args: unknown[]) => {
            count.queries++;
            return (target[key] as (...a: unknown[]) => unknown).apply(target, args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const counted = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrapStatement(target.prepare(sql));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          count.queries += statements.length;
          return target.batch(
            statements.map((s) => (s as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? s),
          );
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted, count };
}

describe("the admin plugin on D1 (plan 12f Task 13)", () => {
  it("keeps a ban in the compat columns across a restart, and a ban of 60 sessions sends 50 queries or fewer", async () => {
    // The setup allows each call: 60 sign-ins of one user pass the sign-in limits.
    const setup = await adminApp({
      ...betterAuthSchemaStorage({ dialect: "d1", db: env.DB }),
      limiter: { allow: async () => true },
    });
    const ann = await setup.user("ann@example.com");
    for (let i = 0; i < 59; i++)
      await setup.call("/password/sign-in", { email: "ann@example.com", password: PASSWORD });

    // One invocation: a new storage and a new shim over the counting binding, with the D1 limiter.
    const { db, count } = counting(env.DB);
    const invocation = adminShim(betterAuthSchemaStorage({ dialect: "d1", db }));
    const ban = await invocation.handler(
      new Request("https://api.example.com/api/auth/admin/ban-user", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://api.example.com",
          cookie: setup.op,
        },
        body: JSON.stringify({ userId: ann.id, banReason: "Spam" }),
      }),
    );
    expect(ban.status).toBe(200);
    expect(((await ban.json()) as { user: { banned: boolean } }).user.banned).toBe(true);
    // The route's act and the shim's read of the user row: 50 or fewer. With
    // no session.afterEnd hook (the shim maps none), the ban ends every session in chunks.
    // Plan 12f Task 11 adds 2: the router reads the session for the
    // impersonation step, and the ban reads the audit for the operator's impersonations.
    expect(count.queries).toBeLessThanOrEqual(50);
    expect(count.queries).toBe(34);
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ?`)
      .bind(ann.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);

    const row = await env.DB.prepare(
      `SELECT "taBannedAt", "taBanReason", "taBanUntil" FROM "user" WHERE "id" = ?`,
    )
      .bind(ann.id)
      .first<{
        taBannedAt: string | null;
        taBanReason: string | null;
        taBanUntil: string | null;
      }>();
    expect(row?.taBanReason).toBe("Spam");
    expect(row?.taBannedAt).not.toBeNull();
    expect(row?.taBanUntil).toBeNull();

    // A new shim on a new storage reads the ban from core's columns.
    const restarted = adminShim(betterAuthSchemaStorage({ dialect: "d1", db: env.DB }));
    const signIn = await restarted.handler(
      new Request("https://api.example.com/api/auth/password/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://api.example.com" },
        body: JSON.stringify({ email: "ann@example.com", password: PASSWORD }),
      }),
    );
    expect({ status: signIn.status, body: await signIn.json() }).toMatchObject({
      status: 403,
      body: { error: "account_banned" },
    });
  });
});
