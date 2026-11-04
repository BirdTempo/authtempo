import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import {
  accountDeleteCascadeSuite,
  engine,
  rowsOf,
  soloOwner,
} from "../account-delete-cascade-suite.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { counting } from "./counting.js";
import { execD1 } from "./schema.js";

// Ruling 13 of plan 12f2 on the D1 storage of the Better Auth tables, with
// Better Auth's own SQLite SQL and its foreign keys. Each delete runs on a
// new storage over a counting binding: one invocation, 50 queries or fewer
// (D1 limits page updated 21 April 2026, read 2026-10-21).

await execD1(BETTER_AUTH_SQLITE);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

const database = betterAuthSchemaStorage({ dialect: "d1", db: env.DB });

describe("the account delete on the compat D1 storage (ruling 13 of plan 12f2)", () => {
  accountDeleteCascadeSuite(async () => ({
    database,
    removeSolo: "too_large",
    ownPage: 14,
    act() {
      const { db, count } = counting(env.DB);
      return {
        storage: betterAuthSchemaStorage({ dialect: "d1", db }).storage,
        queries: () => count.queries,
      };
    },
  }));

  it("ends a page of 60 sessions with the hook in 50 queries; the cascade takes the rest", async () => {
    // The page keeps the calls of the user and organization deletes free.
    // The sessions that do not fit go by the cascade with no hook. On these
    // tables the sweep finds none of them (a residual of ruling 13). The
    // impersonation tool is off here, so the delete reads no impersonation
    // session (decision 3 of plan 12o). delete-stops-sweep-d1.test.ts runs
    // the delete with the tool on.
    const store = {
      database,
      act() {
        const { db, count } = counting(env.DB);
        return {
          storage: betterAuthSchemaStorage({ dialect: "d1", db }).storage,
          queries: () => count.queries,
        };
      },
      removeSolo: "too_large" as const,
      ownPage: 14,
    };
    const { me, organizationId } = await soloOwner(store, 60);
    expect((await rowsOf(database.storage, me.user.id, organizationId)).sessions).toBe(60);
    const act = store.act();
    const { auth, ends } = engine(act.storage, []);
    const answer = await auth.api.operator.users.delete({
      actor: { kind: "app", name: "support-tool" },
      userId: me.user.id,
      reason: "Ticket 3",
      ip: null,
      userAgent: null,
    });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    expect(act.queries()).toBeLessThanOrEqual(50);
    // Run of 2026-10-25. The run of 2026-11-04 with plan 12o gave the same counts.
    expect([act.queries(), ends.length]).toEqual([47, 8]);
    expect(await rowsOf(database.storage, me.user.id, organizationId)).toMatchObject({
      user: false,
      sessions: 0,
      organization: false,
    });
  });
});
