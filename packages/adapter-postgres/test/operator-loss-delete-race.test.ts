import {
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
  type StorageAdapter,
  type UserRow,
} from "@authtempo/core";
import { base32Decode, totpCode } from "@authtempo/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The account delete of one owner beside a role loss of another owner, on
// the real Postgres adapter (ruling 65 of plan 12f, L1). Both are platform
// operators with an impersonation session on one shared target. Each flow
// takes the user row, then the session locks of the user and the targets,
// then the owner lock (user-hold.ts). With the owner lock before the
// session locks, the two flows wait on each other, and Postgres ends one
// with a deadlock. Each state comes from the flows: the routes, the magic
// link, the organization api, and the operator api.

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

/** The statement after which the probe runs: the lock read of the sessions. */
type Trigger = "session lock";

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
    lockInOrder: (async (model, where) => {
      await tx.lockInOrder?.(model, where);
      if (model === "session") await fire("session lock");
    }) as typeof tx.lockInOrder,
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
   * `before` runs after the second factor and before `createAdmin`.
   */
  async function operator(email: string, before?: (user: UserRow) => Promise<void>) {
    const s = await signIn(email);
    expect((await post("/password/change", { newPassword: PASSWORD }, s.cookie)).status).toBe(200);
    const setup = await post("/totp/setup", { password: PASSWORD }, s.cookie);
    const keys = (await setup.json()) as { secret: string; backupCodes: string[] };
    const key = base32Decode(keys.secret);
    const code = await totpCode(key, new Date());
    expect((await post("/totp/enable", { code }, s.cookie)).status).toBe(200);
    await before?.(s.user);
    const admin = await auth.api.operator.createAdmin({
      actor: APP,
      email,
      reason: "First operator",
      ip: null,
      userAgent: null,
    });
    if (!admin.ok) throw new Error(admin.code);
    // The operator guard refuses a session from before the grant (ruling 50 of plan 12f).
    // So the operator signs in again after it, with a backup code for the second factor.
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

/** An impersonation session of `op` on `userId`. */
async function impersonate(w: World, op: Awaited<ReturnType<World["operator"]>>, userId: string) {
  const r = await w.auth.api.operator.impersonate({
    operator: op,
    userId,
    reason: "Ticket 1",
    ip: null,
    userAgent: null,
  });
  if (!r.ok) throw new Error(r.code);
}

describe("the account delete beside a role loss on Postgres (ruling 65 of plan 12f)", () => {
  it("ends both, with no deadlock, when two owners with a shared target go at once", async () => {
    const w = world();
    // The first operator makes the platform organization, as its owner.
    const ada = await w.operator("ada@example.com");
    const platform =
      (
        await db.sql<{ id: string }[]>`
      SELECT id FROM ta_organization WHERE slug = 'platform-co'`
      )[0]?.id ?? "";
    const owner = async (user: UserRow) => {
      const added = await w.auth.api.addMember({
        user: ada.user,
        organizationId: platform,
        userId: user.id,
        role: "owner",
      });
      if (!added.ok) throw new Error(added.code);
    };
    // The second operator is an owner first, so createAdmin adds the role part.
    const bob = await w.operator("bob@example.com", owner);
    // A third owner, so that the organization keeps an owner after both acts.
    const cy = await w.signIn("cy@example.com");
    await owner(cy.user);
    const roles = await db.sql<{ role: string }[]>`
      SELECT role FROM ta_member WHERE organization_id = ${platform} ORDER BY id`;
    expect(roles.map((r) => r.role)).toEqual(["owner,operator", "owner,operator", "owner"]);
    const target = await w.signIn("tia@example.com");
    await impersonate(w, ada, target.user.id);
    await impersonate(w, bob, target.user.id);
    // Bob's leave pauses after its lock read of the sessions of Bob and the
    // target. Ada's delete runs there, as far as the locks let it.
    const deleting = w.during("session lock", () =>
      w.auth.api.user.delete({ session: ada, ip: null, userAgent: null }),
    );
    const [left, deleted] = await settled(
      w.auth.api.removeMember({ user: bob.user, organizationId: platform, userId: bob.user.id }),
      deleting,
    );
    expect(left).toMatchObject({ ok: true });
    expect(deleted).toMatchObject({ ok: true });
    expect(await db.sql`SELECT 1 FROM ta_user WHERE id = ${ada.user.id}`).toHaveLength(0);
    // A page of the impersonation sessions ends in each act, and the sweep ends the rest.
    await w.auth.api.sweepExpired();
    expect(await db.sql`SELECT 1 FROM ta_session WHERE actor_id IS NOT NULL`).toHaveLength(0);
    expect(await db.sql`SELECT 1 FROM ta_verification WHERE purpose = 'session-end'`).toHaveLength(
      0,
    );
    const kept = await db.sql<{ user_id: string; role: string }[]>`
      SELECT user_id, role FROM ta_member WHERE organization_id = ${platform}`;
    expect(kept).toEqual([{ user_id: cy.user.id, role: "owner" }]);
  }, 60_000);
});
