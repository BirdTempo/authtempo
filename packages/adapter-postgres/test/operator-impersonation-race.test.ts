import {
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
  type StorageAdapter,
} from "@authtempo/core";
import { base32Decode, totpCode } from "@authtempo/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The impersonation of plan 12f Task 11 beside the acts that end it (ruling
// 42 of plan 12f), on the real Postgres adapter, through core's built output,
// with separate connections. The memory adapter runs one transaction at a
// time, so only Postgres shows these orders. A probe pauses one flow inside
// its transaction at a fixed statement and starts the other flow there. Each
// state comes from the flows: the routes, the magic link, and the operator api.

const API = "https://api.example.com";
const APP = { kind: "app", name: "support-tool" } as const;
const PASSWORD = "correct horse battery";
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };
/** The pause of the probe: long enough for the other flow to take the rows it can (plan 12a Task 11). */
const HOLD_MS = 600;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

/** The statement after which the probe runs: a session delete, or a member read. */
type Trigger = "session delete" | "member read";

/**
 * The engine on Postgres with impersonation on, no `session.afterEnd` hook,
 * and one probe in its transactions. The probe runs once, after the next
 * statement of its trigger, on the same open transaction. It starts the
 * other flow and waits `HOLD_MS`.
 */
function world() {
  const sent: MailMessage[] = [];
  let probe: { trigger: Trigger; run: () => Promise<void> } | null = null;
  const fire = async (trigger: Trigger) => {
    const p = probe;
    if (p && p.trigger === trigger) {
      probe = null;
      await p.run();
    }
  };
  const adapter = createPostgresAdapter(db.sql);
  const wrap = (tx: StorageAdapter): StorageAdapter => ({
    ...tx,
    delete: (async (model, where) => {
      const n = await tx.delete(model, where);
      if (model === "session") await fire("session delete");
      return n;
    }) as typeof tx.delete,
    findOne: (async (model, where) => {
      const row = await tx.findOne(model, where);
      if (model === "member") await fire("member read");
      return row;
    }) as typeof tx.findOne,
  });
  const storage: StorageAdapter = {
    ...adapter,
    transaction: ((fn: (tx: StorageAdapter) => Promise<unknown>) =>
      adapter.transaction((tx) => fn(wrap(tx)))) as typeof adapter.transaction,
  };
  const auth = createAuth({
    baseURL: API,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: OPEN,
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    // A low iteration count: the test is about the order of the locks, not hash work.
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: { users: true, impersonation: {} },
  });
  const post = (path: string, body: unknown, cookie: string) =>
    auth.handle(
      new Request(`${API}/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      }),
    );
  const lastToken = (to: string) => {
    const m = /token=([A-Za-z0-9_%-]+)/.exec(sent.filter((x) => x.to === to).at(-1)?.text ?? "");
    if (!m?.[1]) throw new Error(`no token in the last mail to ${to}`);
    return decodeURIComponent(m[1]);
  };
  /**
   * A sign-in by a magic link: the user on the first one. A user with the
   * second factor on passes the challenge with `backupCode`. Answers the
   * session and its cookie.
   */
  async function signIn(email: string, backupCode?: string) {
    await auth.api.requestMagicLink({ email, ip: null });
    const r = await auth.api.verifyMagicLink({
      token: lastToken(email),
      ip: null,
      userAgent: null,
    });
    if (!r.ok) throw new Error(r.code);
    let token: string;
    if ("token" in r.value) token = r.value.token;
    else {
      const totp = auth.api.totp;
      if (!totp || backupCode === undefined) throw new Error("the link answered a challenge");
      const v = await totp.verify({
        challenge: r.value.twoFactor.challenge,
        backupCode,
        ip: null,
      });
      if (!v.ok) throw new Error(v.code);
      token = v.value.token;
    }
    const s = await auth.api.getSession(token);
    if (!s) throw new Error("no session");
    return { ...s, token, cookie: `__Host-tempo_session=${token}` };
  }
  /**
   * A platform operator: a verified user with a password and the second
   * factor through the routes, then the platform role through `createAdmin`.
   */
  async function operator(email: string) {
    const s = await signIn(email);
    expect((await post("/password/change", { newPassword: PASSWORD }, s.cookie)).status).toBe(200);
    const setup = await post("/totp/setup", { password: PASSWORD }, s.cookie);
    const keys = (await setup.json()) as { secret: string; backupCodes: string[] };
    const key = base32Decode(keys.secret);
    const code = await totpCode(key, new Date());
    expect((await post("/totp/enable", { code }, s.cookie)).status).toBe(200);
    const admin = await auth.api.operator.createAdmin({
      actor: APP,
      email,
      reason: "First operator",
      ip: null,
      userAgent: null,
    });
    if (!admin.ok) throw new Error(admin.code);
    // The operator guard refuses a session from before the grant (ruling 50 of plan 12f),
    // so the operator signs in again after it, with a backup code for the second factor.
    await new Promise((r) => setTimeout(r, 5));
    const after = await signIn(email, keys.backupCodes[0]);
    // The session from before the grant has no power; it goes, so each test counts its own rows.
    await auth.api.signOut(s.token);
    return { ...after, backupCodes: keys.backupCodes.slice(1) };
  }
  /** Arms the probe: after the next statement of `trigger`, `start` runs and the transaction waits `HOLD_MS`. */
  function during(trigger: Trigger, start: () => Promise<unknown>) {
    const started: { flow: Promise<unknown> | null } = { flow: null };
    probe = {
      trigger,
      run: async () => {
        started.flow = start();
        // A rejection is read below, after the answer of the paused flow.
        started.flow.catch(() => {});
        await new Promise((r) => setTimeout(r, HOLD_MS));
      },
    };
    return async () => {
      while (started.flow === null) await new Promise((r) => setTimeout(r, 10));
      return started.flow;
    };
  }
  return { auth, signIn, operator, during };
}

type World = ReturnType<typeof world>;

/** Both answers came, with no throw (no deadlock). Answers them. */
async function settled(first: Promise<unknown>, other: () => Promise<unknown>) {
  const answers = await Promise.allSettled([first, other()]);
  for (const a of answers)
    expect(a.status, String(a.status === "rejected" && a.reason)).toBe("fulfilled");
  return answers.map((a) => (a.status === "fulfilled" ? a.value : null)) as {
    ok: boolean;
    code?: string;
  }[];
}

const loss = (w: World, act: "ban" | "revoke", userId: string) => {
  const input = { actor: APP, userId, reason: "The operator left", ip: null, userAgent: null };
  return act === "ban"
    ? w.auth.api.operator.users.ban(input)
    : w.auth.api.operator.platformRole.revoke(input);
};

const impersonationRows = (operatorId: string) =>
  db.sql`SELECT id FROM ta_session WHERE actor_id = ${operatorId}`;

describe("the impersonation beside the acts that end it on Postgres (ruling 42 of plan 12f)", () => {
  it.each(["ban", "revoke"] as const)(
    "leaves no impersonation session when a %s of the operator runs during the start",
    async (act) => {
      const w = world();
      const op = await w.operator("op@example.com");
      const target = await w.signIn("ada@example.com");
      // The start pauses after its read of the operator's member row, inside
      // its transaction. The act runs there in full, or waits for the start.
      const acting = w.during("member read", () => loss(w, act, op.user.id));
      const [started, acted] = await settled(
        w.auth.api.operator.impersonate({
          operator: op,
          userId: target.user.id,
          reason: "Ticket 1",
          ip: null,
          userAgent: null,
        }),
        acting,
      );
      expect(acted).toMatchObject({ ok: true });
      // The start commits before the act, which then ends it, or it sees the act and refuses.
      if (!started?.ok) expect(started).toMatchObject({ code: "operator_required" });
      expect(await impersonationRows(op.user.id)).toHaveLength(0);
    },
    60_000,
  );

  it("takes the locks of the operator's sessions and the impersonation rows in one read beside endAll", async () => {
    const w = world();
    const op = await w.operator("op@example.com");
    const target = await w.signIn("ada@example.com");
    const res = await w.auth.handle(
      new Request(`${API}/auth/operator/impersonate`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${op.token}` },
        body: JSON.stringify({ userId: target.user.id, reason: "Ticket 2" }),
      }),
    );
    expect(res.status).toBe(200);
    // The operator signs in again and ends the start session from the new
    // one. So every live session of the operator has a higher id than the
    // impersonation row, and endAll, which locks by id, meets it first.
    const second = await w.signIn("op@example.com", op.backupCodes[0]);
    await w.auth.api.signOut(op.token);
    expect(await w.auth.api.getSession(op.token)).toBeNull();
    const rows = await db.sql<{ id: string; actor_id: string | null }[]>`
      SELECT id, actor_id FROM ta_session ORDER BY id`;
    const impersonation = rows.find((r) => r.actor_id === op.user.id)?.id;
    expect(rows.map((r) => r.id)).toEqual([target.session.id, impersonation, second.session.id]);
    // The ban pauses after its first session delete; endAll starts there.
    const ending = w.during("session delete", () =>
      w.auth.api.operator.sessions.endAll({
        actor: APP,
        reason: "Breach",
        ip: null,
        userAgent: null,
      }),
    );
    const answers = await settled(loss(w, "ban", op.user.id), ending);
    for (const a of answers) expect(a).toMatchObject({ ok: true });
    expect(await impersonationRows(op.user.id)).toHaveLength(0);
    expect(await db.sql`SELECT 1 FROM ta_session WHERE user_id = ${op.user.id}`).toHaveLength(0);
  }, 60_000);
});
