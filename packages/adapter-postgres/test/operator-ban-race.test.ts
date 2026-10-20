import { createAuth, createPbkdf2PasswordHash, type MailMessage } from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The ban of plan 12f Task 6 on the real Postgres adapter, through core's
// built output, with separate connections. The memory adapter runs one
// transaction at a time, so only Postgres shows these orders. Each test
// asserts what must hold whatever the order of the commits. A pass proves
// the orders that the rounds met, not every order.

const BASE = "https://api.example.com";
const SECRET = "0123456789abcdef0123456789abcdef";
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };
const APP = { kind: "app", name: "support-tool" } as const;
const PASSWORD = "correct horse battery";

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

function world() {
  const sent: MailMessage[] = [];
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
    // A fast hash: the race, not the hash cost, is under test.
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: { users: true },
  });
  const tokenOf = (m: MailMessage | undefined) => {
    const token = /token=([A-Za-z0-9_%-]+)/.exec(m?.text ?? "")?.[1];
    if (!token) throw new Error("no link");
    return decodeURIComponent(token);
  };
  const linkTo = (email: string) => tokenOf([...sent].reverse().find((m) => m.to === email));
  const magic = (token: string) => auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  async function signIn(email: string) {
    await auth.api.requestMagicLink({ email, ip: null });
    const r = await magic(linkTo(email));
    if (!r.ok) throw new Error(r.code);
    if (!("token" in r.value)) throw new Error("the link answered a challenge");
    const s = await auth.api.getSession(r.value.token);
    if (!s) throw new Error("no session");
    return { ...s, token: r.value.token };
  }
  const ban = (userId: string) =>
    auth.api.operator.users.ban({ actor: APP, userId, reason: "Race", ip: null, userAgent: null });
  const unban = (userId: string) =>
    auth.api.operator.users.unban({
      actor: APP,
      userId,
      reason: "Race",
      ip: null,
      userAgent: null,
    });
  return { auth, sent, linkTo, magic, signIn, ban, unban };
}

/** The live sessions of the user: each row that `resolveSession` still answers. Each resolve also ends a banned row. */
async function liveRows(w: ReturnType<typeof world>, tokens: string[]): Promise<number> {
  let live = 0;
  for (const token of tokens) if (await w.auth.api.getSession(token)) live++;
  return live;
}

describe("the ban on Postgres (plan 12f Task 6)", () => {
  it("keeps one order of locks between a ban and a password change", async () => {
    const w = world();
    const password = w.auth.api.password;
    if (!password) throw new Error("password sign-in is off");
    for (let round = 0; round < 20; round++) {
      const email = `pw-${round}@example.com`;
      const me = await w.signIn(email);
      // A first password needs a fresh session: the sign-in just set it.
      const first = await password.change({ session: me, newPassword: PASSWORD });
      if (!first.ok) throw new Error(first.code);
      // A second session, which both flows delete: their row locks can meet.
      const other = await w.signIn(email);
      const answers = await Promise.allSettled([
        w.ban(me.user.id),
        password.change({
          session: me,
          currentPassword: PASSWORD,
          newPassword: `${PASSWORD} ${round}`,
        }),
      ]);
      // No deadlock error, nor any other throw.
      for (const a of answers)
        expect(a.status, String(a.status === "rejected" && a.reason)).toBe("fulfilled");
      const [banned, changed] = answers.map((a) => (a.status === "fulfilled" ? a.value : null));
      const codes = [banned, changed].filter((r) => r && !r.ok).map((r) => r && !r.ok && r.code);
      // Both commit, or one loses its compare-and-set and answers conflict.
      if (codes.length > 0) expect(codes).toEqual(["conflict"]);
      // Whatever the order, a ban that committed leaves no live session.
      if (banned?.ok) expect(await liveRows(w, [me.token, other.token])).toBe(0);
    }
  }, 60_000);

  it.each(["magic link", "password"] as const)(
    "leaves no live session when a ban commits while sign-ins are in flight: %s",
    async (method) => {
      const w = world();
      const email = "race@example.com";
      const password = w.auth.api.password;
      if (!password) throw new Error("password sign-in is off");
      // The magic link verifies the user, so each sign-in holds the user row.
      // A password sign-up leaves the user unverified: its sign-ins take no
      // row lock, and a sign-in row can commit after the ban's delete began.
      const userId =
        method === "magic link"
          ? (await w.signIn(email)).user.id
          : await (async () => {
              const up = await password.signUp({
                email,
                password: PASSWORD,
                ip: null,
                userAgent: null,
              });
              if (!up.ok) throw new Error(up.code);
              const row = await db.sql<
                { id: string }[]
              >`SELECT id FROM ta_user WHERE email = ${email}`;
              return row[0]?.id ?? "";
            })();
      const signIn = async (): Promise<() => Promise<unknown>> => {
        if (method === "password")
          return () => password.signIn({ email, password: PASSWORD, ip: null, userAgent: null });
        await w.auth.api.requestMagicLink({ email, ip: null });
        const token = w.linkTo(email);
        return () => w.magic(token);
      };
      // The ban starts 0 to 15 ms after the sign-ins, so in some rounds it
      // commits between a sign-in's user read and its commit.
      for (let delay = 0; delay < 16; delay++) {
        const flows = [];
        for (let i = 0; i < 6; i++) flows.push(await signIn());
        const [banned, ...signIns] = await Promise.all([
          (async () => {
            await new Promise((r) => setTimeout(r, delay));
            return w.ban(userId);
          })(),
          ...flows.map((flow) => flow()),
        ]);
        expect(banned?.ok).toBe(true);
        const tokens: string[] = [];
        for (const r of signIns as { ok: boolean; value?: { token?: string }; code?: string }[]) {
          if (r.ok && typeof r.value?.token === "string") tokens.push(r.value.token);
          else expect(r).toMatchObject({ ok: false, code: "account_banned" });
        }
        const rows = () => db.sql`SELECT id FROM ta_session WHERE user_id = ${userId}`;
        // A sign-in that holds the user row waits for the ban, and the read
        // after its insert sees the ban: no row stays (ruling 3).
        if (method === "magic link") expect(await rows()).toHaveLength(0);
        // In odd rounds the unban comes before any token is presented. A row
        // that the ban did not see stays ended after the unban (ruling 28).
        const unbanFirst = delay % 2 === 1;
        if (unbanFirst) expect((await w.unban(userId)).ok).toBe(true);
        // Each token answers null, and its resolve ends a row that the ban did not see.
        expect(await liveRows(w, tokens)).toBe(0);
        expect(await rows()).toHaveLength(0);
        if (!unbanFirst) expect((await w.unban(userId)).ok).toBe(true);
      }
    },
    60_000,
  );
});
