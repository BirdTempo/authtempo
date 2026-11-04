import { env } from "cloudflare:test";
import { createAuth, type StorageAdapter } from "@authtempo/core";
import { createOrganizationTokenAs } from "@authtempo/core/compat";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");

/**
 * The D1 binding with a count of the statements that run. Each statement of a
 * batch counts, as D1 counts the queries of one Worker invocation. The batch
 * gets the real statements, so the binding sees no wrapper.
 */
function counted(db: D1Database): { db: D1Database; ran: () => number } {
  let n = 0;
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const w = new Proxy(s, {
      get(target, key) {
        if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === "first" || key === "all" || key === "run" || key === "raw")
          return (...args: unknown[]) => {
            n++;
            return (target[key] as (...a: unknown[]) => unknown).apply(target, args);
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    real.set(w, s);
    return w;
  };
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          n += statements.length;
          return target.batch(statements.map((s) => real.get(s) ?? s));
        };
      if (key === "exec") throw new Error("exec is not counted");
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: wrapped, ran: () => n };
}

function instance(storage: StorageAdapter) {
  return createAuth({
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: { allow: async () => true },
    mail: { send: async () => {} },
    clock: { now: () => t0 },
    organizations: {},
  });
}

// The free Workers plan allows 50 D1 queries per invocation (Cloudflare D1 limits, read 2026-10-21).
describe("the D1 statements of an organization token resolve (plan 12k Task 8)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it("runs 50 or fewer statements for a resolve that loses 19 spends and wins the 20th", async () => {
    const storage = createD1Adapter(env.DB);
    const plain = instance(storage);
    const user = await storage.create("user", {
      id: "u1",
      email: "u1@example.com",
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
    const org = await plain.api.createOrganization({ user, slug: "acme", name: "Acme" });
    if (!org.ok) throw new Error(org.code);
    // A user with no sign-in: the compat seam, with the user row's rule (plan 12p).
    const made = await createOrganizationTokenAs(plain, {
      user,
      organizationId: org.value.organization.id,
      name: "ci",
      permissions: {},
      quota: { remaining: 100 },
    });
    if (!made.ok) throw new Error(made.code);
    const resolve = (auth: ReturnType<typeof instance>) =>
      auth.authenticate(
        new Request("https://api.example.com/app", {
          headers: { authorization: `Bearer ${made.value.token}` },
        }),
      );
    // A new adapter, so the count holds the schema version check of a cold isolate too.
    const { db, ran } = counted(env.DB);
    const base = createD1Adapter(db);
    let lost = 0;
    // Before each of the first 19 spends, a rival resolve on the plain storage spends first.
    // That is the worst spend of a token resolve: 20 updates and 19 reads.
    const raced: StorageAdapter = {
      ...base,
      async update(model, where, data) {
        if (model === "organizationToken" && "remaining" in data && lost < 19) {
          lost++;
          const rival = await resolve(plain);
          if (!rival.ok) throw new Error(rival.code);
        }
        return base.update(model, where, data);
      },
    };
    const caller = await resolve(instance(raced));
    expect(caller.ok && caller.value.kind).toBe("organizationToken");
    expect(lost).toBe(19);
    expect(ran()).toBeGreaterThan(40);
    expect(ran()).toBeLessThanOrEqual(50);
  });
});
