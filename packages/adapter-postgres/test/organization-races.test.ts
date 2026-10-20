import { createAuth, type UserRow } from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The owner races of plan 12k on the real Postgres adapter, through core's
// built output. Each instance's transaction takes its own connection of the
// pool, so the two writes run as two requests on two connections do.

const t0 = new Date("2026-01-01T00:00:00.000Z");
/** The pause inside the first write's transaction, after its owner lock: long enough for the other write to read and wait on the lock. */
const HOLD_MS = 300;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

/** One instance of core on the shared pool. `hold` runs in the before hook of each role change. */
function instance(hold: () => Promise<void>) {
  return createAuth({
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createPostgresAdapter(db.sql),
    limiter: { allow: async () => true },
    mail: { send: async () => {} },
    clock: { now: () => t0 },
    organizations: {},
    hooks: { organization: { beforeUpdateMemberRole: hold } },
  });
}

describe("organization owner races on Postgres (plan 12k Task 3)", () => {
  it("of two owners who demote each other, one answers conflict and one owner stays", async () => {
    // The first write to reach its before hook holds its transaction open, so the second write
    // reads the organization before the first commits and then waits on the owner lock.
    let held = false;
    const hold = async () => {
      if (held) return;
      held = true;
      await new Promise((r) => setTimeout(r, HOLD_MS));
    };
    const one = instance(hold);
    const two = instance(hold);
    const storage = createPostgresAdapter(db.sql);
    const user = (id: string): Promise<UserRow> =>
      storage.create("user", {
        id,
        email: `${id}@example.com`,
        emailVerified: true,
        name: null,
        image: null,
        bannedAt: null,
        banReason: null,
        banUntil: null,
        createdAt: t0,
        updatedAt: t0,
      });
    const a = await user("a");
    const b = await user("b");
    const created = await one.api.createOrganization({ user: a, slug: "acme", name: "Acme" });
    if (!created.ok) throw new Error(created.code);
    const organizationId = created.value.organization.id;
    const added = await one.api.addMember({ user: a, organizationId, userId: b.id, role: "owner" });
    expect(added.ok).toBe(true);

    const answers = await Promise.all([
      one.api.updateMemberRole({ user: a, organizationId, userId: b.id, role: "admin" }),
      two.api.updateMemberRole({ user: b, organizationId, userId: a.id, role: "admin" }),
    ]);

    expect(answers.map((r) => (r.ok ? "ok" : r.code)).sort()).toEqual(["conflict", "ok"]);
    const rows = await db.sql<{ role: string }[]>`
      SELECT role FROM ta_member WHERE organization_id = ${organizationId} ORDER BY role`;
    expect(rows.map((r) => r.role)).toEqual(["admin", "owner"]);
  });
});
