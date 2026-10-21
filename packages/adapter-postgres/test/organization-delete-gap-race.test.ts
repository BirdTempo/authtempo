import { createAuth, type MailMessage, type StorageAdapter } from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The gap of the organization delete, on the real Postgres adapter (ruling
// 50 of plan 12k). The delete locks the sessions that act in the
// organization, and then deletes its rows. A set of the active organization
// could commit between the two, so a session acted in the organization with
// no lock of the delete. A set of the active team on that session then held
// the session and waited on the team row that the delete removed, while the
// delete waited on the session. Now the set of the active organization takes
// the organization lock after its session lock, and the delete reads the
// sessions of the organization again after the organization lock. When a new
// one is there, the round writes nothing, and the next round locks it. Each
// state comes from the flows: the magic link and the organization api.

const API = "https://api.example.com";
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };
/** The pause of the delete: the set of the organization ends, and the set of the team takes its session lock. */
const DELETE_HOLD_MS = 600;
/** The pause of the set of the team after its session lock: the delete runs on to its session write. */
const SET_HOLD_MS = 1500;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The engine on Postgres with teams on. `probe.next` runs once, after the
 * next lock read of the sessions in a transaction, on that transaction.
 * `hooks.before` counts the calls of `beforeDelete`.
 */
function world() {
  const sent: MailMessage[] = [];
  const hooks = { before: 0 };
  const probe: { next: (() => Promise<void>) | null } = { next: null };
  const adapter = createPostgresAdapter(db.sql);
  const wrap = (tx: StorageAdapter): StorageAdapter => ({
    ...tx,
    lockInOrder: (async (model, where) => {
      await tx.lockInOrder?.(model, where);
      const run = probe.next;
      if (model === "session" && run) {
        probe.next = null;
        await run();
      }
    }) as NonNullable<typeof tx.lockInOrder>,
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
    organizations: { teams: {} },
    hooks: {
      organization: {
        beforeDelete: async () => {
          hooks.before++;
        },
      },
    },
  });
  /** A sign-in by a magic link: the user on the first one. Answers the session and its token. */
  async function signIn(email: string) {
    await auth.api.requestMagicLink({ email, ip: null });
    const text = sent.filter((x) => x.to === email).at(-1)?.text ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
    if (!r.ok || !("token" in r.value)) throw new Error("no session");
    const s = await auth.api.getSession(r.value.token);
    if (!s) throw new Error("no session");
    return { ...s, token: r.value.token };
  }
  return { auth, signIn, probe, hooks };
}

function must<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

describe("the organization delete beside a set of the active organization and team on Postgres (ruling 50 of plan 12k)", () => {
  it("locks a session that a set moved into the organization after the lock read, with no deadlock", async () => {
    const w = world();
    const ada = await w.signIn("ada@example.com");
    const organizationId = must(
      await w.auth.api.createOrganization({ user: ada.user, slug: "acme", name: "Acme" }),
    ).organization.id;
    const pat = await w.signIn("pat@example.com");
    must(
      await w.auth.api.addMember({
        user: ada.user,
        organizationId,
        userId: pat.user.id,
        role: "member",
      }),
    );
    const teamId = must(
      await w.auth.api.createTeam({ user: ada.user, organizationId, name: "Core" }),
    ).id;
    must(await w.auth.api.addTeamMember({ user: ada.user, teamId, userId: pat.user.id }));
    // Pat's session acts in no organization, so the lock read of the delete finds no session.
    let setting: Promise<unknown> | null = null;
    w.probe.next = async () => {
      // The set of the organization commits here. Its own locks, if any, take no pause.
      expect(
        await w.auth.api.setActiveOrganization({ session: pat, organizationId }),
      ).toMatchObject({ ok: true });
      const inAcme = await w.auth.api.getSession(pat.token);
      if (!inAcme) throw new Error("no session");
      // The set of the team pauses after its session lock, and the delete runs on.
      w.probe.next = () => pause(SET_HOLD_MS);
      setting = w.auth.api.setActiveTeam({ session: inAcme, teamId });
      setting.catch(() => {});
      await pause(DELETE_HOLD_MS);
    };
    const answers = await Promise.allSettled([
      w.auth.api.deleteOrganization({ user: ada.user, organizationId }),
      (async () => {
        while (setting === null) await pause(10);
        return setting;
      })(),
    ]);
    for (const a of answers)
      expect(a.status, String(a.status === "rejected" && a.reason)).toBe("fulfilled");
    const [deleted, set] = answers.map((a) => (a.status === "fulfilled" ? a.value : null));
    expect(deleted).toMatchObject({ ok: true });
    // The set of the team holds the session first, so it commits first, and the delete clears it.
    expect(set).toMatchObject({ ok: true });
    expect(await db.sql`SELECT 1 FROM ta_organization`).toHaveLength(0);
    expect(await db.sql`SELECT 1 FROM ta_team`).toHaveLength(0);
    const sessions = await db.sql<{ org: string | null; team: string | null }[]>`
      SELECT active_organization_id AS org, active_team_id AS team FROM ta_session
      WHERE user_id = ${pat.user.id}`;
    expect(sessions).toEqual([{ org: null, team: null }]);
  }, 60_000);
  it("answers conflict after 5 rounds that each lose to a set, and writes nothing", async () => {
    const w = world();
    const ada = await w.signIn("ada@example.com");
    const organizationId = must(
      await w.auth.api.createOrganization({ user: ada.user, slug: "acme", name: "Acme" }),
    ).organization.id;
    const pat = await w.signIn("pat@example.com");
    must(
      await w.auth.api.addMember({
        user: ada.user,
        organizationId,
        userId: pat.user.id,
        role: "member",
      }),
    );
    // Five sessions of Pat act in no organization.
    const sessions = [];
    for (let i = 0; i < 5; i++) sessions.push(await w.signIn("pat@example.com"));
    // Each round of the delete: after its lock read, a set moves one more session into Acme.
    const rest = [...sessions];
    const arm = () => {
      const s = rest.shift();
      if (!s) return;
      w.probe.next = async () => {
        expect(
          await w.auth.api.setActiveOrganization({ session: s, organizationId }),
        ).toMatchObject({ ok: true });
        arm();
      };
    };
    arm();

    expect(await w.auth.api.deleteOrganization({ user: ada.user, organizationId })).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(rest).toEqual([]);
    // A lost round runs no before hook.
    expect(w.hooks.before).toBe(0);
    expect(await db.sql`SELECT 1 FROM ta_organization`).toHaveLength(1);
    expect(await db.sql`SELECT 1 FROM ta_member`).toHaveLength(2);
    expect(
      await db.sql`SELECT 1 FROM ta_session WHERE active_organization_id = ${organizationId}`,
    ).toHaveLength(5);
  }, 60_000);
  it("runs the before hook once, in the round that commits, after 2 rounds that lose", async () => {
    const w = world();
    const ada = await w.signIn("ada@example.com");
    const organizationId = must(
      await w.auth.api.createOrganization({ user: ada.user, slug: "acme", name: "Acme" }),
    ).organization.id;
    // Two more sessions of Ada act in no organization.
    const rest = [await w.signIn("ada@example.com"), await w.signIn("ada@example.com")];
    // Rounds 1 and 2: after the lock read, a set moves one more session into Acme.
    const arm = () => {
      const s = rest.shift();
      if (!s) return;
      w.probe.next = async () => {
        expect(
          await w.auth.api.setActiveOrganization({ session: s, organizationId }),
        ).toMatchObject({ ok: true });
        arm();
      };
    };
    arm();

    // Round 3 locks both sessions and commits.
    expect(await w.auth.api.deleteOrganization({ user: ada.user, organizationId })).toMatchObject({
      ok: true,
    });
    expect(rest).toEqual([]);
    expect(w.hooks.before).toBe(1);
    expect(await db.sql`SELECT 1 FROM ta_organization`).toHaveLength(0);
    expect(
      await db.sql`SELECT 1 FROM ta_session WHERE active_organization_id = ${organizationId}`,
    ).toHaveLength(0);
  }, 60_000);
});
