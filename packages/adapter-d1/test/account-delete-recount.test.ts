import { env } from "cloudflare:test";
import { createAuth, type MailMessage, type UserRow } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

// The owner recount of an account delete on the D1 binding (plan 13c Task 1).
// D1 has no lock, so the delete reads the owners of each organization that
// the user owns with another owner again after its member delete. One read
// with an `in` list takes all of them.

/** A view of `db` that keeps the text of each statement that runs, and of each statement of a batch. */
function logging(db: D1Database) {
  const sql: string[] = [];
  const hit = (k: PropertyKey) => k === "run" || k === "all" || k === "first" || k === "raw";
  const texts = new WeakMap<D1PreparedStatement, string>();
  const wrap = (s: D1PreparedStatement, text: string): D1PreparedStatement => {
    const view = new Proxy(s, {
      get(a, k) {
        if (k === "bind") return (...v: unknown[]) => wrap(a.bind(...v), text);
        if (hit(k)) sql.push(text);
        const x = Reflect.get(a, k);
        return typeof x === "function" ? x.bind(a) : x;
      },
    });
    texts.set(view, text);
    return view;
  };
  const logged = new Proxy(db, {
    get(t, k) {
      if (k === "prepare") return (text: string) => wrap(t.prepare(text), text);
      if (k === "batch")
        return (st: D1PreparedStatement[]) => {
          for (const s of st) sql.push(texts.get(s) ?? "");
          return t.batch(st);
        };
      const x = Reflect.get(t, k);
      return typeof x === "function" ? x.bind(t) : x;
    },
  });
  return { db: logged as D1Database, sql };
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

describe("the owner recount of an account delete on D1 (plan 13c Task 1)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it("reads the owners of 2 co-owned organizations in one statement after the member delete (T1-5)", async () => {
    const mail: MailMessage[] = [];
    const auth = make(env.DB, mail);
    const u = await signIn(auth, mail, "ada@example.com");
    const b = await signIn(auth, mail, "bob@example.com");
    const solo = await auth.api.createOrganization({ user: u.user, slug: "solo", name: "Solo" });
    if (!solo.ok) throw new Error(solo.code);
    for (const slug of ["shared-0", "shared-1"]) {
      const made = await auth.api.createOrganization({ user: b.user, slug, name: slug });
      if (!made.ok) throw new Error(made.code);
      const added = await auth.api.addMember({
        user: b.user,
        organizationId: made.value.organization.id,
        userId: u.user.id,
        role: "owner",
      });
      if (!added.ok) throw new Error(added.code);
    }
    const s = await auth.api.getSession(u.token);
    if (!s) throw new Error("no session");
    const { db, sql } = logging(env.DB);
    const done = await make(db, mail).api.user.delete({ session: s, ip: null, userAgent: null });
    expect(done.ok, JSON.stringify(done)).toBe(true);
    // The member delete of the user, then the recount: each member read after it.
    const at = sql.findIndex((q) => /^DELETE FROM ta_member WHERE .*user_id/.test(q));
    expect(at).toBeGreaterThan(-1);
    const recount = sql.slice(at + 1).filter((q) => /^SELECT .* FROM ta_member\b/.test(q));
    expect(recount).toHaveLength(1);
    // A short list binds one mark for each value: both organizations in one read.
    expect(recount[0]).toMatch(/ FROM ta_member WHERE organization_id IN \(\?, \?\)$/);
    const owners = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ta_member WHERE user_id = ? AND role = 'owner'",
    )
      .bind(b.user.id)
      .first<{ n: number }>();
    expect(owners?.n).toBe(2);
  });
});
