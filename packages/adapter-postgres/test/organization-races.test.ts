import { createAuth, type StorageAdapter, type UserRow } from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The owner races of plan 12k on the real Postgres adapter, through core's
// built output. Each instance's transaction takes its own connection of the
// pool, so the two writes run as two requests on two connections do.

const t0 = new Date("2026-01-01T00:00:00.000Z");

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

/**
 * A storage on the shared pool whose transactions call `locking` before each
 * organization update: the owner lock.
 */
function lockWatch(locking: () => void): StorageAdapter {
  const base = createPostgresAdapter(db.sql);
  const wrap = (tx: StorageAdapter): StorageAdapter => ({
    ...tx,
    update(model, where, data) {
      if (model === "organization") locking();
      return tx.update(model, where, data);
    },
    transaction: (fn) => tx.transaction((inner) => fn(wrap(inner))),
  });
  return { ...base, transaction: (fn) => base.transaction((tx) => fn(wrap(tx))) };
}

/** One instance of core on `storage`. `hold` runs in the before hook of each role change. */
function instance(hold: () => Promise<void>, storage: StorageAdapter) {
  return createAuth({
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: { allow: async () => true },
    mail: { send: async () => {} },
    clock: { now: () => t0 },
    organizations: {},
    hooks: { organization: { beforeUpdateMemberRole: hold } },
  });
}

describe("organization owner races on Postgres (plan 12k Task 3)", () => {
  it("of two owners who demote each other, one answers conflict and one owner stays", async () => {
    // b demotes a from inside a's before hook, after a's owner lock and before a's write.
    // The hook returns when b's transaction reaches its own owner lock, or when b's call ends.
    let second: ReturnType<ReturnType<typeof instance>["api"]["updateMemberRole"]> | null = null;
    let reached = () => {};
    const atLock = new Promise<void>((r) => {
      reached = r;
    });
    const hold = async () => {
      if (second) return;
      second = two.api.updateMemberRole({ user: b, organizationId, userId: a.id, role: "admin" });
      await Promise.race([atLock, second]);
    };
    const one = instance(hold, createPostgresAdapter(db.sql));
    const two = instance(
      hold,
      lockWatch(() => reached()),
    );
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

    const first = await one.api.updateMemberRole({
      user: a,
      organizationId,
      userId: b.id,
      role: "admin",
    });

    // b read the owner stamp before a's commit, so b's owner lock matches no row.
    expect(first).toMatchObject({ ok: true, value: { userId: "b", role: "admin" } });
    expect(await second).toMatchObject({ ok: false, code: "conflict", status: 409 });
    const rows = await db.sql<{ role: string }[]>`
      SELECT role FROM ta_member WHERE organization_id = ${organizationId} ORDER BY role`;
    expect(rows.map((r) => r.role)).toEqual(["admin", "owner"]);
  });
});
