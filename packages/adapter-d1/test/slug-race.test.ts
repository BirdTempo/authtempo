import { env } from "cloudflare:test";
import { createAuth, type UserRow } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");

/**
 * The slug race of spec 29 item 8 on D1 (plan 12k Task 6). D1 transactions
 * are not isolated, so a second call can read and write while the first call
 * is in its before hook. The unique key then decides.
 */
describe("organization slug races on D1 (plan 12k Task 6)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  /**
   * One instance whose create and update before hooks run `race.hold`. Users a
   * and b are verified, and the limiter allows each call.
   */
  async function slugWorld() {
    const base = createD1Adapter(env.DB);
    const race: { hold: ((user: UserRow) => Promise<void>) | null } = { hold: null };
    const before = async ({ user }: { user: UserRow }) => {
      if (race.hold) await race.hold(user);
    };
    const auth = createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: base,
      limiter: { allow: async () => true },
      mail: { send: async () => {} },
      clock: { now: () => t0 },
      organizations: {},
      hooks: { organization: { beforeCreate: before, beforeUpdate: before } },
    });
    const user = (id: string): Promise<UserRow> =>
      base.create("user", {
        id,
        email: `${id}@example.com`,
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
        createdAt: t0,
        updatedAt: t0,
      });
    return { base, auth, race, a: await user("a"), b: await user("b") };
  }

  /**
   * a's call starts b's call from inside a's before hook, after a's slug read.
   * a's hook returns when b's call reaches its own hook, after b's slug read.
   * b's hook returns when a's call ends. So both reads find no row, and the
   * unique key decides. No pause runs.
   */
  async function slugRace<T>(
    w: Awaited<ReturnType<typeof slugWorld>>,
    call: (user: UserRow) => Promise<T>,
  ): Promise<[T, T]> {
    let reached = () => {};
    const atHook = new Promise<void>((r) => {
      reached = r;
    });
    const calls: { first?: Promise<T>; second?: Promise<T> } = {};
    w.race.hold = async (user) => {
      if (user.id === w.a.id) {
        calls.second = call(w.b);
        await Promise.race([atHook, calls.second]);
        return;
      }
      reached();
      await calls.first?.catch(() => {});
    };
    calls.first = call(w.a);
    const first = await calls.first;
    w.race.hold = null;
    if (!calls.second) throw new Error("the second call did not start");
    return [first, await calls.second];
  }

  it("of two creates of one free slug, the unique key answers slug_taken to the second", async () => {
    const w = await slugWorld();
    const [first, second] = await slugRace(w, (user) =>
      w.auth.api.createOrganization({ user, slug: "acme", name: "Acme" }),
    );

    expect(first).toMatchObject({ ok: true, value: { organization: { slug: "acme" } } });
    // The second read found no row. Without the unique key catch, the call throws and the route answers internal.
    expect(second).toMatchObject({ ok: false, code: "slug_taken", status: 409 });
    const orgs = await w.base.findMany("organization", []);
    expect(orgs.map((o) => o.slug)).toEqual(["acme"]);
    // The undo of the second create leaves no member row of b.
    const members = await w.base.findMany("member", []);
    expect(members.map((m) => m.userId)).toEqual(["a"]);
  });

  it("of two renames to one free slug, the unique key answers slug_taken to the second", async () => {
    const w = await slugWorld();
    const one = await w.auth.api.createOrganization({ user: w.a, slug: "one", name: "One" });
    const two = await w.auth.api.createOrganization({ user: w.b, slug: "two", name: "Two" });
    if (!one.ok || !two.ok) throw new Error("the setup create failed");
    const ids: Record<string, string> = {
      a: one.value.organization.id,
      b: two.value.organization.id,
    };
    const [first, second] = await slugRace(w, (user) =>
      w.auth.api.updateOrganization({ user, organizationId: ids[user.id] ?? "", slug: "acme" }),
    );

    expect(first).toMatchObject({ ok: true, value: { slug: "acme" } });
    expect(second).toMatchObject({ ok: false, code: "slug_taken", status: 409 });
    const orgs = await w.base.findMany("organization", []);
    expect(orgs.map((o) => o.slug).sort()).toEqual(["acme", "two"]);
  });
});
