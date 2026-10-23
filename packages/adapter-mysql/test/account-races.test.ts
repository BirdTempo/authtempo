import { createAuth, type MailMessage, type StorageAdapter } from "@authtempo/core";
import { SoftAuthenticator } from "@authtempo/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMysqlAdapter } from "../src/index.js";
import { freshDatabase, MYSQL_84, type MysqlDatabase } from "./db.js";

/** The address of a test user that has one (plan 12i): a user can have no address, so a read checks it. */
function emailOf(user: { email: string | null }): string {
  if (user.email === null) throw new Error("the test user has no address");
  return user.email;
}

// The port of adapter-postgres/test/account-races.test.ts to MySQL 8.4
// (ruling 1 of plan 12g). The account races of plan 12a on the real MySQL
// adapter, through core's built output, with separate connections. The
// memory adapter runs one call at a time, so only a SQL adapter shows these
// orders. Each test asserts what must
// hold whatever the order of the commits, and runs several rounds to meet
// more orders. A test that passes proves the orders it met, not every order.

const BASE = "https://api.example.com";
const SECRET = "0123456789abcdef0123456789abcdef";
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };
const ROUNDS = 5;
/** The pause of a probe: long enough for a flow that waits on no lock to commit (plan 12a Task 11). */
const HOLD_MS = 400;

let db: MysqlDatabase;
beforeEach(async () => {
  db = await freshDatabase(MYSQL_84);
});
afterEach(async () => {
  await db.close();
});

/**
 * The user row through the adapter. MySQL stores updated_at as epoch
 * milliseconds, and the adapter answers a Date, as the Postgres read did.
 */
const readUser = async (id: string) =>
  (await createMysqlAdapter(db.pool).findOne("user", [{ field: "id", op: "eq", value: id }])) ??
  undefined;

function world() {
  const sent: MailMessage[] = [];
  const ended: string[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: SECRET,
    trustedOrigins: [],
    storage: createMysqlAdapter(db.pool),
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

describe("account races on MySQL 8.4 (plan 12a)", () => {
  it("revoke-others beside eight sign-ins, a delay sweep: each new row survives or counts in ended", async () => {
    const w = world();
    const email = "race@example.com";
    const me = await w.signIn(email);
    // With no delay the revoke commits before any sign-in writes its row, in
    // every round (review M2, probe P4a). So the revoke starts 0 to 15 ms
    // after the sign-ins. In some rounds a sign-in then commits between the
    // revoke's read and its last delete (probe P4d: 4 to 7 ms). A pass proves
    // the orders that the rounds met, not every order.
    for (let delay = 0; delay < 16; delay++) {
      for (let i = 0; i < 8; i++) await w.auth.api.requestMagicLink({ email, ip: null });
      const links = w.sent
        .filter((m) => m.to === email)
        .slice(-8)
        .map(w.tokenOf);
      w.ended.length = 0;
      const [revoked, ...signIns] = await Promise.all([
        (async () => {
          await new Promise((r) => setTimeout(r, delay));
          return w.auth.api.session.revokeOthers({ session: me });
        })(),
        ...links.map((token) => w.auth.api.verifyMagicLink({ token, ip: null, userAgent: null })),
      ]);
      if (!revoked?.ok) throw new Error(revoked?.code ?? "no answer");
      expect(signIns.every((r) => r.ok)).toBe(true);
      const rows = await db.q<
        { id: string }[]
      >`SELECT id FROM ta_session WHERE user_id = ${me.user.id}`;
      const left = new Set(rows.map((r) => r.id));
      expect(left.has(me.session.id)).toBe(true);
      const ids = w.ended.map((e) => e.split(":")[0] ?? "");
      expect(new Set(ids).size).toBe(ids.length);
      for (const e of w.ended) expect(e.endsWith(":revoked")).toBe(true);
      for (const id of ids) expect(left.has(id)).toBe(false);
      // Each of the 8 new rows either survives or is in the answered count.
      expect(revoked.value.ended + (left.size - 1)).toBe(8);
      // Clear the round's survivors with no race.
      await w.auth.api.session.revokeOthers({ session: me });
    }
  }, 60_000);

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
      // A sign-out between the revoke's read and its delete fired its own
      // event. The revoke must not fire a second one (plan 9d M-1).
      const ids = w.ended.map((e) => e.split(":")[0] ?? "").sort();
      expect(ids).toEqual(others.map((o) => o.session.id).sort());
      for (const e of w.ended) expect(e).toMatch(/:(revoked|sign_out)$/);
      if (revoked?.ok)
        expect(revoked.value.ended).toBe(w.ended.filter((e) => e.endsWith(":revoked")).length);
      const rows = await db.q<
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
      const rows = await db.q`SELECT id FROM ta_session WHERE id = ${target.session.id}`;
      expect(rows.length).toBe(0);
    }
  });

  it("a delete beside a change of address: one order wins, no deadlock, and no row of a deleted user stays", async () => {
    const w = world();
    for (let round = 0; round < 8; round++) {
      const email = `del-${round}@example.com`;
      const target = `moved-${round}@example.com`;
      const me = await w.signIn(email);
      expect((await w.auth.api.user.changeEmail({ session: me, newEmail: target })).ok).toBe(true);
      const token = w.tokenOf([...w.sent].reverse().find((m) => m.to === target));
      const before = w.sent.length;
      const [deleted, moved] = await Promise.all([
        w.auth.api.user.delete({ session: me, ip: null, userAgent: null }),
        w.auth.api.user.confirmEmailChange({ token, ip: null, userAgent: null }),
      ]);
      // The delete holds the user row as the change does: the later one waits, then reads the row again.
      expect(deleted).toEqual({ ok: true, value: { ok: true } });
      // Ruling 1 of plan 12f2 (B1, Q4): a session past the page of the delete ends at the sweep.
      // The meter of the delete also counts the statements of the parallel confirm on this
      // adapter, so in some rounds the page ends no session. The door refuses that session
      // at once, before the sweep (ruling 3 of plan 12f2): the user row is gone.
      expect(await w.auth.api.getSession(me.token)).toBeNull();
      await w.auth.api.sweepExpired();
      const left = await db.q`SELECT id FROM ta_user WHERE id = ${me.user.id}`;
      expect(left).toHaveLength(0);
      for (const table of ["ta_identity", "ta_session", "ta_member"]) {
        const rows = await db.q`SELECT id FROM ${db.q(table)} WHERE user_id = ${me.user.id}`;
        expect(rows, table).toHaveLength(0);
      }
      const deletedNotice = w.sent
        .slice(before)
        .filter((m) => m.text.startsWith("Your account was deleted."));
      // The move committed first: the delete read the moved row, and its notice goes to the new address.
      expect(deletedNotice.map((m) => m.to)).toEqual([moved.ok ? target : email]);
      if (!moved.ok) expect(["invalid_token", "token_expired"]).toContain(moved.code);
    }
  }, 60_000);
});

describe("user hook races on MySQL 8.4 (plan 12a Task 5, review M3)", () => {
  it("parallel magic links of one new address: one user and one user.afterCreate", async () => {
    const sent: MailMessage[] = [];
    const events: string[] = [];
    const auth = createAuth({
      baseURL: BASE,
      secret: SECRET,
      trustedOrigins: [],
      storage: createMysqlAdapter(db.pool),
      limiter: OPEN,
      mail: {
        send: async (m) => {
          sent.push(m);
        },
      },
      hooks: {
        user: {
          beforeCreate: (e) => {
            events.push(`before:${e.user.id}`);
          },
          afterCreate: (e) => {
            events.push(`after:${e.user.id}`);
          },
        },
      },
    });
    const raced: number[] = [];
    for (let round = 0; round < 8; round++) {
      const email = `race${round}@example.com`;
      const links: string[] = [];
      for (let i = 0; i < 6; i++) {
        await auth.api.requestMagicLink({ email, ip: null });
        const token = /token=([A-Za-z0-9_%-]+)/.exec(sent.at(-1)?.text ?? "")?.[1];
        if (!token) throw new Error("no link");
        links.push(decodeURIComponent(token));
      }
      events.length = 0;
      const all = await Promise.all(
        links.map((token) => auth.api.verifyMagicLink({ token, ip: null, userAgent: null })),
      );
      expect(all.every((r) => r.ok)).toBe(true);
      const users = await db.q`SELECT id FROM ta_user WHERE email = ${email}`;
      expect(users).toHaveLength(1);
      raced.push(events.filter((e) => e.startsWith("before:")).length);
      // One row, so one afterCreate, with that row's id, whatever the order of the commits.
      expect(events.filter((e) => e.startsWith("after:"))).toEqual([`after:${users[0]?.id}`]);
    }
    // The race must show in some round: more than one attempt minted a row.
    expect(Math.max(...raced)).toBeGreaterThan(1);
  }, 60000);
});

// The compare-and-set of the profile update (review M1 of Task 7). The text
// is the reviewer's, with the file's BASE, SECRET, and OPEN.
/** The profile fields of a user row, as afterUpdate and a SELECT give them. */
type ProfileRow = { name: string | null; image: string | null; updatedAt: Date };

describe("the profile update races on MySQL 8.4 (plan 12a Task 7)", () => {
  it("parallel updates of one user: each afterUpdate gets the row its write replaced", async () => {
    const sent: MailMessage[] = [];
    const after: { previous: ProfileRow; user: ProfileRow }[] = [];
    let befores = 0;
    const auth = createAuth({
      baseURL: BASE,
      secret: SECRET,
      trustedOrigins: [],
      storage: createMysqlAdapter(db.pool),
      limiter: OPEN,
      mail: {
        send: async (m) => {
          sent.push(m);
        },
      },
      hooks: {
        user: {
          beforeUpdate: async () => {
            befores++;
            // Hold the round open, so a parallel write can land first.
            await new Promise((r) => setTimeout(r, 5));
          },
          afterUpdate: (e) => {
            after.push({ previous: e.previous, user: e.user });
          },
        },
      },
    });
    await auth.api.requestMagicLink({ email: "ada@example.com", ip: null });
    const token = /token=([A-Za-z0-9_%-]+)/.exec(sent.at(-1)?.text ?? "")?.[1];
    if (!token) throw new Error("no link");
    const r = await auth.api.verifyMagicLink({
      token: decodeURIComponent(token),
      ip: null,
      userAgent: null,
    });
    if (!r.ok || !("token" in r.value)) throw new Error("no session");
    const s = await auth.api.getSession(r.value.token);
    if (!s) throw new Error("no session");
    const raced: number[] = [];
    for (let round = 0; round < 6; round++) {
      after.length = 0;
      befores = 0;
      const initial = await readUser(s.user.id);
      const patches = [
        { name: `N${round}a` },
        { image: `https://img.example.com/${round}b.png` },
        { name: `N${round}c` },
        { image: `https://img.example.com/${round}d.png` },
      ];
      const all = await Promise.all(patches.map((p) => auth.api.user.update({ session: s, ...p })));
      for (const x of all) expect(x.ok || x.code === "conflict").toBe(true);
      const oks = all.filter((x) => x.ok).length;
      expect(after).toHaveLength(oks);
      raced.push(befores - all.length);
      // The chain: each write replaced the row that the one before it wrote.
      const chain = [...after].sort(
        (a, b) => a.user.updatedAt.getTime() - b.user.updatedAt.getTime(),
      );
      let prev: ProfileRow | undefined = initial;
      for (const e of chain) {
        expect({
          name: e.previous.name,
          image: e.previous.image,
          at: e.previous.updatedAt.getTime(),
        }).toEqual({
          name: prev?.name ?? null,
          image: prev?.image ?? null,
          at: prev?.updatedAt.getTime(),
        });
        prev = e.user;
      }
      const final = await readUser(s.user.id);
      expect(final?.updatedAt.getTime()).toBe(prev?.updatedAt.getTime());
      expect({ name: final?.name, image: final?.image }).toEqual({
        name: prev?.name,
        image: prev?.image,
      });
    }
    // The race must show: some round ran user.beforeUpdate more than once for one update.
    expect(Math.max(...raced)).toBeGreaterThan(0);
  }, 60000);
});

describe("the change of address races on MySQL 8.4 (plan 12a Task 8)", () => {
  it("two users confirm one new address at once: one moves, one answers email_taken", async () => {
    const w = world();
    const ada = await w.signIn("ada@example.com");
    const bob = await w.signIn("bob@example.com");
    for (let round = 0; round < ROUNDS; round++) {
      const target = `shared${round}@example.com`;
      const sessions = [ada, bob].map((s) => w.auth.api.getSession(s.token));
      const [a, b] = await Promise.all(sessions);
      if (!a || !b) throw new Error("no session");
      expect((await w.auth.api.user.changeEmail({ session: a, newEmail: target })).ok).toBe(true);
      expect((await w.auth.api.user.changeEmail({ session: b, newEmail: target })).ok).toBe(true);
      const tokens = w.sent
        .filter((m) => m.to === target)
        .map((m) => decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(m.text)?.[1] ?? ""));
      expect(tokens).toHaveLength(2);
      const answers = await Promise.all(
        tokens.map((token) =>
          w.auth.api.user.confirmEmailChange({ token, ip: null, userAgent: null }),
        ),
      );
      expect(answers.map((x) => (x.ok ? "ok" : x.code)).sort()).toEqual(["email_taken", "ok"]);
      const rows = await db.q<{ id: string }[]>`SELECT id FROM ta_user WHERE email = ${target}`;
      expect(rows).toHaveLength(1);
      const ids = await db.q<
        { user_id: string }[]
      >`SELECT user_id FROM ta_identity WHERE provider = 'email' AND subject = ${target}`;
      expect(ids.map((r) => r.user_id)).toEqual([rows[0]?.id]);
      // One notice, to the old address of the winner.
      const winner = rows[0]?.id === ada.user.id ? a : b;
      expect(w.sent.filter((m) => m.subject.startsWith("Security notice")).at(-1)?.to).toBe(
        winner.user.email,
      );
    }
  }, 60_000);

  it("two confirms of one link at once: one moves, one answers invalid_token", async () => {
    const w = world();
    let s = await w.signIn("ada@example.com");
    for (let round = 0; round < ROUNDS; round++) {
      const target = `ada${round}@example.com`;
      expect((await w.auth.api.user.changeEmail({ session: s, newEmail: target })).ok).toBe(true);
      const token = w.tokenOf([...w.sent].reverse().find((m) => m.to === target));
      const before = w.sent.filter((m) => m.subject.startsWith("Security notice")).length;
      const answers = await Promise.all(
        [0, 1].map(() => w.auth.api.user.confirmEmailChange({ token, ip: null, userAgent: null })),
      );
      // The loser answers by its timing (review-12a-task11 L4). A confirm that
      // reads the token after the winner's commit finds it spent. One that
      // read it before checks the new address after that commit, and finds
      // it taken. Both leave one move and one notice.
      expect([
        ["invalid_token", "ok"],
        ["email_taken", "ok"],
      ]).toContainEqual(answers.map((x) => (x.ok ? "ok" : x.code)).sort());
      expect(w.sent.filter((m) => m.subject.startsWith("Security notice")).length).toBe(before + 1);
      const next = await w.auth.api.getSession(s.token);
      if (!next) throw new Error("the requesting session ended");
      expect(next.user.email).toBe(target);
      s = { ...next, token: s.token };
    }
  }, 60_000);

  it("a confirm beside profile updates of the same user: each afterUpdate gets the row its write replaced", async () => {
    const sent: MailMessage[] = [];
    const after: { previous: MoveRow; user: MoveRow }[] = [];
    let befores = 0;
    const auth = createAuth({
      baseURL: BASE,
      secret: SECRET,
      trustedOrigins: [],
      storage: createMysqlAdapter(db.pool),
      limiter: OPEN,
      mail: {
        send: async (m) => {
          sent.push(m);
        },
      },
      hooks: {
        user: {
          beforeUpdate: async () => {
            befores++;
            // Hold the round open, so a parallel write can land first.
            await new Promise((r) => setTimeout(r, 5));
          },
          afterUpdate: (e) => {
            after.push({ previous: e.previous, user: e.user });
          },
        },
      },
    });
    await auth.api.requestMagicLink({ email: "ada@example.com", ip: null });
    const link = /token=([A-Za-z0-9_%-]+)/.exec(sent.at(-1)?.text ?? "")?.[1];
    if (!link) throw new Error("no link");
    const v = await auth.api.verifyMagicLink({
      token: decodeURIComponent(link),
      ip: null,
      userAgent: null,
    });
    if (!v.ok || !("token" in v.value)) throw new Error("no session");
    const raced: number[] = [];
    let email = "ada@example.com";
    for (let round = 0; round < 6; round++) {
      const s = await auth.api.getSession(v.value.token);
      if (!s) throw new Error("no session");
      const target = `moved${round}@example.com`;
      expect((await auth.api.user.changeEmail({ session: s, newEmail: target })).ok).toBe(true);
      const token = decodeURIComponent(
        /token=([A-Za-z0-9_%-]+)/.exec(sent.findLast((m) => m.to === target)?.text ?? "")?.[1] ??
          "",
      );
      after.length = 0;
      befores = 0;
      const initial = await readUser(s.user.id);
      const [moved, ...updates] = await Promise.all([
        auth.api.user.confirmEmailChange({ token, ip: null, userAgent: null }),
        auth.api.user.update({ session: s, name: `N${round}a` }),
        auth.api.user.update({ session: s, name: `N${round}b` }),
      ]);
      expect(moved?.ok || moved?.code === "conflict").toBe(true);
      for (const x of updates) expect(x.ok || x.code === "conflict").toBe(true);
      raced.push(befores - 3);
      const chain = [...after].sort(
        (a, b) => a.user.updatedAt.getTime() - b.user.updatedAt.getTime(),
      );
      let prev: MoveRow | undefined = initial;
      for (const e of chain) {
        expect({
          email: e.previous.email,
          name: e.previous.name,
          at: e.previous.updatedAt.getTime(),
        }).toEqual({ email: prev?.email, name: prev?.name ?? null, at: prev?.updatedAt.getTime() });
        prev = e.user;
      }
      const final = await readUser(s.user.id);
      expect({ email: final?.email, name: final?.name, at: final?.updatedAt.getTime() }).toEqual({
        email: prev?.email,
        name: prev?.name,
        at: prev?.updatedAt.getTime(),
      });
      if (moved?.ok) email = target;
      expect(final?.email).toBe(email);
    }
    // The race must show: some round ran user.beforeUpdate more than once for one call.
    expect(Math.max(...raced)).toBeGreaterThan(0);
  }, 60_000);
});

interface MoveRow {
  email: string | null;
  name: string | null;
  updatedAt: Date;
}

describe("the last-credential guard on MySQL 8.4 (plan 12a Task 9)", () => {
  const RP = { rpID: "api.example.com", rpName: "Example", origins: [BASE] };
  const NOTICE = "Security notice for your api.example.com account";

  function guardWorld() {
    const sent: MailMessage[] = [];
    const unlinked: string[] = [];
    // The claims of the next Google callback. The seam answers them for any token.
    let claims: Record<string, unknown> = {};
    const auth = createAuth({
      baseURL: BASE,
      secret: SECRET,
      trustedOrigins: [],
      storage: createMysqlAdapter(db.pool),
      limiter: OPEN,
      mail: {
        send: async (m) => {
          sent.push(m);
        },
      },
      passkey: RP,
      social: {
        google: { clientId: "gid", clientSecret: "gsecret" },
        fetch: async () =>
          Response.json({ id_token: "t", access_token: "at", token_type: "Bearer" }),
      },
      jwt: {
        verifyIdToken: async () => claims,
        signES256: async () => "unused",
      },
      hooks: {
        identity: {
          afterUnlink: ({ identity }) => {
            unlinked.push(identity.subject);
          },
        },
      },
    });
    async function google(email: string, sub: string, verified: boolean) {
      const started = await auth.api.startSocial({ provider: "google", next: "/home", ip: null });
      if (!started.ok) throw new Error(started.code);
      const url = new URL(started.value.location);
      claims = {
        sub,
        email,
        email_verified: verified,
        name: "Ada",
        nonce: url.searchParams.get("nonce"),
      };
      const done = await auth.api.completeSocial({
        provider: "google",
        state: url.searchParams.get("state"),
        code: "c",
        error: null,
        bindToken: started.value.bindToken,
        ip: null,
        userAgent: null,
      });
      if (!done.ok) throw new Error(done.code);
      if (!("token" in done.value)) throw new Error("the sign-in answered a challenge");
      const s = await auth.api.getSession(done.value.token);
      if (!s) throw new Error("no session");
      return s;
    }
    async function addPasskey(
      user: Parameters<typeof auth.api.passkeyRegistrationOptions>[0]["user"],
    ) {
      const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: BASE });
      const options = await auth.api.passkeyRegistrationOptions({ user });
      if (!options.ok) throw new Error(options.code);
      const added = await auth.api.verifyPasskeyRegistration({
        user,
        response: await soft.register(options.value.challenge, new TextEncoder().encode(user.id)),
      });
      if (!added.ok) throw new Error(added.code);
      return added.value.id;
    }
    const notices = (to: string) => sent.filter((m) => m.to === to && m.subject === NOTICE);
    return { auth, sent, unlinked, google, addPasskey, notices };
  }

  const delayed = <T>(ms: number, run: () => Promise<T>) =>
    new Promise<T>((done, failed) => {
      setTimeout(() => run().then(done, failed), ms);
    });

  it("parallel removals of a verified user's ways in, a delay sweep: each answers ok, and each notice goes once", async () => {
    // A verified user: the proved address is a way in, so every removal may
    // pass. The second and third removals wait for the lock, read the row
    // again, and take the lock on the new row: no false conflict.
    const w = guardWorld();
    for (let delay = 0; delay < 12; delay++) {
      const email = `sweep-${delay}@example.com`;
      await w.auth.api.requestMagicLink({ email, ip: null });
      const link = /token=([A-Za-z0-9_%-]+)/.exec(
        [...w.sent].reverse().find((m) => m.to === email)?.text ?? "",
      )?.[1];
      if (!link) throw new Error("no link");
      const signed = await w.auth.api.verifyMagicLink({
        token: decodeURIComponent(link),
        ip: null,
        userAgent: null,
      });
      if (!signed.ok) throw new Error(signed.code);
      // The verified address links Google to the same user.
      const me = await w.google(email, `g-sweep-${delay}`, true);
      const [identity] = await db.q<{ id: string }[]>`
        SELECT id FROM ta_identity WHERE user_id = ${me.user.id} AND provider = 'google'`;
      if (!identity) throw new Error("no google identity");
      const one = await w.addPasskey(me.user);
      const two = await w.addPasskey(me.user);
      w.unlinked.length = 0;
      const answers = await Promise.all([
        w.auth.api.identities.unlink({ session: me, id: identity.id, ip: null, userAgent: null }),
        delayed(delay >> 1, () => w.auth.api.deletePasskey({ user: me.user, id: one })),
        delayed(delay, () => w.auth.api.deletePasskey({ user: me.user, id: two })),
      ]);
      expect(answers.map((a) => (a.ok ? "ok" : a.code))).toEqual(["ok", "ok", "ok"]);
      const identities = await db.q`SELECT provider FROM ta_identity WHERE user_id = ${me.user.id}`;
      expect(identities.map((r) => r.provider)).toEqual(["email"]);
      const passkeys = await db.q`SELECT id FROM ta_passkey WHERE user_id = ${me.user.id}`;
      expect(passkeys).toHaveLength(0);
      expect(w.unlinked).toEqual([`g-sweep-${delay}`]);
      expect(
        w
          .notices(email)
          .map((m) => m.text.split("\n")[0])
          .filter((line) => line?.includes("removed")),
      ).toHaveLength(3);
    }
  }, 60_000);

  it("parallel unlinks of an unverified user's only identity: each answers last_credential, and the identity stays", async () => {
    // A Google sign-in with an unproved address: the identity is the one way in (spec 8.3).
    const w = guardWorld();
    for (let round = 0; round < ROUNDS; round++) {
      const me = await w.google(`claim-${round}@example.com`, `g-claim-${round}`, false);
      expect(me.user.emailVerified).toBe(false);
      const [identity] = await db.q<{ id: string }[]>`
        SELECT id FROM ta_identity WHERE user_id = ${me.user.id}`;
      if (!identity) throw new Error("no identity");
      const answers = await Promise.all(
        [0, 1, 2].map((ms) =>
          delayed(ms, () =>
            w.auth.api.identities.unlink({
              session: me,
              id: identity.id,
              ip: null,
              userAgent: null,
            }),
          ),
        ),
      );
      expect(answers.map((a) => (a.ok ? "ok" : a.code))).toEqual([
        "last_credential",
        "last_credential",
        "last_credential",
      ]);
      const left = await db.q`SELECT id FROM ta_identity WHERE user_id = ${me.user.id}`;
      expect(left).toHaveLength(1);
      expect(w.unlinked).toEqual([]);
    }
  }, 60_000);
});

describe("the link of a social identity on MySQL 8.4 (plan 12a Task 10)", () => {
  const NOTICE = "Security notice for your api.example.com account";
  const LINKED = "A sign-in provider was linked to your account.";

  /**
   * `inLink` runs inside each link's transaction, from `identity.beforeLink`.
   * `probe.afterLinkWrite` runs once, inside the next link's transaction,
   * after its last statement (plan 12a Task 11: the delete beside a link).
   */
  function linkWorld(
    inLink?: () => Promise<void>,
    probe: { afterLinkWrite: (() => Promise<void>) | null } = { afterLinkWrite: null },
  ) {
    const sent: MailMessage[] = [];
    const linked: string[] = [];
    // The token endpoint answers the code as the ID token, and the seam
    // answers the claims of that code. So each callback has its own claims.
    const claims = new Map<string, Record<string, unknown>>();
    // `meet` holds the next two identity reads of the outer store until both
    // wait. So both checks pass before either write, and the identity's
    // unique key decides: the order that a sweep meets only in some rounds.
    const adapter = createMysqlAdapter(db.pool);
    let gate: { left: number; held: (() => void)[] } | null = null;
    const meet = () => {
      gate = { left: 2, held: [] };
    };
    const storage: typeof adapter = {
      ...adapter,
      findOne: (async (model, where) => {
        const g = gate;
        if (model === "identity" && g && g.left > 0) {
          g.left--;
          await new Promise<void>((go) => {
            g.held.push(go);
            if (g.held.length === 2) for (const release of g.held) release();
          });
        }
        return adapter.findOne(model, where);
      }) as typeof adapter.findOne,
      transaction: ((fn: (tx: StorageAdapter) => Promise<unknown>) =>
        adapter.transaction((tx) => {
          let linked = false;
          return fn({
            ...tx,
            create: (async (model, data) => {
              const row = await tx.create(model, data);
              if (model === "identity") linked = true;
              return row;
            }) as typeof tx.create,
            update: (async (model, where, data) => {
              const n = await tx.update(model, where, data);
              const after = probe.afterLinkWrite;
              if (model === "session" && linked && after) {
                probe.afterLinkWrite = null;
                await after();
              }
              return n;
            }) as typeof tx.update,
          });
        })) as typeof adapter.transaction,
    };
    const auth = createAuth({
      baseURL: BASE,
      secret: SECRET,
      trustedOrigins: [],
      storage,
      limiter: OPEN,
      mail: {
        send: async (m) => {
          sent.push(m);
        },
      },
      social: {
        google: { clientId: "gid", clientSecret: "gsecret" },
        fetch: async (_url, init) =>
          Response.json({
            id_token: new URLSearchParams(String(init?.body ?? "")).get("code"),
            access_token: "at",
            token_type: "Bearer",
          }),
      },
      jwt: {
        verifyIdToken: async ({ token }) => claims.get(token) ?? {},
        signES256: async () => "unused",
      },
      hooks: {
        identity: {
          beforeLink: async () => {
            await inLink?.();
          },
          afterLink: ({ user, identity }) => {
            linked.push(`${identity.subject}:${user.id}`);
          },
        },
      },
    });
    async function signIn(email: string) {
      await auth.api.requestMagicLink({ email, ip: null });
      const link = /token=([A-Za-z0-9_%-]+)/.exec(
        [...sent].reverse().find((m) => m.to === email)?.text ?? "",
      )?.[1];
      if (!link) throw new Error("no link");
      const r = await auth.api.verifyMagicLink({
        token: decodeURIComponent(link),
        ip: null,
        userAgent: null,
      });
      if (!r.ok) throw new Error(r.code);
      if (!("token" in r.value)) throw new Error("the link answered a challenge");
      const s = await auth.api.getSession(r.value.token);
      if (!s) throw new Error("no session");
      return { ...s, token: r.value.token };
    }
    type Me = Awaited<ReturnType<typeof signIn>>;
    async function begin(me: Me) {
      const r = await auth.api.startLink({ provider: "google", session: me, ip: null });
      if (!r.ok) throw new Error(r.code);
      const url = new URL(r.value.location);
      return {
        state: url.searchParams.get("state"),
        nonce: url.searchParams.get("nonce"),
        bindToken: r.value.bindToken,
      };
    }
    /** The callback of `s` in the browser of `me`; the provider answers `sub` with `email`. */
    async function finish(
      me: Me,
      s: Awaited<ReturnType<typeof begin>>,
      code: string,
      sub: string,
      email: string,
    ) {
      claims.set(code, { sub, email, email_verified: true, nonce: s.nonce });
      const r = await auth.api.completeSocial({
        provider: "google",
        state: s.state,
        code,
        error: null,
        bindToken: s.bindToken,
        sessionToken: me.token,
        ip: null,
        userAgent: null,
      });
      return r.ok ? ("linked" in r.value ? "linked" : "signed_in") : r.code;
    }
    const linkNotices = (to: string) =>
      sent.filter((m) => m.to === to && m.subject === NOTICE && m.text.startsWith(LINKED));
    const rowsOf = (sub: string) =>
      db.q<{ user_id: string }[]>`
        SELECT user_id FROM ta_identity WHERE provider = 'google' AND subject = ${sub}`;
    return { auth, linked, meet, signIn, begin, finish, linkNotices, rowsOf };
  }

  const delayed = <T>(ms: number, run: () => Promise<T>) =>
    new Promise<T>((done, failed) => {
      setTimeout(() => run().then(done, failed), ms);
    });

  it("three callbacks of one link state at once, a delay sweep: one links, and two answer invalid_token", async () => {
    const w = linkWorld();
    for (let delay = 0; delay < 12; delay++) {
      const email = `state-${delay}@example.com`;
      const sub = `g-state-${delay}`;
      const me = await w.signIn(email);
      const s = await w.begin(me);
      w.linked.length = 0;
      const answers = await Promise.all([
        w.finish(me, s, `a-${delay}`, sub, email),
        delayed(delay >> 1, () => w.finish(me, s, `b-${delay}`, sub, email)),
        delayed(delay, () => w.finish(me, s, `c-${delay}`, sub, email)),
      ]);
      expect(answers.sort()).toEqual(["invalid_token", "invalid_token", "linked"]);
      expect((await w.rowsOf(sub)).map((r) => r.user_id)).toEqual([me.user.id]);
      expect(w.linked).toEqual([`${sub}:${me.user.id}`]);
      expect(w.linkNotices(email)).toHaveLength(1);
    }
  }, 60_000);

  it("two users link one provider account at once, a delay sweep: one links, and the other answers identity_taken", async () => {
    // The provider moved the account's address between the two
    // authorizations, so each callback carries its own user's address. Both
    // checks can pass, and then the identity's unique key decides.
    const w = linkWorld();
    for (let delay = 0; delay < 12; delay++) {
      const sub = `g-pair-${delay}`;
      const ada = await w.signIn(`ada-${delay}@example.com`);
      const bob = await w.signIn(`bob-${delay}@example.com`);
      const a = await w.begin(ada);
      const b = await w.begin(bob);
      w.linked.length = 0;
      const answers = await Promise.all([
        w.finish(ada, a, `ada-${delay}`, sub, emailOf(ada.user)),
        delayed(delay, () => w.finish(bob, b, `bob-${delay}`, sub, emailOf(bob.user))),
      ]);
      expect([...answers].sort()).toEqual(["identity_taken", "linked"]);
      const winner = answers[0] === "linked" ? ada : bob;
      expect((await w.rowsOf(sub)).map((r) => r.user_id)).toEqual([winner.user.id]);
      expect(w.linked).toEqual([`${sub}:${winner.user.id}`]);
      expect(
        w.linkNotices(emailOf(ada.user)).length + w.linkNotices(emailOf(bob.user)).length,
      ).toBe(1);
      expect(w.linkNotices(emailOf(winner.user))).toHaveLength(1);
    }
  }, 60_000);

  it("two link states of one user, called back at once, a delay sweep: both link, and one identity, afterLink, and notice", async () => {
    const w = linkWorld();
    for (let delay = 0; delay < 12; delay++) {
      const email = `tabs-${delay}@example.com`;
      const sub = `g-tabs-${delay}`;
      const me = await w.signIn(email);
      const one = await w.begin(me);
      const two = await w.begin(me);
      w.linked.length = 0;
      const answers = await Promise.all([
        w.finish(me, one, `one-${delay}`, sub, email),
        delayed(delay, () => w.finish(me, two, `two-${delay}`, sub, email)),
      ]);
      expect(answers).toEqual(["linked", "linked"]);
      expect((await w.rowsOf(sub)).map((r) => r.user_id)).toEqual([me.user.id]);
      expect(w.linked).toEqual([`${sub}:${me.user.id}`]);
      expect(w.linkNotices(email)).toHaveLength(1);
    }
  }, 60_000);

  it("two users link one provider account, both checks first: one links, and the other answers identity_taken", async () => {
    const w = linkWorld();
    for (let round = 0; round < ROUNDS; round++) {
      const sub = `g-met-${round}`;
      const ada = await w.signIn(`ada-met-${round}@example.com`);
      const bob = await w.signIn(`bob-met-${round}@example.com`);
      const a = await w.begin(ada);
      const b = await w.begin(bob);
      w.linked.length = 0;
      w.meet();
      const answers = await Promise.all([
        w.finish(ada, a, `ada-met-${round}`, sub, emailOf(ada.user)),
        w.finish(bob, b, `bob-met-${round}`, sub, emailOf(bob.user)),
      ]);
      expect([...answers].sort()).toEqual(["identity_taken", "linked"]);
      const winner = answers[0] === "linked" ? ada : bob;
      expect((await w.rowsOf(sub)).map((r) => r.user_id)).toEqual([winner.user.id]);
      expect(w.linked).toEqual([`${sub}:${winner.user.id}`]);
      expect(
        w.linkNotices(emailOf(ada.user)).length + w.linkNotices(emailOf(bob.user)).length,
      ).toBe(1);
    }
  }, 60_000);

  it("two link states of one user, both checks first: both link, and one identity, afterLink, and notice", async () => {
    const w = linkWorld();
    for (let round = 0; round < ROUNDS; round++) {
      const email = `tabs-met-${round}@example.com`;
      const sub = `g-tabs-met-${round}`;
      const me = await w.signIn(email);
      const one = await w.begin(me);
      const two = await w.begin(me);
      w.linked.length = 0;
      w.meet();
      const answers = await Promise.all([
        w.finish(me, one, `one-met-${round}`, sub, email),
        w.finish(me, two, `two-met-${round}`, sub, email),
      ]);
      expect(answers).toEqual(["linked", "linked"]);
      expect((await w.rowsOf(sub)).map((r) => r.user_id)).toEqual([me.user.id]);
      expect(w.linked).toEqual([`${sub}:${me.user.id}`]);
      expect(w.linkNotices(email)).toHaveLength(1);
    }
  }, 60_000);

  it("a sign-out that commits inside the link's transaction undoes the link", async () => {
    // The hook runs between the session read and the last statement, on
    // another connection: the window of a parallel sign-out.
    let token = "";
    const w = linkWorld(async () => {
      const out = await w.auth.handle(
        new Request(`${BASE}/auth/sign-out`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(out.status).toBe(200);
    });
    for (let round = 0; round < ROUNDS; round++) {
      const email = `out-${round}@example.com`;
      const sub = `g-out-${round}`;
      const me = await w.signIn(email);
      token = me.token;
      const s = await w.begin(me);
      expect(await w.finish(me, s, `out-${round}`, sub, email)).toBe("invalid_token");
      expect(await w.rowsOf(sub)).toEqual([]);
      expect(await db.q`SELECT id FROM ta_session WHERE id = ${me.session.id}`).toEqual([]);
      expect(w.linked).toEqual([]);
      expect(w.linkNotices(email)).toEqual([]);
    }
  }, 60_000);

  it("a delete beside a link that wrote its last statement: the delete waits, then the identity goes too", async () => {
    // The link holds its session row until the commit. The delete removes
    // the sessions before the identities, so it waits at the session, and
    // its identity delete then sees the committed link.
    const probe: { afterLinkWrite: (() => Promise<void>) | null } = { afterLinkWrite: null };
    const w = linkWorld(undefined, probe);
    for (let round = 0; round < ROUNDS; round++) {
      const email = `link-del-${round}@example.com`;
      const sub = `g-link-del-${round}`;
      const me = await w.signIn(email);
      const s = await w.begin(me);
      let deleting: ReturnType<typeof w.auth.api.user.delete> | null = null;
      probe.afterLinkWrite = async () => {
        deleting = w.auth.api.user.delete({ session: me, ip: null, userAgent: null });
        await new Promise((r) => setTimeout(r, HOLD_MS));
      };
      expect(await w.finish(me, s, `link-del-${round}`, sub, email)).toBe("linked");
      expect(await deleting).toEqual({ ok: true, value: { ok: true } });
      expect(await w.rowsOf(sub)).toEqual([]);
      expect(await db.q`SELECT id FROM ta_identity WHERE user_id = ${me.user.id}`).toEqual([]);
      expect(await db.q`SELECT id FROM ta_session WHERE user_id = ${me.user.id}`).toEqual([]);
    }
  }, 60_000);

  it("a delete that commits inside the link's transaction undoes the link", async () => {
    let current: Awaited<ReturnType<ReturnType<typeof linkWorld>["signIn"]>> | null = null;
    const w = linkWorld(async () => {
      if (!current) return;
      const me = current;
      current = null;
      expect(await w.auth.api.user.delete({ session: me, ip: null, userAgent: null })).toEqual({
        ok: true,
        value: { ok: true },
      });
    });
    for (let round = 0; round < ROUNDS; round++) {
      const email = `link-in-${round}@example.com`;
      const sub = `g-link-in-${round}`;
      const me = await w.signIn(email);
      const s = await w.begin(me);
      current = me;
      expect(await w.finish(me, s, `link-in-${round}`, sub, email)).toBe("invalid_token");
      expect(await w.rowsOf(sub)).toEqual([]);
      expect(await db.q`SELECT id FROM ta_user WHERE id = ${me.user.id}`).toEqual([]);
      expect(await db.q`SELECT id FROM ta_identity WHERE user_id = ${me.user.id}`).toEqual([]);
    }
  }, 60_000);
});

describe("two claims of one user on MySQL 8.4 (plan 12a Task 18, review M1)", () => {
  it("two magic links of one unverified user at once: one claim, one afterVerify, and two live sessions", async () => {
    // A barrier in user.beforeVerify lets both flows read the unverified row
    // before either claims. The claim flips the flag only on an unverified
    // row, so the second flow finds none and undoes its attempt. Its retry
    // signs in the verified user. Without the condition, both claim:
    // the pair fires twice, and the second claim ends the first session.
    let arrived = 0;
    let release: () => void = () => {};
    let together = Promise.resolve();
    const before: string[] = [];
    const after: string[] = [];
    const sent: MailMessage[] = [];
    const auth = createAuth({
      baseURL: BASE,
      secret: SECRET,
      trustedOrigins: [],
      storage: createMysqlAdapter(db.pool),
      limiter: OPEN,
      password: { uniformSignUp: false },
      mail: {
        send: async (m) => {
          sent.push(m);
        },
      },
      hooks: {
        user: {
          beforeVerify: async ({ user }) => {
            before.push(user.id);
            arrived += 1;
            if (arrived === 2) release();
            // A flow that waits more than 2 s goes on alone: the test then fails on its counts.
            await Promise.race([together, new Promise((r) => setTimeout(r, 2_000))]);
          },
          afterVerify: ({ user }) => {
            after.push(user.id);
          },
        },
      },
    });
    const linkTo = async (email: string) => {
      await auth.api.requestMagicLink({ email, ip: null });
      const m = [...sent].reverse().find((x) => x.to === email && /token=/.test(x.text));
      return decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(m?.text ?? "")?.[1] ?? "");
    };
    for (let round = 0; round < ROUNDS; round++) {
      const email = `twice-${round}@example.com`;
      const up = await auth.api.password?.signUp({
        email,
        password: "correct horse battery",
        ip: null,
        userAgent: null,
      });
      if (!up?.ok || !("session" in up.value)) throw new Error("no sign-up session");
      const userId = up.value.user.id;
      const links = [await linkTo(email), await linkTo(email)];
      arrived = 0;
      together = new Promise<void>((r) => {
        release = r;
      });
      const answers = await Promise.all(
        links.map((token) => auth.api.verifyMagicLink({ token, ip: null, userAgent: null })),
      );
      expect(before.filter((id) => id === userId)).toHaveLength(2);
      expect(after.filter((id) => id === userId)).toEqual([userId]);
      for (const a of answers) {
        if (!a.ok || !("token" in a.value)) throw new Error("a claim answered no session");
        expect((await auth.api.getSession(a.value.token))?.user.emailVerified).toBe(true);
      }
    }
  }, 60_000);
});

describe("the account delete on MySQL 8.4 (plan 12a Task 11)", () => {
  /** The rows that name `userId` in the tables a sign-in writes, and the user row. */
  async function rowsOf(userId: string) {
    const count = async (table: string, column: string) =>
      (await db.q`SELECT 1 FROM ${db.q(table)} WHERE ${db.q(column)} = ${userId}`).length;
    return {
      user: await count("ta_user", "id"),
      session: await count("ta_session", "user_id"),
      identity: await count("ta_identity", "user_id"),
      member: await count("ta_member", "user_id"),
    };
  }
  const NONE = { user: 0, session: 0, identity: 0, member: 0 };

  /**
   * Probes inside the engine's transactions, on the real adapter, each one
   * shot. `inSignIn` runs from `session.beforeCreate`, before the sign-in's
   * first write. `afterSessionCheck` runs after a sign-in's read of the user
   * row that follows its session insert. `afterRecount` runs after the
   * delete's recount of the owners. `afterOwnMembers` runs after the delete
   * of the user's member rows. `afterOrganizationMembers` runs after the
   * first member delete of an organization that goes. `inDelete` runs from
   * `user.beforeDelete` (plan 12a Task 11 round 2). `inVerify` runs from
   * `user.beforeVerify`, and `verified` holds the user ids of
   * `user.afterVerify` (plan 12a Task 18).
   */
  function deleteWorld(uniformSignUp = true) {
    const sent: MailMessage[] = [];
    const ended: string[] = [];
    const verified: string[] = [];
    const probes: Record<
      | "inSignIn"
      | "afterSessionCheck"
      | "afterRecount"
      | "afterOwnMembers"
      | "afterOrganizationMembers"
      | "inDelete"
      | "inVerify",
      (() => Promise<void>) | null
    > = {
      inSignIn: null,
      afterSessionCheck: null,
      afterRecount: null,
      afterOwnMembers: null,
      afterOrganizationMembers: null,
      inDelete: null,
      inVerify: null,
    };
    const take = (name: keyof typeof probes) => {
      const p = probes[name];
      probes[name] = null;
      return p;
    };
    const adapter = createMysqlAdapter(db.pool);
    const wrap = (tx: StorageAdapter): StorageAdapter => {
      let wroteSession = false;
      let droppedMembers = false;
      return {
        ...tx,
        create: (async (model, data) => {
          const row = await tx.create(model, data);
          if (model === "session") wroteSession = true;
          return row;
        }) as typeof tx.create,
        findOne: (async (model, where) => {
          const row = await tx.findOne(model, where);
          const p = model === "user" && wroteSession ? take("afterSessionCheck") : null;
          if (p) await p();
          return row;
        }) as typeof tx.findOne,
        delete: (async (model, where) => {
          const n = await tx.delete(model, where);
          if (model === "member" && where[0]?.field === "userId") {
            droppedMembers = true;
            await take("afterOwnMembers")?.();
          }
          if (model === "member" && where[0]?.field === "organizationId")
            await take("afterOrganizationMembers")?.();
          return n;
        }) as typeof tx.delete,
        findMany: (async (model, where, opts) => {
          const rows = await tx.findMany(model, where, opts);
          const p = model === "member" && droppedMembers ? take("afterRecount") : null;
          if (p) await p();
          return rows;
        }) as typeof tx.findMany,
      };
    };
    const storage: StorageAdapter = {
      ...adapter,
      transaction: ((fn: (tx: StorageAdapter) => Promise<unknown>) =>
        adapter.transaction((tx) => fn(wrap(tx)))) as typeof adapter.transaction,
    };
    const auth = createAuth({
      baseURL: BASE,
      secret: SECRET,
      trustedOrigins: [],
      storage,
      limiter: OPEN,
      organizations: {},
      password: { uniformSignUp },
      mail: {
        send: async (m) => {
          sent.push(m);
        },
      },
      hooks: {
        session: {
          beforeCreate: async () => {
            await take("inSignIn")?.();
          },
          afterEnd: ({ session, reason }) => {
            ended.push(`${session.id}:${reason}`);
          },
        },
        user: {
          beforeDelete: async () => {
            await take("inDelete")?.();
          },
          beforeVerify: async () => {
            await take("inVerify")?.();
          },
          afterVerify: ({ user }) => {
            verified.push(user.id);
          },
        },
      },
    });
    const linkFor = async (email: string) => {
      await auth.api.requestMagicLink({ email, ip: null });
      const m = [...sent].reverse().find((x) => x.to === email && /token=/.test(x.text));
      const token = /token=([A-Za-z0-9_%-]+)/.exec(m?.text ?? "")?.[1];
      if (!token) throw new Error("no link");
      return decodeURIComponent(token);
    };
    async function signIn(email: string) {
      const r = await auth.api.verifyMagicLink({
        token: await linkFor(email),
        ip: null,
        userAgent: null,
      });
      if (!r.ok) throw new Error(r.code);
      if (!("token" in r.value)) throw new Error("the link answered a challenge");
      const s = await auth.api.getSession(r.value.token);
      if (!s) throw new Error("no session");
      return { ...s, token: r.value.token };
    }
    const codeOf = (email: string) =>
      /\b(\d{6})\b/.exec([...sent].reverse().find((x) => x.to === email)?.text ?? "")?.[1] ?? "";
    /** The token of the newest mail to `email` that carries a link. */
    const linkTo = (email: string) => {
      const m = [...sent].reverse().find((x) => x.to === email && /token=/.test(x.text));
      return decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(m?.text ?? "")?.[1] ?? "");
    };
    return { auth, sent, ended, verified, probes, linkFor, linkTo, signIn, codeOf };
  }

  it("a delete that commits inside a sign-in's transaction undoes the session and the identity", async () => {
    // The hook runs before the sign-in's first write, on another connection.
    // The sign-in then writes a session and an email identity for a user
    // that is gone. Its read of the user row after the insert undoes both.
    const w = deleteWorld();
    for (let round = 0; round < ROUNDS; round++) {
      const email = `inside-${round}@example.com`;
      const me = await w.signIn(email);
      const link = await w.linkFor(email);
      let deleted: Awaited<ReturnType<typeof w.auth.api.user.delete>> | null = null;
      w.probes.inSignIn = async () => {
        deleted = await w.auth.api.user.delete({ session: me, ip: null, userAgent: null });
      };
      expect(await w.auth.api.verifyMagicLink({ token: link, ip: null, userAgent: null })).toEqual({
        ok: false,
        code: "conflict",
        status: 409,
      });
      expect(deleted).toEqual({ ok: true, value: { ok: true } });
      expect(await rowsOf(me.user.id)).toEqual(NONE);
    }
  }, 60_000);

  it("a delete that commits inside user.beforeVerify undoes the claim: conflict, no afterVerify, and no row of the user stays (plan 12a Task 18)", async () => {
    // The hook runs before the claim's first write, so the claim holds no
    // lock, and the delete on another connection commits. The claim's read
    // of the user row after its session insert then undoes the claim. A
    // hook after the hold of the user row would make the delete wait for
    // the claim's commit: the claim would answer ok.
    const w = deleteWorld(false);
    for (let round = 0; round < ROUNDS; round++) {
      const email = `claim-${round}@example.com`;
      const up = await w.auth.api.password?.signUp({
        email,
        password: "correct horse battery",
        ip: null,
        userAgent: null,
      });
      if (!up?.ok || !("token" in up.value)) throw new Error("no sign-up session");
      const me = await w.auth.api.getSession(up.value.token);
      if (!me) throw new Error("no session");
      expect(me.user.emailVerified).toBe(false);
      const link = await w.linkFor(email);
      let deleting: ReturnType<typeof w.auth.api.user.delete> | null = null;
      let deleted: unknown = null;
      w.probes.inVerify = async () => {
        deleting = w.auth.api.user.delete({ session: me, ip: null, userAgent: null });
        deleted = await Promise.race([
          deleting,
          new Promise((r) => setTimeout(() => r("the delete waited"), HOLD_MS * 5)),
        ]);
      };
      const claim = await w.auth.api.verifyMagicLink({ token: link, ip: null, userAgent: null });
      expect(deleted).toEqual({ ok: true, value: { ok: true } });
      expect(claim).toEqual({ ok: false, code: "conflict", status: 409 });
      await deleting;
      expect(w.verified).toEqual([]);
      expect(await rowsOf(me.user.id)).toEqual(NONE);
    }
  }, 60_000);

  it("a sign-in that holds the user row: a delete that starts after its session check waits, then ends the session", async () => {
    // Without the hold, the delete commits during the pause, before the
    // sign-in's commit, and the session of a gone user stays.
    const w = deleteWorld();
    for (let round = 0; round < ROUNDS; round++) {
      const email = `held-${round}@example.com`;
      const me = await w.signIn(email);
      const link = await w.linkFor(email);
      w.ended.length = 0;
      let deleting: ReturnType<typeof w.auth.api.user.delete> | null = null;
      w.probes.afterSessionCheck = async () => {
        deleting = w.auth.api.user.delete({ session: me, ip: null, userAgent: null });
        await new Promise((r) => setTimeout(r, HOLD_MS));
      };
      const r = await w.auth.api.verifyMagicLink({ token: link, ip: null, userAgent: null });
      expect(r.ok).toBe(true);
      expect(await deleting).toEqual({ ok: true, value: { ok: true } });
      expect(await rowsOf(me.user.id)).toEqual(NONE);
      // The first sign-in's session and the held one: each ends once, by the delete.
      expect(w.ended.filter((e) => e.endsWith(":account_deleted"))).toHaveLength(2);
    }
  }, 60_000);

  it("an owner leaves beside the delete of the other owner: the organization keeps an owner", async () => {
    // The pause comes after the delete's recount. The leave then waits at
    // the owner lock, and answers conflict after the delete commits.
    const w = deleteWorld();
    for (let round = 0; round < ROUNDS; round++) {
      const me = await w.signIn(`own-a-${round}@example.com`);
      const carol = await w.signIn(`own-c-${round}@example.com`);
      const made = await w.auth.api.createOrganization({
        user: me.user,
        slug: `team-${round}`,
        name: "Team",
      });
      if (!made.ok) throw new Error(made.code);
      const id = made.value.organization.id;
      const added = await w.auth.api.addMember({
        user: me.user,
        organizationId: id,
        userId: carol.user.id,
        role: "owner",
      });
      if (!added.ok) throw new Error(added.code);
      let leaving: ReturnType<typeof w.auth.api.removeMember> | null = null;
      w.probes.afterRecount = async () => {
        leaving = w.auth.api.removeMember({
          user: carol.user,
          organizationId: id,
          userId: carol.user.id,
        });
        await new Promise((r) => setTimeout(r, HOLD_MS));
      };
      expect(await w.auth.api.user.delete({ session: me, ip: null, userAgent: null })).toEqual({
        ok: true,
        value: { ok: true },
      });
      expect(await leaving).toEqual({ ok: false, code: "conflict", status: 409 });
      const owners = await db.q<{ user_id: string }[]>`
        SELECT user_id FROM ta_member WHERE organization_id = ${id} AND role = 'owner'`;
      expect(owners.map((o) => o.user_id)).toEqual([carol.user.id]);
    }
  }, 60_000);

  it("a delete beside a reset that holds its link row: no deadlock, and the reset undoes", async () => {
    // The reset spends its link row before its session hook, then holds the
    // user row. The delete holds the user row first. So the delete must not
    // wait for that link row before its commit: it deletes the proofs after.
    const w = deleteWorld();
    for (let round = 0; round < ROUNDS; round++) {
      const email = `reset-${round}@example.com`;
      const me = await w.signIn(email);
      const password = w.auth.api.password;
      if (!password) throw new Error("no password config");
      expect((await password.requestReset({ email, ip: null })).ok).toBe(true);
      const token = w.linkTo(email);
      let deleting: ReturnType<typeof w.auth.api.user.delete> | null = null;
      w.probes.inSignIn = async () => {
        deleting = w.auth.api.user.delete({ session: me, ip: null, userAgent: null });
        await new Promise((r) => setTimeout(r, HOLD_MS));
      };
      const reset = await password.reset({
        token,
        password: "a reset long password",
        ip: null,
        userAgent: null,
      });
      expect(await deleting).toEqual({ ok: true, value: { ok: true } });
      expect(reset).toEqual({ ok: false, code: "conflict", status: 409 });
      expect(await rowsOf(me.user.id)).toEqual(NONE);
      expect(await db.q`SELECT id FROM ta_password WHERE user_id = ${me.user.id}`).toEqual([]);
      expect(await db.q`SELECT id FROM ta_verification WHERE identifier = ${email}`).toEqual([]);
    }
  }, 60_000);

  it("a delete beside a sign-in, a re-authentication, and a revoke, a delay sweep: no row of the deleted user stays", async () => {
    const w = deleteWorld();
    for (let delay = 0; delay < 12; delay++) {
      const email = `sweep-${delay}@example.com`;
      const me = await w.signIn(email);
      const other = await w.signIn(email);
      const third = await w.signIn(email);
      const link = await w.linkFor(email);
      expect((await w.auth.api.session.requestReauthCode({ session: other })).ok).toBe(true);
      const code = w.codeOf(email);
      w.ended.length = 0;
      const [deleted, signedIn, reauthed, revoked] = await Promise.all([
        new Promise<Awaited<ReturnType<typeof w.auth.api.user.delete>>>((done, failed) => {
          setTimeout(() => {
            w.auth.api.user.delete({ session: me, ip: null, userAgent: null }).then(done, failed);
          }, delay);
        }),
        w.auth.api.verifyMagicLink({ token: link, ip: null, userAgent: null }),
        w.auth.api.session.reauthenticate({ session: other, proof: { emailCode: code }, ip: null }),
        w.auth.api.session.revoke({ session: me, id: third.session.id }),
      ]);
      expect(deleted).toEqual({ ok: true, value: { ok: true } });
      expect(await rowsOf(me.user.id)).toEqual(NONE);
      // A sign-in after the commit finds no user and makes a new one, a
      // sign-up. A sign-in before it is ended by the delete (the row check above).
      // After its commit, the delete removes the verification rows of the user and
      // the address (account-delete.ts). A sign-in that reads its link after that
      // finds no link, and answers invalid_token. A re-authentication that reads its
      // code after that finds no code, and answers invalid_code. Both answers are
      // correct: the link and the code went with the account (ruling 49 of plan 12k).
      if (!signedIn.ok) expect(["conflict", "invalid_token"]).toContain(signedIn.code);
      if (!reauthed.ok)
        expect(["unauthorized", "invalid_token", "invalid_code"]).toContain(reauthed.code);
      if (!revoked.ok) expect(revoked.code).toBe("not_found");
      // Each ended row fires one event.
      const ids = w.ended.map((e) => e.split(":")[0]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  }, 60_000);
  /** A delete of `me` that pauses inside its transaction while `writer` starts on another connection. */
  async function writerDuring<T>(
    w: ReturnType<typeof deleteWorld>,
    probe: "afterOwnMembers" | "afterOrganizationMembers",
    me: Awaited<ReturnType<ReturnType<typeof deleteWorld>["signIn"]>>,
    writer: () => Promise<T>,
  ) {
    let writing: Promise<T> | null = null;
    w.probes[probe] = async () => {
      writing = writer();
      await new Promise((r) => setTimeout(r, HOLD_MS));
    };
    const deleted = await w.auth.api.user.delete({ session: me, ip: null, userAgent: null });
    if (!writing) throw new Error("the probe did not run");
    return { deleted, written: await (writing as Promise<T>) };
  }
  const CONFLICT = { ok: false, code: "conflict", status: 409 };
  const DELETED = { ok: true, value: { ok: true } };
  const invitationOf = (w: ReturnType<typeof deleteWorld>, email: string) => {
    const m = [...w.sent].reverse().find((x) => x.to === email && /invitation=/.test(x.text));
    const token = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(m?.text ?? "")?.[1];
    if (!token) throw new Error("no invitation mail");
    return token;
  };
  const membersOf = (organizationId: string) =>
    db.q<{ user_id: string }[]>`
      SELECT user_id FROM ta_member WHERE organization_id = ${organizationId}`;

  it("two deletes of the co-owners of two organizations: one passes, one answers conflict, no deadlock (review m1)", async () => {
    // A joined O1 first and C joined O2 first, so their member rows list the
    // two organizations in opposite orders. Both reach user.beforeDelete
    // before either takes an owner lock.
    const w = deleteWorld();
    for (let round = 0; round < 3; round++) {
      const a = await w.signIn(`m1-a-${round}@example.com`);
      const c = await w.signIn(`m1-c-${round}@example.com`);
      const o1 = await w.auth.api.createOrganization({
        user: a.user,
        slug: `o1-${round}`,
        name: "O1",
      });
      const o2 = await w.auth.api.createOrganization({
        user: c.user,
        slug: `o2-${round}`,
        name: "O2",
      });
      if (!o1.ok || !o2.ok) throw new Error("no organizations");
      for (const [by, id, userId] of [
        [a.user, o1.value.organization.id, c.user.id],
        [c.user, o2.value.organization.id, a.user.id],
      ] as const) {
        const added = await w.auth.api.addMember({
          user: by,
          organizationId: id,
          userId,
          role: "owner",
        });
        if (!added.ok) throw new Error(added.code);
      }
      let arrived = 0;
      let open: () => void = () => {};
      const both = new Promise<void>((go) => {
        open = go;
      });
      // A probe runs once, so the first arrival sets it again for the second.
      const meet = async () => {
        arrived++;
        if (arrived === 1) w.probes.inDelete = meet;
        if (arrived === 2) open();
        await both;
      };
      w.probes.inDelete = meet;
      const first = w.auth.api.user.delete({ session: a, ip: null, userAgent: null });
      const second = w.auth.api.user.delete({ session: c, ip: null, userAgent: null });
      const answers = await Promise.all([first, second]);
      expect(answers.map((x) => (x.ok ? "ok" : x.code)).sort()).toEqual(["conflict", "ok"]);
      const users = await db.q`SELECT id FROM ta_user WHERE id IN (${a.user.id}, ${c.user.id})`;
      expect(users).toHaveLength(1);
    }
  }, 60_000);

  it("an owner write that commits between the delete's rule and its owner lock makes the delete answer conflict (review L1)", async () => {
    const w = deleteWorld();
    for (let round = 0; round < ROUNDS; round++) {
      const me = await w.signIn(`l1-a-${round}@example.com`);
      const carol = await w.signIn(`l1-c-${round}@example.com`);
      const team = await w.auth.api.createOrganization({
        user: me.user,
        slug: `l1-${round}`,
        name: "Team",
      });
      if (!team.ok) throw new Error(team.code);
      const id = team.value.organization.id;
      const added = await w.auth.api.addMember({
        user: me.user,
        organizationId: id,
        userId: carol.user.id,
        role: "owner",
      });
      if (!added.ok) throw new Error(added.code);
      let renamed: unknown = null;
      w.probes.inDelete = async () => {
        await new Promise((r) => setTimeout(r, 2));
        renamed = await w.auth.api.updateOrganization({
          user: carol.user,
          organizationId: id,
          name: "Renamed",
        });
      };
      expect(await w.auth.api.user.delete({ session: me, ip: null, userAgent: null })).toEqual(
        CONFLICT,
      );
      expect(renamed).toMatchObject({ ok: true });
      expect((await membersOf(id)).map((m) => m.user_id).sort()).toEqual(
        [me.user.id, carol.user.id].sort(),
      );
    }
  }, 60_000);

  it("an organization create that starts during the delete waits, then answers conflict (review m2, Q2)", async () => {
    const w = deleteWorld();
    for (let round = 0; round < ROUNDS; round++) {
      const me = await w.signIn(`q2-create-${round}@example.com`);
      const r = await writerDuring(w, "afterOwnMembers", me, () =>
        w.auth.api.createOrganization({ user: me.user, slug: `ghost-${round}`, name: "Ghost" }),
      );
      expect(r.deleted).toEqual(DELETED);
      expect(r.written).toEqual(CONFLICT);
      expect(await db.q`SELECT id FROM ta_organization WHERE slug = ${`ghost-${round}`}`).toEqual(
        [],
      );
      expect(await rowsOf(me.user.id)).toEqual(NONE);
    }
  }, 60_000);

  it("a member add of the user that starts during the delete waits, then answers conflict", async () => {
    const w = deleteWorld();
    const bob = await w.signIn("q2-add-bob@example.com");
    for (let round = 0; round < ROUNDS; round++) {
      const team = await w.auth.api.createOrganization({
        user: bob.user,
        slug: `add-${round}`,
        name: "Team",
      });
      if (!team.ok) throw new Error(team.code);
      const me = await w.signIn(`q2-add-${round}@example.com`);
      const r = await writerDuring(w, "afterOwnMembers", me, () =>
        w.auth.api.addMember({
          user: bob.user,
          organizationId: team.value.organization.id,
          userId: me.user.id,
          role: "member",
        }),
      );
      expect(r.deleted).toEqual(DELETED);
      expect(r.written).toEqual(CONFLICT);
      expect((await membersOf(team.value.organization.id)).map((m) => m.user_id)).toEqual([
        bob.user.id,
      ]);
    }
  }, 60_000);

  it("an accept by the user that starts during the delete waits, then answers conflict", async () => {
    const w = deleteWorld();
    const bob = await w.signIn("q2-accept-bob@example.com");
    for (let round = 0; round < ROUNDS; round++) {
      const club = await w.auth.api.createOrganization({
        user: bob.user,
        slug: `club-${round}`,
        name: "Club",
      });
      if (!club.ok) throw new Error(club.code);
      const email = `q2-accept-${round}@example.com`;
      const me = await w.signIn(email);
      const sent = await w.auth.api.inviteMember({
        user: bob.user,
        organizationId: club.value.organization.id,
        email,
        role: "member",
      });
      if (!sent.ok) throw new Error(sent.code);
      const token = invitationOf(w, email);
      const r = await writerDuring(w, "afterOwnMembers", me, () =>
        w.auth.api.acceptInvitation({ user: me.user, token, ip: null }),
      );
      expect(r.deleted).toEqual(DELETED);
      expect(r.written).toEqual(CONFLICT);
      expect((await membersOf(club.value.organization.id)).map((m) => m.user_id)).toEqual([
        bob.user.id,
      ]);
    }
  }, 60_000);

  it("an accept into an organization that goes, after the delete took its invitations: invalid_token", async () => {
    const w = deleteWorld();
    for (let round = 0; round < ROUNDS; round++) {
      const me = await w.signIn(`solo-late-${round}@example.com`);
      const solo = await w.auth.api.createOrganization({
        user: me.user,
        slug: `late-${round}`,
        name: "Solo",
      });
      if (!solo.ok) throw new Error(solo.code);
      const carolEmail = `solo-late-carol-${round}@example.com`;
      const carol = await w.signIn(carolEmail);
      const sent = await w.auth.api.inviteMember({
        user: me.user,
        organizationId: solo.value.organization.id,
        email: carolEmail,
        role: "member",
      });
      if (!sent.ok) throw new Error(sent.code);
      const token = invitationOf(w, carolEmail);
      const r = await writerDuring(w, "afterOrganizationMembers", me, () =>
        w.auth.api.acceptInvitation({ user: carol.user, token, ip: null }),
      );
      expect(r.deleted).toEqual(DELETED);
      expect(r.written).toMatchObject({ ok: false, code: "invalid_token" });
      expect(await membersOf(solo.value.organization.id)).toEqual([]);
      expect(
        await db.q`SELECT id FROM ta_organization WHERE id = ${solo.value.organization.id}`,
      ).toEqual([]);
    }
  }, 60_000);

  it("an accept that commits during the delete's hooks makes the delete answer conflict, and the organization stays", async () => {
    const w = deleteWorld();
    for (let round = 0; round < ROUNDS; round++) {
      const me = await w.signIn(`solo-early-${round}@example.com`);
      const solo = await w.auth.api.createOrganization({
        user: me.user,
        slug: `early-${round}`,
        name: "Solo",
      });
      if (!solo.ok) throw new Error(solo.code);
      const carolEmail = `solo-early-carol-${round}@example.com`;
      const carol = await w.signIn(carolEmail);
      const sent = await w.auth.api.inviteMember({
        user: me.user,
        organizationId: solo.value.organization.id,
        email: carolEmail,
        role: "member",
      });
      if (!sent.ok) throw new Error(sent.code);
      const token = invitationOf(w, carolEmail);
      let accepted: unknown = null;
      w.probes.inDelete = async () => {
        accepted = await w.auth.api.acceptInvitation({ user: carol.user, token, ip: null });
      };
      expect(await w.auth.api.user.delete({ session: me, ip: null, userAgent: null })).toEqual(
        CONFLICT,
      );
      expect(accepted).toMatchObject({ ok: true });
      expect((await membersOf(solo.value.organization.id)).map((m) => m.user_id).sort()).toEqual(
        [me.user.id, carol.user.id].sort(),
      );
      expect(await rowsOf(me.user.id)).toMatchObject({ user: 1 });
    }
  }, 60_000);

  it("a gated reset that starts during the delete waits, then answers conflict and writes no identity", async () => {
    const w = deleteWorld();
    for (let round = 0; round < ROUNDS; round++) {
      const email = `gated-${round}@example.com`;
      const me = await w.signIn(email);
      const password = w.auth.api.password;
      if (!password) throw new Error("no password config");
      const first = await password.change({ session: me, newPassword: "a first long password" });
      if (!first.ok) throw new Error(first.code);
      const on = await w.auth.handle(
        new Request(`${BASE}/auth/second-factor/email/enable`, {
          method: "POST",
          headers: { authorization: `Bearer ${me.token}`, "content-type": "application/json" },
          body: JSON.stringify({ password: "a first long password" }),
        }),
      );
      expect(on.status).toBe(200);
      expect((await password.requestReset({ email, ip: null })).ok).toBe(true);
      const token = w.linkTo(email);
      const r = await writerDuring(w, "afterOwnMembers", me, () =>
        password.reset({ token, password: "a reset long password", ip: null, userAgent: null }),
      );
      expect(r.deleted).toEqual(DELETED);
      expect(r.written).toEqual(CONFLICT);
      expect(await rowsOf(me.user.id)).toEqual(NONE);
      expect(await db.q`SELECT id FROM ta_password WHERE user_id = ${me.user.id}`).toEqual([]);
    }
  }, 60_000);

  it("a first password that starts during the delete waits, then answers conflict", async () => {
    const w = deleteWorld();
    for (let round = 0; round < ROUNDS; round++) {
      const me = await w.signIn(`first-pw-${round}@example.com`);
      const password = w.auth.api.password;
      if (!password) throw new Error("no password config");
      const r = await writerDuring(w, "afterOwnMembers", me, () =>
        password.change({ session: me, newPassword: "a first long password" }),
      );
      expect(r.deleted).toEqual(DELETED);
      expect(r.written).toEqual(CONFLICT);
      expect(await db.q`SELECT id FROM ta_password WHERE user_id = ${me.user.id}`).toEqual([]);
    }
  }, 60_000);
});

describe("the mailed delete confirm on MySQL 8.4 (plan 12a Task 20)", () => {
  /**
   * Two instances on one database: `on` with `account.deleteConfirm`, and
   * `off` without it, as during a deploy that turns the key on.
   */
  function confirmWorld() {
    const sent: MailMessage[] = [];
    const make = (deleteConfirm: false | { ttlMinutes: number }) =>
      createAuth({
        baseURL: BASE,
        secret: SECRET,
        trustedOrigins: [],
        storage: createMysqlAdapter(db.pool),
        limiter: OPEN,
        mail: {
          send: async (m) => {
            sent.push(m);
          },
        },
        account: { deleteConfirm },
      });
    const on = make({ ttlMinutes: 60 });
    const off = make(false);
    const linkTo = (email: string, subject: string) => {
      const m = [...sent].reverse().find((x) => x.to === email && x.subject.startsWith(subject));
      const token = /token=([A-Za-z0-9_%-]+)/.exec(m?.text ?? "")?.[1];
      if (!token) throw new Error("no link");
      return decodeURIComponent(token);
    };
    async function signIn(email: string) {
      await on.api.requestMagicLink({ email, ip: null });
      const r = await on.api.verifyMagicLink({
        token: linkTo(email, "Sign in"),
        ip: null,
        userAgent: null,
      });
      if (!r.ok || !("token" in r.value)) throw new Error("no session");
      const s = await on.api.getSession(r.value.token);
      if (!s) throw new Error("no session");
      return s;
    }
    async function asked(email: string) {
      const me = await signIn(email);
      const r = await on.api.user.delete({ session: me, ip: null, userAgent: null });
      expect(r).toEqual({ ok: true, value: { sent: true } });
      return { me, token: linkTo(email, "Confirm the delete") };
    }
    const userLeft = async (id: string) =>
      (await db.q`SELECT id FROM ta_user WHERE id = ${id}`).length;
    return { on, off, sent, signIn, asked, linkTo, userLeft };
  }

  it("two confirms of one link from two sessions at once: one deletes, the other answers not_found", async () => {
    const w = confirmWorld();
    for (let round = 0; round < ROUNDS; round++) {
      const email = `twice-${round}@example.com`;
      const { me, token } = await w.asked(email);
      const other = await w.signIn(email);
      const answers = await Promise.all(
        [me, other].map((session) =>
          w.on.api.user.confirmDelete({ session, token, ip: null, userAgent: null }),
        ),
      );
      // The user row is the lock: the second waits, then finds no user.
      expect(answers.filter((a) => a.ok)).toHaveLength(1);
      expect(answers.filter((a) => !a.ok)).toEqual([{ ok: false, code: "not_found", status: 404 }]);
      expect(await w.userLeft(me.user.id)).toBe(0);
      const sessions = await db.q`SELECT id FROM ta_session WHERE user_id = ${me.user.id}`;
      expect(sessions).toHaveLength(0);
    }
  }, 60_000);

  it("a confirm beside a direct delete of an instance with the key off: one deletes, the other answers not_found", async () => {
    const w = confirmWorld();
    for (let round = 0; round < ROUNDS; round++) {
      const email = `both-${round}@example.com`;
      const { me, token } = await w.asked(email);
      const answers = await Promise.all([
        w.on.api.user.confirmDelete({ session: me, token, ip: null, userAgent: null }),
        w.off.api.user.delete({ session: me, ip: null, userAgent: null }),
      ]);
      expect(answers.filter((a) => a.ok)).toHaveLength(1);
      expect(answers.filter((a) => !a.ok)).toEqual([{ ok: false, code: "not_found", status: 404 }]);
      expect(await w.userLeft(me.user.id)).toBe(0);
      const notices = w.sent.filter(
        (m) => m.to === email && m.text.startsWith("Your account was deleted."),
      );
      expect(notices).toHaveLength(1);
    }
  }, 60_000);

  it("three parallel requests of one user leave one live link, the hash of a mailed token (review m3)", async () => {
    const w = confirmWorld();
    for (let round = 0; round < ROUNDS * 2; round++) {
      const email = `three-${round}@example.com`;
      const me = await w.signIn(email);
      const before = w.sent.length;
      const answers = await Promise.all(
        [0, 1, 2].map(() => w.on.api.user.delete({ session: me, ip: null, userAgent: null })),
      );
      for (const a of answers) expect(a).toEqual({ ok: true, value: { sent: true } });
      const tokens = w.sent
        .slice(before)
        .filter((m) => m.to === email && m.subject.startsWith("Confirm the delete"))
        .map((m) => decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(m.text)?.[1] ?? ""));
      // The stored form: the lowercase hex SHA-256 of the clear token.
      const mailed = await Promise.all(
        tokens.map(async (t) => {
          const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
          return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
        }),
      );
      expect(mailed).toHaveLength(3);
      // The hold of the user row runs the three one at a time: the last one's row stays.
      const live = await db.q`
        SELECT value_hash FROM ta_verification
        WHERE purpose = 'account-delete' AND identifier = ${me.user.id} AND consumed_at IS NULL`;
      expect(live, `round ${round}`).toHaveLength(1);
      expect(mailed).toContain(live[0]?.value_hash);
    }
  }, 60_000);

  it("a confirm beside a change of address, a delay sweep: one wins, and the other answers invalid_token", async () => {
    const w = confirmWorld();
    const won = { delete: 0, move: 0 };
    // The move starts first, and the confirm after a delay: the sweep meets both orders of the lock.
    const delays = [0, 0, 1, 2, 3, 5, 8, 13, 21, 34];
    for (const [round, delay] of delays.entries()) {
      const email = `race-${round}@example.com`;
      const target = `race-moved-${round}@example.com`;
      const { me, token } = await w.asked(email);
      expect((await w.on.api.user.changeEmail({ session: me, newEmail: target })).ok).toBe(true);
      const change = w.linkTo(target, "Confirm your new email address");
      const moving = w.on.api.user.confirmEmailChange({ token: change, ip: null, userAgent: null });
      await new Promise((r) => setTimeout(r, delay));
      const deleted = await w.on.api.user.confirmDelete({
        session: me,
        token,
        ip: null,
        userAgent: null,
      });
      const moved = await moving;
      // The move ends the delete link: it went to the old mailbox.
      expect([deleted.ok, moved.ok].filter(Boolean)).toHaveLength(1);
      const loser = deleted.ok ? moved : deleted;
      expect(loser).toMatchObject({ ok: false, code: "invalid_token" });
      expect(await w.userLeft(me.user.id)).toBe(deleted.ok ? 0 : 1);
      won[deleted.ok ? "delete" : "move"]++;
    }
    // The sweep must meet the move-first order, the order of the move's rule (review L1).
    expect(won.move, JSON.stringify(won)).toBeGreaterThan(0);
  }, 60_000);
});

describe("the social fill beside a profile update on MySQL 8.4 (plan 12a fix wave, final review m1)", () => {
  const UPDATE = { name: "Ada Lovelace", image: "https://img.example.com/ada.png" };
  const FILL = { name: "Google Ada", picture: "https://lh3.example.com/ada.png" };

  /** A verified user with a Google identity and no name or image; `inHook` runs in session.beforeCreate. */
  async function fillWorld(inHook: { run: (() => Promise<void>) | null } = { run: null }) {
    const sent: MailMessage[] = [];
    const claims = new Map<string, Record<string, unknown>>();
    const auth = createAuth({
      baseURL: BASE,
      secret: SECRET,
      trustedOrigins: [],
      storage: createMysqlAdapter(db.pool),
      limiter: OPEN,
      mail: {
        send: async (m) => {
          sent.push(m);
        },
      },
      social: {
        google: { clientId: "gid", clientSecret: "gsecret" },
        fetch: async (_url, init) =>
          Response.json({
            id_token: new URLSearchParams(String(init?.body ?? "")).get("code"),
            access_token: "at",
            token_type: "Bearer",
          }),
      },
      jwt: {
        verifyIdToken: async ({ token }) => claims.get(token) ?? {},
        signES256: async () => "unused",
      },
      hooks: {
        session: {
          // Between the flow's read of the user and its hold of the row.
          beforeCreate: async () => {
            const run = inHook.run;
            inHook.run = null;
            await run?.();
          },
        },
      },
    });
    let n = 0;
    /** A Google sign-in of `email`; the provider answers `extra` beside the address. */
    async function google(email: string, extra: Record<string, unknown>) {
      const started = await auth.api.startSocial({ provider: "google", ip: null });
      if (!started.ok) throw new Error(started.code);
      const url = new URL(started.value.location);
      const code = `code-${++n}`;
      claims.set(code, {
        sub: `g-${email}`,
        email,
        email_verified: true,
        nonce: url.searchParams.get("nonce"),
        ...extra,
      });
      const r = await auth.api.completeSocial({
        provider: "google",
        state: url.searchParams.get("state"),
        code,
        error: null,
        bindToken: started.value.bindToken,
        sessionToken: null,
        ip: null,
        userAgent: null,
      });
      if (!r.ok) throw new Error(r.code);
      if (!("token" in r.value)) throw new Error("the callback opened no session");
      const s = await auth.api.getSession(r.value.token);
      if (!s) throw new Error("no session");
      return s;
    }
    const row = async (id: string) =>
      (
        await db.q<{ name: string | null; image: string | null }[]>`
        SELECT name, image FROM ta_user WHERE id = ${id}`
      )[0];
    const empty = (id: string) =>
      db.q`UPDATE ta_user SET name = NULL, image = NULL WHERE id = ${id}`;
    return { auth, google, row, empty };
  }

  it("a profile update that commits between the fill's read and its write keeps its values", async () => {
    const inHook: { run: (() => Promise<void>) | null } = { run: null };
    const w = await fillWorld(inHook);
    // The first sign-in creates the user with no name and no image.
    const me = await w.google("ada@example.com", {});
    expect(await w.row(me.user.id)).toEqual({ name: null, image: null });
    let updated: unknown = null;
    inHook.run = async () => {
      updated = await w.auth.api.user.update({ session: me, ...UPDATE });
    };
    await w.google("ada@example.com", FILL);
    expect(updated).toMatchObject({ ok: true });
    expect(await w.row(me.user.id)).toEqual(UPDATE);
  });

  it("an update of the name alone keeps the name, and the fill still writes the empty image", async () => {
    const inHook: { run: (() => Promise<void>) | null } = { run: null };
    const w = await fillWorld(inHook);
    const me = await w.google("ada@example.com", {});
    inHook.run = async () => {
      const r = await w.auth.api.user.update({ session: me, name: UPDATE.name });
      if (!r.ok) throw new Error(r.code);
    };
    await w.google("ada@example.com", FILL);
    expect(await w.row(me.user.id)).toEqual({ name: UPDATE.name, image: FILL.picture });
  });

  it("a profile update beside a social fill, a delay sweep: the update's values survive", async () => {
    const w = await fillWorld();
    const me = await w.google("ada@example.com", {});
    const delayed = <T>(ms: number, run: () => Promise<T>) =>
      new Promise<T>((done, failed) => {
        setTimeout(() => run().then(done, failed), ms);
      });
    for (let delay = 0; delay < 12; delay++) {
      await w.empty(me.user.id);
      const [, updated] = await Promise.all([
        w.google("ada@example.com", FILL),
        delayed(delay, () => w.auth.api.user.update({ session: me, ...UPDATE })),
      ]);
      expect(updated.ok, `delay ${delay}`).toBe(true);
      expect(await w.row(me.user.id), `delay ${delay}`).toEqual(UPDATE);
    }
  }, 60_000);
});

describe("the operator delete races on MySQL 8.4 (plan 12f2 Task 4)", () => {
  const APP = { kind: "app", name: "support-tool" } as const;
  const REASON = { reason: "Ticket 4521", ip: null, userAgent: null };

  /**
   * The world of plan 12a with organizations and the operator user tools. The
   * app acts. `beforeDelete` runs in the transaction of the account delete,
   * after its read of the member rows and before its member delete.
   */
  function operatorWorld(beforeDelete?: () => Promise<void>) {
    const sent: MailMessage[] = [];
    const auth = createAuth({
      baseURL: BASE,
      secret: SECRET,
      trustedOrigins: [],
      storage: createMysqlAdapter(db.pool),
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
      ...(beforeDelete ? { hooks: { user: { beforeDelete } } } : {}),
    });
    const tokenOf = (m: MailMessage | undefined) => {
      const token = /token=([A-Za-z0-9_%-]+)/.exec(m?.text ?? "")?.[1];
      if (!token) throw new Error("no link");
      return decodeURIComponent(token);
    };
    async function signIn(email: string) {
      await auth.api.requestMagicLink({ email, ip: null });
      const r = await auth.api.verifyMagicLink({
        token: tokenOf([...sent].reverse().find((x) => x.to === email)),
        ip: null,
        userAgent: null,
      });
      if (!r.ok) throw new Error(r.code);
      if (!("token" in r.value)) throw new Error("the link answered a challenge");
      const s = await auth.api.getSession(r.value.token);
      if (!s) throw new Error("no session");
      return { ...s, token: r.value.token };
    }
    return { auth, sent, tokenOf, signIn };
  }

  /** The rows that name the user in the tables of the race. */
  async function rowsOf(userId: string): Promise<number> {
    let n = (await db.q`SELECT id FROM ta_user WHERE id = ${userId}`).length;
    for (const table of ["ta_identity", "ta_session", "ta_member"])
      n += (await db.q`SELECT id FROM ${db.q(table)} WHERE user_id = ${userId}`).length;
    return n;
  }

  it("an operator delete beside a change of address: the delete wins, no deadlock, and no row of the user stays", async () => {
    const w = operatorWorld();
    for (let round = 0; round < 8; round++) {
      const email = `op-del-${round}@example.com`;
      const target = `op-moved-${round}@example.com`;
      const me = await w.signIn(email);
      expect((await w.auth.api.user.changeEmail({ session: me, newEmail: target })).ok).toBe(true);
      const token = w.tokenOf([...w.sent].reverse().find((m) => m.to === target));
      const before = w.sent.length;
      const [deleted, moved] = await Promise.all([
        w.auth.api.operator.users.delete({ actor: APP, userId: me.user.id, ...REASON }),
        w.auth.api.user.confirmEmailChange({ token, ip: null, userAgent: null }),
      ]);
      // The delete holds the user row as the change does: the later one waits, then reads the row again.
      expect(deleted).toMatchObject({ ok: true });
      // A session past the page of the delete ends at the sweep (ruling 1 of plan 12f2, B1).
      // The door refuses it at once, before the sweep: the user row is gone.
      expect(await w.auth.api.getSession(me.token)).toBeNull();
      await w.auth.api.sweepExpired();
      expect(await rowsOf(me.user.id)).toBe(0);
      const notice = w.sent
        .slice(before)
        .filter((m) => m.text.startsWith("Your account was deleted."));
      // The move committed first: the delete read the moved row, and its notice goes to the new address.
      expect(notice.map((m) => m.to)).toEqual([moved.ok ? target : email]);
      if (!moved.ok) expect(["invalid_token", "token_expired"]).toContain(moved.code);
    }
  }, 60_000);

  it("an operator delete beside a removal of the user from a shared organization, a delay sweep: no deadlock, and the organization keeps its owner", async () => {
    const w = operatorWorld();
    const ada = await w.signIn("ada@example.com");
    // The removal reads before its transaction, so the delete starts 0 to 11 ms
    // after it. The two transactions then overlap in some rounds.
    for (let round = 0; round < 12; round++) {
      const pat = await w.signIn(`pat-${round}@example.com`);
      const made = await w.auth.api.createOrganization({
        user: ada.user,
        slug: `acme-${round}`,
        name: "Acme",
      });
      if (!made.ok) throw new Error(made.code);
      const organizationId = made.value.organization.id;
      const added = await w.auth.api.addMember({
        user: ada.user,
        organizationId,
        userId: pat.user.id,
        role: "member",
      });
      if (!added.ok) throw new Error(added.code);
      const [removed, deleted] = await Promise.all([
        w.auth.api.removeMember({ user: ada.user, organizationId, userId: pat.user.id }),
        (async () => {
          await new Promise((r) => setTimeout(r, round));
          return w.auth.api.operator.users.delete({ actor: APP, userId: pat.user.id, ...REASON });
        })(),
      ]);
      // Both hold the user row first: the later one waits, then reads the rows again.
      expect(deleted).toMatchObject({ ok: true, value: { organizations: [] } });
      if (!removed.ok) expect(["not_found", "conflict"]).toContain(removed.code);
      // A session past the page of the delete ends at the sweep (ruling 1 of plan 12f2, B1).
      // The door refuses it at once, before the sweep: the user row is gone.
      expect(await w.auth.api.getSession(pat.token)).toBeNull();
      await w.auth.api.sweepExpired();
      expect(await rowsOf(pat.user.id)).toBe(0);
      const members = await db.q<{ user_id: string }[]>`
        SELECT user_id FROM ta_member WHERE organization_id = ${organizationId}`;
      expect(members.map((m) => m.user_id)).toEqual([ada.user.id]);
    }
  }, 60_000);

  /** A platform operator through `createAdmin` and a sign-in, as the actor of an act. */
  async function platformOperator(w: ReturnType<typeof operatorWorld>, email: string) {
    const made = await w.auth.api.operator.createAdmin({
      actor: APP,
      email,
      reason: "First operator",
      ip: null,
      userAgent: null,
    });
    if (!made.ok) throw new Error(made.code);
    const s = await w.signIn(email);
    return { kind: "user", user: s.user, session: s.session } as const;
  }

  it("a platform operator deletes a user with 3 solo organizations: MySQL has no per-invocation query limit, so no size check (ruling 5 of plan 12f2)", async () => {
    const w = operatorWorld();
    const actor = await platformOperator(w, "op@example.com");
    const ada = await w.signIn("ada@example.com");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const made = await w.auth.api.createOrganization({
        user: ada.user,
        slug: `solo-${i}`,
        name: "Solo",
      });
      if (!made.ok) throw new Error(made.code);
      ids.push(made.value.organization.id);
    }
    // On D1 a user actor fits 1 solo organization; 2 answer delete_too_large.
    const deleted = await w.auth.api.operator.users.delete({
      actor,
      userId: ada.user.id,
      ...REASON,
    });
    expect(deleted).toEqual({
      ok: true,
      value: { organizations: ids, auditId: expect.any(String) },
    });
    await w.auth.api.sweepExpired();
    expect(await rowsOf(ada.user.id)).toBe(0);
  }, 60_000);

  it("a platform operator deletes a user beside a grant of the platform role, a delay sweep: never both, and no platform operator goes (ruling 5 of plan 12f2, L1)", async () => {
    const w = operatorWorld();
    const actor = await platformOperator(w, "op@example.com");
    // The grant reads its target before its transaction, so the delete starts
    // 0 to 11 ms after it. The two transactions then overlap in some rounds.
    for (let round = 0; round < 12; round++) {
      const target = await w.signIn(`target-${round}@example.com`);
      const [granted, deleted] = await Promise.all([
        w.auth.api.operator.platformRole.grant({ actor: APP, userId: target.user.id, ...REASON }),
        (async () => {
          await new Promise((r) => setTimeout(r, round));
          return w.auth.api.operator.users.delete({ actor, userId: target.user.id, ...REASON });
        })(),
      ]);
      // Both hold the user row: the later one waits, then reads the rows again.
      expect([granted.ok, deleted.ok]).not.toEqual([true, true]);
      if (deleted.ok) {
        if (!granted.ok) expect(["not_found", "conflict"]).toContain(granted.code);
        await w.auth.api.sweepExpired();
        expect(await rowsOf(target.user.id)).toBe(0);
      } else {
        expect(deleted).toEqual({ ok: false, code: "operator_required", status: 403 });
        expect(granted.ok).toBe(true);
        expect(await w.auth.api.getSession(target.token)).not.toBeNull();
      }
    }
  }, 60_000);

  for (const write of ["a grant of the platform role", "a role change"] as const)
    it(`a platform operator deletes a member of the platform organization while ${write} adds the role part to its row: the write waits on the user row, so no platform operator goes (ruling 6 of plan 12f2)`, async () => {
      let during: (() => Promise<void>) | null = null;
      const w = operatorWorld(async () => {
        await during?.();
      });
      const actor = await platformOperator(w, "op@example.com");
      const rows = await db.q<
        { id: string }[]
      >`SELECT id FROM ta_organization WHERE slug = 'platform-co'`;
      const organizationId = rows[0]?.id ?? "";
      const target = await w.signIn("member@example.com");
      const added = await w.auth.api.addMember({
        user: actor.user,
        organizationId,
        userId: target.user.id,
        role: "member",
      });
      expect(added.ok).toBe(true);
      let racer: Promise<{ ok: boolean }> | null = null;
      // The delete read the member row with no role part. The write starts
      // now. With no hold of the user row it commits in the pause, and then
      // the delete removes a platform operator.
      during = async () => {
        during = null;
        racer =
          write === "a role change"
            ? w.auth.api.updateMemberRole({
                user: actor.user,
                organizationId,
                userId: target.user.id,
                role: "member,operator",
              })
            : w.auth.api.operator.platformRole.grant({
                actor: APP,
                userId: target.user.id,
                ...REASON,
              });
        await Promise.race([racer, new Promise((r) => setTimeout(r, HOLD_MS))]);
      };
      const deleted = await w.auth.api.operator.users.delete({
        actor,
        userId: target.user.id,
        ...REASON,
      });
      expect(deleted).toMatchObject({ ok: true });
      expect(racer).not.toBeNull();
      // The write waited for the commit of the delete, then matched no row.
      expect(await racer).toMatchObject({ ok: false, code: "conflict" });
      await w.auth.api.sweepExpired();
      expect(await rowsOf(target.user.id)).toBe(0);
    }, 60_000);
});
