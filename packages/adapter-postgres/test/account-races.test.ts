import { createAuth, type MailMessage } from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The account races of plan 12a on the real Postgres adapter, through core's
// built output, with separate connections. The memory adapter runs one call
// at a time, so only Postgres shows these orders. Each test asserts what must
// hold whatever the order of the commits, and runs several rounds to meet
// more orders. A test that passes proves the orders it met, not every order.

const BASE = "https://api.example.com";
const SECRET = "0123456789abcdef0123456789abcdef";
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };
const ROUNDS = 5;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

function world() {
  const sent: MailMessage[] = [];
  const ended: string[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: SECRET,
    trustedOrigins: [],
    storage: createPostgresAdapter(db.sql),
    limiter: OPEN,
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    hooks: {
      session: {
        afterEnd: ({ session, reason }) => {
          ended.push(`${session.id}:${reason}`);
        },
      },
    },
  });
  const tokenOf = (m: MailMessage | undefined) => {
    const token = /token=([A-Za-z0-9_%-]+)/.exec(m?.text ?? "")?.[1];
    if (!token) throw new Error("no link");
    return decodeURIComponent(token);
  };
  async function signIn(email: string) {
    await auth.api.requestMagicLink({ email, ip: null });
    const link = tokenOf([...sent].reverse().find((x) => x.to === email));
    const r = await auth.api.verifyMagicLink({ token: link, ip: null, userAgent: null });
    if (!r.ok) throw new Error(r.code);
    if (!("token" in r.value)) throw new Error("the link answered a challenge");
    const s = await auth.api.getSession(r.value.token);
    if (!s) throw new Error("no session");
    return { ...s, token: r.value.token };
  }
  const signOut = (token: string) =>
    auth.handle(
      new Request(`${BASE}/auth/sign-out`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  return { auth, sent, ended, tokenOf, signIn, signOut };
}

describe("account races on Postgres (plan 12a)", () => {
  it("revoke-others beside eight sign-ins: each ended row fires one hook, and the caller's session stays", async () => {
    const w = world();
    const email = "race@example.com";
    const me = await w.signIn(email);
    for (let round = 0; round < ROUNDS; round++) {
      for (let i = 0; i < 8; i++) await w.auth.api.requestMagicLink({ email, ip: null });
      const links = w.sent
        .filter((m) => m.to === email)
        .slice(-8)
        .map(w.tokenOf);
      w.ended.length = 0;
      const [revoked, ...signIns] = await Promise.all([
        w.auth.api.session.revokeOthers({ session: me }),
        ...links.map((token) => w.auth.api.verifyMagicLink({ token, ip: null, userAgent: null })),
      ]);
      expect(revoked?.ok).toBe(true);
      const rows = await db.sql<
        { id: string }[]
      >`SELECT id FROM ta_session WHERE user_id = ${me.user.id}`;
      const left = new Set(rows.map((r) => r.id));
      expect(left.has(me.session.id)).toBe(true);
      const ids = w.ended.map((e) => e.split(":")[0] ?? "");
      expect(new Set(ids).size).toBe(ids.length);
      for (const e of w.ended) expect(e.endsWith(":revoked")).toBe(true);
      for (const id of ids) expect(left.has(id)).toBe(false);
      // The count is every row the revoke deleted: the hooked rows and the
      // rows that a sign-in committed between the read and the last delete.
      if (revoked?.ok) expect(revoked.value.ended).toBeGreaterThanOrEqual(ids.length);
      expect(signIns.every((r) => r.ok)).toBe(true);
    }
  });

  it("revoke-others beside the sign-outs of the other sessions: each row fires exactly one event", async () => {
    const w = world();
    const email = "outs@example.com";
    const me = await w.signIn(email);
    for (let round = 0; round < ROUNDS; round++) {
      const others = [];
      for (let i = 0; i < 6; i++) others.push(await w.signIn(email));
      w.ended.length = 0;
      const [revoked, ...outs] = await Promise.all([
        w.auth.api.session.revokeOthers({ session: me }),
        ...others.map((o) => w.signOut(o.token)),
      ]);
      expect(revoked?.ok).toBe(true);
      for (const out of outs) expect(out.status).toBe(200);
      // A sign-out that lands between the revoke's read and its delete fired
      // its own event, so the revoke must not fire a second one (plan 9d M-1).
      const ids = w.ended.map((e) => e.split(":")[0] ?? "").sort();
      expect(ids).toEqual(others.map((o) => o.session.id).sort());
      for (const e of w.ended) expect(e).toMatch(/:(revoked|sign_out)$/);
      if (revoked?.ok)
        expect(revoked.value.ended).toBe(w.ended.filter((e) => e.endsWith(":revoked")).length);
      const rows = await db.sql<
        { id: string }[]
      >`SELECT id FROM ta_session WHERE user_id = ${me.user.id}`;
      expect(rows.map((r) => r.id)).toEqual([me.session.id]);
    }
  });

  it("a revoke of one row beside its sign-out and a second revoke: one end wins, and one event fires", async () => {
    const w = world();
    const email = "one@example.com";
    const a = await w.signIn(email);
    const b = await w.signIn(email);
    for (let round = 0; round < ROUNDS; round++) {
      const target = await w.signIn(email);
      w.ended.length = 0;
      const [first, second, out] = await Promise.all([
        w.auth.api.session.revoke({ session: a, id: target.session.id }),
        w.auth.api.session.revoke({ session: b, id: target.session.id }),
        w.signOut(target.token),
      ]);
      expect(out.status).toBe(200);
      const answers = [first, second];
      const won = answers.filter((r) => r?.ok).length;
      expect(won).toBeLessThanOrEqual(1);
      for (const r of answers) if (r && !r.ok) expect(r.code).toBe("not_found");
      // One event for the row: `revoked` when a revoke won, else `sign_out`.
      expect(w.ended).toEqual([`${target.session.id}:${won === 1 ? "revoked" : "sign_out"}`]);
      const rows = await db.sql`SELECT id FROM ta_session WHERE id = ${target.session.id}`;
      expect(rows.length).toBe(0);
    }
  });
});
