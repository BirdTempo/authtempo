import { env } from "cloudflare:test";
import {
  type AuthConfig,
  createAuth,
  type MailMessage,
  type StorageAdapter,
} from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

// The operator delete beside a change of address on D1 (plan 12f2 Task 4).
// D1 transactions are not isolated (README, "Transactions"). So each test
// runs one flow to completion inside the transaction of the other, after
// the first write of the user row. That is the interleave a real D1
// database allows between two requests. The Postgres and MySQL ports of
// the same race are in their account-races tests.

const BASE = "https://api.example.com";
const APP = { kind: "app", name: "support-tool" } as const;
const REASON = { reason: "Ticket 4521", ip: null, userAgent: null };

/**
 * The engine on D1 whose transactions run `race.interleave` after their
 * first user update, and a second engine with its own adapter for the
 * request that runs inside. Each request of a Worker has its own adapter,
 * so the meter of one act never counts the statements of the other.
 */
function world() {
  const base = createD1Adapter(env.DB);
  const sent: MailMessage[] = [];
  const race: { interleave: (() => Promise<void>) | null } = { interleave: null };
  const wrapTx = (tx: StorageAdapter): StorageAdapter => ({
    ...tx,
    async update(model, where, data) {
      const n = await tx.update(model, where, data);
      if (model === "user" && race.interleave) {
        const run = race.interleave;
        race.interleave = null;
        await run();
      }
      return n;
    },
    transaction: (fn) => tx.transaction((inner) => fn(wrapTx(inner))),
  });
  const storage: StorageAdapter = {
    ...base,
    transaction: (fn) => base.transaction((tx) => fn(wrapTx(tx))),
  };
  const config = (storage: StorageAdapter): AuthConfig => ({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: { allow: async () => true },
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
  const auth = createAuth(config(storage));
  const other = createAuth(config(createD1Adapter(env.DB)));
  const tokenOf = (to: string) => {
    const text = [...sent].reverse().find((m) => m.to === to)?.text ?? "";
    const token = /token=([A-Za-z0-9_%-]+)/.exec(text)?.[1];
    if (!token) throw new Error("no link");
    return decodeURIComponent(token);
  };
  /** A user who signed in by a magic link and asked to move to `target`: the session and the link. */
  async function moving(email: string, target: string) {
    await auth.api.requestMagicLink({ email, ip: null });
    const r = await auth.api.verifyMagicLink({ token: tokenOf(email), ip: null, userAgent: null });
    if (!r.ok || !("token" in r.value)) throw new Error("no session");
    const me = await auth.api.getSession(r.value.token);
    if (!me) throw new Error("no session");
    const asked = await auth.api.user.changeEmail({ session: me, newEmail: target });
    if (!asked.ok) throw new Error(asked.code);
    return { me, token: tokenOf(target) };
  }
  return { auth, other, race, moving };
}

/** The rows that name the user in the user, identity, session, and member tables. */
async function rowsOf(userId: string): Promise<number> {
  let n = Number(
    await env.DB.prepare("SELECT count(*) AS n FROM ta_user WHERE id = ?").bind(userId).first("n"),
  );
  for (const table of ["ta_identity", "ta_session", "ta_member"])
    n += Number(
      await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`)
        .bind(userId)
        .first("n"),
    );
  return n;
}

describe("the operator delete beside a change of address on D1 (plan 12f2 Task 4)", () => {
  beforeEach(async () => {
    await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it("a confirm inside the delete's transaction, after its lock: the delete wins, and no row of the user stays", async () => {
    const w = world();
    const { me, token } = await w.moving("ada@example.com", "ada.new@example.com");
    let moved: Awaited<ReturnType<typeof w.auth.api.user.confirmEmailChange>> | null = null;
    w.race.interleave = async () => {
      moved = await w.other.api.user.confirmEmailChange({ token, ip: null, userAgent: null });
    };
    const deleted = await w.auth.api.operator.users.delete({
      actor: APP,
      userId: me.user.id,
      ...REASON,
    });
    expect(w.race.interleave).toBeNull();
    expect(moved).not.toBeNull();
    expect(deleted).toMatchObject({ ok: true });
    expect(await rowsOf(me.user.id)).toBe(0);
  });

  it("a delete inside the confirm's transaction, after its user write: no row of the user stays", async () => {
    const w = world();
    const { me, token } = await w.moving("bob@example.com", "bob.new@example.com");
    let deleted: Awaited<ReturnType<typeof w.auth.api.operator.users.delete>> | null = null;
    w.race.interleave = async () => {
      deleted = await w.other.api.operator.users.delete({
        actor: APP,
        userId: me.user.id,
        ...REASON,
      });
    };
    const moved = await w.auth.api.user.confirmEmailChange({ token, ip: null, userAgent: null });
    expect(w.race.interleave).toBeNull();
    expect(deleted).toMatchObject({ ok: true });
    // The confirm reads the user again after its write, or its undo takes its rows.
    if (!moved.ok) expect(["invalid_token", "token_expired", "conflict"]).toContain(moved.code);
    expect(await rowsOf(me.user.id)).toBe(0);
  });
});
