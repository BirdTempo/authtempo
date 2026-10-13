import { env } from "cloudflare:test";
import {
  type Clock,
  createAuth,
  createMemoryLimiter,
  type MailMessage,
  type StorageAdapter,
} from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");

/**
 * D1 transactions are not isolated (README, "Transactions"). This test runs a
 * second owner removal to completion inside the first one's transaction, after
 * the first one's lock update and before its member delete. That is the
 * interleave a real D1 database allows between two requests.
 */
describe("owner removal race on D1 (plan 6 review I-1)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it("of two owners who leave at once, one answers conflict and one owner remains", async () => {
    const base = createD1Adapter(env.DB);
    const clock: Clock = { now: () => t0 };
    const sent: MailMessage[] = [];
    let interleave: (() => Promise<void>) | null = null;

    // The wrapped storage hands each transaction a tx whose first organization update runs `interleave`.
    const wrapTx = (tx: StorageAdapter): StorageAdapter => ({
      ...tx,
      async update(model, where, data) {
        const n = await tx.update(model, where, data);
        if (model === "organization" && interleave) {
          const run = interleave;
          interleave = null;
          await run();
        }
        return n;
      },
      transaction: (fn) => tx.transaction((inner) => fn(wrapTx(inner))),
    });
    const storage: StorageAdapter = {
      ...base,
      transaction: (fn) => base.transaction((tx) => fn(wrapTx(tx))),
    };

    const auth = createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: ["https://app.example.com"],
      storage,
      mail: {
        send: async (m) => {
          sent.push(m);
        },
      },
      limiter: createMemoryLimiter(clock),
      clock,
      organizations: {},
    });

    const user = (id: string) =>
      base.create("user", {
        id,
        email: `${id}@example.com`,
        emailVerified: true,
        name: null,
        image: null,
        createdAt: t0,
        updatedAt: t0,
      });
    const a = await user("a");
    const b = await user("b");
    const created = await auth.api.createOrganization({ user: a, slug: "acme", name: "Acme" });
    if (!created.ok) throw new Error(created.code);
    const organizationId = created.value.organization.id;
    const added = await auth.api.addMember({
      user: a,
      organizationId,
      userId: b.id,
      role: "owner",
    });
    expect(added.ok).toBe(true);

    let second: Awaited<ReturnType<typeof auth.api.removeMember>> | null = null;
    interleave = async () => {
      second = await auth.api.removeMember({ user: b, organizationId, userId: b.id });
    };
    const first = await auth.api.removeMember({ user: a, organizationId, userId: a.id });

    expect(interleave).toBeNull();
    // The owner rows first: without the recount, both deletes commit and none remains.
    const members = await base.findMany("member", [
      { field: "organizationId", op: "eq", value: organizationId },
    ]);
    expect(members.map((m) => [m.userId, m.role])).toEqual([["a", "owner"]]);
    expect(second).toEqual({ ok: true, value: { ok: true } });
    expect(first).toMatchObject({ ok: false, code: "conflict", status: 409 });
    expect(sent).toEqual([]);
  });
});
