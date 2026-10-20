import { env } from "cloudflare:test";
import { type AuthConfig, createAuth, type MailMessage } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

// The call budget of the operator session calls on real D1 (plan 12f Task 7
// review M2 and m2, ruling 34). D1 Free allows 50 queries per invocation
// (D1 limits page updated 21 April 2026, read 2026-10-21). Core counts
// port calls, and an update in a transaction as 2. This test counts each
// statement that reaches the D1 binding, each statement of a batch as one,
// so it checks that count against D1 itself.

const BASE = "https://api.example.com";
/** Every request passes: the count, not the limit, is under test. */
const OPEN = { allow: async () => true };
const APP = { kind: "app", name: "support-tool" } as const;

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
          // The batch needs the statements of the binding, not the views.
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

/** The engine on `db`, with a `session.afterEnd` hook. */
function engine(db: D1Database, sent: MailMessage[]) {
  const input: AuthConfig = {
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createD1Adapter(db),
    limiter: OPEN,
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: { users: true },
    hooks: { session: { afterEnd: () => {} } },
  };
  return createAuth(input);
}

/** `count` sign-ins of one address by a magic link: the user and its sessions. */
async function signIns(
  auth: ReturnType<typeof engine>,
  sent: MailMessage[],
  email: string,
  count: number,
) {
  let userId = "";
  for (let i = 0; i < count; i++) {
    await auth.api.requestMagicLink({ email, ip: null });
    const text = sent.filter((m) => m.to === email).at(-1)?.text ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
    if (!r.ok || !("token" in r.value)) throw new Error("no session");
    const s = await auth.api.getSession(r.value.token);
    if (!s) throw new Error("no session");
    userId = s.user.id;
  }
  return userId;
}

describe("the operator session calls on D1 (plan 12f Task 7)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it("an endAll of the app with a hook and a full page sends 50 queries, the schema check too", async () => {
    const sent: MailMessage[] = [];
    await signIns(engine(env.DB, sent), sent, "ada@example.com", 60);
    // One invocation: a new adapter, so its first query is the schema check.
    const { db, count } = counting(env.DB);
    const done = await engine(db, sent).api.operator.sessions.endAll({
      actor: APP,
      reason: "Key leak",
      ip: null,
      userAgent: null,
    });
    if (!done.ok) throw new Error(done.code);
    // The schema check, the read, the link read, 46 deletes, and the audit row.
    expect([done.value.ended, done.value.more, count.queries]).toEqual([46, true, 50]);
  });

  it("an endUser of the app with a hook sends 43 queries, the hold batch too", async () => {
    const sent: MailMessage[] = [];
    const userId = await signIns(engine(env.DB, sent), sent, "ada@example.com", 60);
    const { db, count } = counting(env.DB);
    const done = await engine(db, sent).api.operator.sessions.endUser({
      actor: APP,
      userId,
      reason: "Lost laptop",
      ip: null,
      userAgent: null,
    });
    if (!done.ok) throw new Error(done.code);
    // A page keeps calls for the last page, so a page with a hook ends 31 sessions in 43 queries.
    expect([done.value.ended, done.value.more, count.queries]).toEqual([31, true, 43]);
  });
});
