import { createAuth, type MailMessage } from "@authtempo/core";
import { SoftAuthenticator } from "@authtempo/core/testing";
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
      const rows = await db.sql<
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

describe("user hook races on Postgres (plan 12a Task 5, review M3)", () => {
  it("parallel magic links of one new address: one user and one user.afterCreate", async () => {
    const sent: MailMessage[] = [];
    const events: string[] = [];
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
      const users = await db.sql`SELECT id FROM ta_user WHERE email = ${email}`;
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

describe("the profile update races on Postgres (plan 12a Task 7)", () => {
  it("parallel updates of one user: each afterUpdate gets the row its write replaced", async () => {
    const sent: MailMessage[] = [];
    const after: { previous: ProfileRow; user: ProfileRow }[] = [];
    let befores = 0;
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
      const [initial] = await db.sql<
        ProfileRow[]
      >`SELECT name, image, updated_at AS "updatedAt" FROM ta_user WHERE id = ${s.user.id}`;
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
      const [final] = await db.sql<
        ProfileRow[]
      >`SELECT name, image, updated_at AS "updatedAt" FROM ta_user WHERE id = ${s.user.id}`;
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

describe("the change of address races on Postgres (plan 12a Task 8)", () => {
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
      const rows = await db.sql<{ id: string }[]>`SELECT id FROM ta_user WHERE email = ${target}`;
      expect(rows).toHaveLength(1);
      const ids = await db.sql<
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
      expect(answers.map((x) => (x.ok ? "ok" : x.code)).sort()).toEqual(["invalid_token", "ok"]);
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
      storage: createPostgresAdapter(db.sql),
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
      const [initial] = await db.sql<
        MoveRow[]
      >`SELECT email, name, updated_at AS "updatedAt" FROM ta_user WHERE id = ${s.user.id}`;
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
      const [final] = await db.sql<
        MoveRow[]
      >`SELECT email, name, updated_at AS "updatedAt" FROM ta_user WHERE id = ${s.user.id}`;
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
  email: string;
  name: string | null;
  updatedAt: Date;
}

describe("the last-credential guard on Postgres (plan 12a Task 9)", () => {
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
      storage: createPostgresAdapter(db.sql),
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
      const [identity] = await db.sql<{ id: string }[]>`
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
      const identities =
        await db.sql`SELECT provider FROM ta_identity WHERE user_id = ${me.user.id}`;
      expect(identities.map((r) => r.provider)).toEqual(["email"]);
      const passkeys = await db.sql`SELECT id FROM ta_passkey WHERE user_id = ${me.user.id}`;
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
      const [identity] = await db.sql<{ id: string }[]>`
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
      const left = await db.sql`SELECT id FROM ta_identity WHERE user_id = ${me.user.id}`;
      expect(left).toHaveLength(1);
      expect(w.unlinked).toEqual([]);
    }
  }, 60_000);
});
