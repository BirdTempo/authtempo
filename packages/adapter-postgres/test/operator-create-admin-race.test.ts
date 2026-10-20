import { createAuth, type MailMessage, type StorageAdapter } from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// createAdmin of plan 12f Task 8 beside the account delete, on the real
// Postgres adapter, through core's built output, with separate connections.
// The memory adapter runs one transaction at a time, so only Postgres shows
// the lock order. A pass proves the orders that the rounds met.

const BASE = "https://api.example.com";
const SECRET = "0123456789abcdef0123456789abcdef";
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };
const APP = { kind: "app", name: "setup-script" } as const;
const ROUNDS = 3;
/** The pause of the probe: long enough for the delete to take the user row (plan 12a Task 11). */
const HOLD_MS = 400;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

/**
 * The engine on Postgres, with one probe inside its transactions. The probe
 * runs once, after the next update of a member row, on the same open
 * transaction.
 */
function world() {
  const sent: MailMessage[] = [];
  const probe: { afterMemberUpdate: (() => Promise<void>) | null } = { afterMemberUpdate: null };
  const adapter = createPostgresAdapter(db.sql);
  const wrap = (tx: StorageAdapter): StorageAdapter => ({
    ...tx,
    update: (async (model, where, data) => {
      const n = await tx.update(model, where, data);
      const p = probe.afterMemberUpdate;
      if (model === "member" && p) {
        probe.afterMemberUpdate = null;
        await p();
      }
      return n;
    }) as typeof tx.update,
  });
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
  });
  async function signIn(email: string) {
    await auth.api.requestMagicLink({ email, ip: null });
    const m = [...sent].reverse().find((x) => x.to === email && /token=/.test(x.text));
    const token = /token=([A-Za-z0-9_%-]+)/.exec(m?.text ?? "")?.[1];
    if (!token) throw new Error("no link");
    const r = await auth.api.verifyMagicLink({
      token: decodeURIComponent(token),
      ip: null,
      userAgent: null,
    });
    if (!r.ok) throw new Error(r.code);
    if (!("token" in r.value)) throw new Error("the link answered a challenge");
    const s = await auth.api.getSession(r.value.token);
    if (!s) throw new Error("no session");
    return { ...s, token: r.value.token };
  }
  const createAdmin = (email: string) =>
    auth.api.operator.createAdmin({
      actor: APP,
      email,
      reason: "First operator",
      ip: null,
      userAgent: null,
    });
  return { auth, probe, signIn, createAdmin };
}

/** The rows that name `userId` in the user, member, and session tables. */
async function rowsOf(userId: string) {
  const count = async (table: string, column: string) =>
    (await db.sql`SELECT 1 FROM ${db.sql(table)} WHERE ${db.sql(column)} = ${userId}`).length;
  return {
    user: await count("ta_user", "id"),
    member: await count("ta_member", "user_id"),
    session: await count("ta_session", "user_id"),
  };
}

describe("createAdmin beside the account delete on Postgres (plan 12f Task 8)", () => {
  it("a delete that starts after the member write of createAdmin: no deadlock, and no row of the deleted user stays", async () => {
    const w = world();
    // createAdmin makes the platform organization, and root proves the mailbox.
    const first = await w.createAdmin("root@example.com");
    if (!first.ok) throw new Error(first.code);
    const root = await w.signIn("root@example.com");
    const org = await db.sql<{ id: string }[]>`
      SELECT id FROM ta_organization WHERE slug = 'platform-co'`;
    const organizationId = org[0]?.id ?? "";
    for (let round = 0; round < ROUNDS; round++) {
      const me = await w.signIn(`m4-${round}@example.com`);
      const added = await w.auth.api.addMember({
        user: root.user,
        organizationId,
        userId: me.user.id,
        role: "member",
      });
      if (!added.ok) throw new Error(added.code);
      // The delete starts inside createAdmin's transaction, after its member write.
      let deleting: Promise<unknown> | null = null;
      w.probe.afterMemberUpdate = async () => {
        deleting = w.auth.api.user.delete({ session: me, ip: null, userAgent: null });
        // A rejection is read below, after the createAdmin answer.
        deleting.catch(() => {});
        await new Promise((r) => setTimeout(r, HOLD_MS));
      };
      const answers = await Promise.allSettled([
        w.createAdmin(me.user.email),
        (async () => {
          while (deleting === null) await new Promise((r) => setTimeout(r, 10));
          return deleting;
        })(),
      ]);
      // No deadlock error, nor any other throw.
      for (const a of answers)
        expect(a.status, String(a.status === "rejected" && a.reason)).toBe("fulfilled");
      const [made, deleted] = answers.map((a) =>
        a.status === "fulfilled" ? (a.value as { ok: boolean; code?: string }) : null,
      );
      for (const r of [made, deleted]) if (r && !r.ok) expect(r.code).toBe("conflict");
      expect(deleted?.ok).toBe(true);
      expect(await rowsOf(me.user.id)).toEqual({ user: 0, member: 0, session: 0 });
      expect(await db.sql`SELECT role FROM ta_member WHERE user_id = ${root.user.id}`).toEqual([
        { role: "owner,operator" },
      ]);
    }
  }, 60_000);
});
