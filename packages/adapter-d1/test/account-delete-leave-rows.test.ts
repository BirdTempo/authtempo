import { env } from "cloudflare:test";
import { createAuth, type MailMessage, type UserRow } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

// The leave rows of a self account delete on the D1 binding (plan 13c Task 2).
// D1 has no transaction of its own, so the adapter undoes the writes of a
// failed act. The leave rows are writes of the act: a step after their
// insert that fails takes them back with the member delete.

const INSERT = /^INSERT INTO ta_operator_audit\b/;
const SESSION_WRITE = /^(DELETE FROM|UPDATE) ta_session\b/;

/**
 * A view of `db` that throws on the first write of a session after the first
 * insert of audit rows: a later step of the delete fails. `state` tells what
 * ran.
 */
function failing(db: D1Database) {
  const state = { inserted: false, thrown: false };
  const seen = (text: string) => {
    if (INSERT.test(text)) state.inserted = true;
    else if (state.inserted && !state.thrown && SESSION_WRITE.test(text)) {
      state.thrown = true;
      throw new Error("a later step failed");
    }
  };
  const hit = (k: PropertyKey) => k === "run" || k === "all" || k === "first" || k === "raw";
  const texts = new WeakMap<D1PreparedStatement, string>();
  const wrap = (s: D1PreparedStatement, text: string): D1PreparedStatement => {
    const view = new Proxy(s, {
      get(a, k) {
        if (k === "bind") return (...v: unknown[]) => wrap(a.bind(...v), text);
        const x = Reflect.get(a, k);
        if (hit(k) && typeof x === "function")
          return (...v: unknown[]) => {
            seen(text);
            return x.apply(a, v);
          };
        return typeof x === "function" ? x.bind(a) : x;
      },
    });
    texts.set(view, text);
    return view;
  };
  const view = new Proxy(db, {
    get(t, k) {
      if (k === "prepare") return (text: string) => wrap(t.prepare(text), text);
      if (k === "batch")
        return (st: D1PreparedStatement[]) => {
          for (const s of st) seen(texts.get(s) ?? "");
          return t.batch(st);
        };
      const x = Reflect.get(t, k);
      return typeof x === "function" ? x.bind(t) : x;
    },
  });
  return { db: view as D1Database, state };
}

const make = (db: D1Database, mail: MailMessage[]) =>
  createAuth({
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createD1Adapter(db),
    limiter: { allow: async () => true },
    mail: { send: async (m) => void mail.push(m) },
    organizations: {},
  });

type Auth = ReturnType<typeof make>;

/** A user through a magic link sign-in: the user row and the session token. */
async function signIn(auth: Auth, mail: MailMessage[], email: string) {
  await auth.api.requestMagicLink({ email, ip: null });
  const text = mail.filter((m) => m.to === email).at(-1)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  return { user: r.value.user as UserRow, token: r.value.token };
}

const count = async (sql: string, ...values: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...values)
      .first<{ n: number }>()
  )?.n;

describe("the leave rows of a self account delete on D1 (plan 13c Task 2)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it("a later step throws after the insert: the user, the member rows, the session, and no leave row stay", async () => {
    const mail: MailMessage[] = [];
    const auth = make(env.DB, mail);
    const u = await signIn(auth, mail, "ada@example.com");
    const b = await signIn(auth, mail, "bob@example.com");
    // A plain membership and a co-owned organization: 2 leave rows.
    for (const [slug, role] of [
      ["shared-0", "member"],
      ["shared-1", "owner"],
    ] as const) {
      const made = await auth.api.createOrganization({ user: b.user, slug, name: slug });
      if (!made.ok) throw new Error(made.code);
      const added = await auth.api.addMember({
        user: b.user,
        organizationId: made.value.organization.id,
        userId: u.user.id,
        role,
      });
      if (!added.ok) throw new Error(added.code);
    }
    const s = await auth.api.getSession(u.token);
    if (!s) throw new Error("no session");
    const ALL = "SELECT COUNT(*) AS n FROM ta_operator_audit";
    // The setup writes audit rows too (the member adds).
    const before = await count(ALL);
    const { db, state } = failing(env.DB);
    await expect(
      make(db, mail).api.user.delete({ session: s, ip: null, userAgent: null }),
    ).rejects.toThrow("a later step failed");
    // The insert ran, and the throw came after it.
    expect(state).toEqual({ inserted: true, thrown: true });
    expect(await count(ALL)).toBe(before);
    expect(
      await count(
        `${ALL} WHERE action = 'organization_member_remove' AND target_user_id = ?`,
        u.user.id,
      ),
    ).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM ta_user WHERE id = ?", u.user.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM ta_member WHERE user_id = ?", u.user.id)).toBe(2);
    expect(await auth.api.getSession(u.token)).not.toBeNull();
  });
});
