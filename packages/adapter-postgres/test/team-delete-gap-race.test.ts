import { createAuth, type MailMessage, type StorageAdapter } from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The gap of the team delete, on the real Postgres adapter (ruling 49 of
// plan 12k, item 4). The delete locks the sessions that act in the team,
// and then takes the team row. A set of the active team can commit between
// the two, so a session acts in the team with no lock of the delete. A
// member removal then locks that session and waits on the team member row
// that the delete holds, while the delete waits on the session. Now the
// delete reads the sessions of the team again after its team lock. When a
// new one is there, the round writes nothing, and the next round locks it.
// Each state comes from the flows: the magic link and the organization api.

const API = "https://api.example.com";
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };
/** The pause of the team delete: the set ends, and the removal takes its session locks. */
const DELETE_HOLD_MS = 600;
/** The pause of the removal after its session locks: the team delete runs on to its session write. */
const REMOVAL_HOLD_MS = 1500;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

/**
 * The engine on Postgres with teams on. `probes` runs in order, one for each
 * lock read of the sessions in a transaction, after the read; a null entry
 * passes that read.
 */
function world() {
  const sent: MailMessage[] = [];
  const probes: ((() => Promise<void>) | null)[] = [];
  const adapter = createPostgresAdapter(db.sql);
  const wrap = (tx: StorageAdapter): StorageAdapter => ({
    ...tx,
    lockInOrder: (async (model, where) => {
      await tx.lockInOrder?.(model, where);
      if (model === "session") await probes.shift()?.();
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
  return { auth, signIn, probes };
}

function must<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("the team delete beside a set and a member removal on Postgres (ruling 49 of plan 12k)", () => {
  it("locks a session that a set moved into the team after the lock read, with no deadlock", async () => {
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
    must(await w.auth.api.setActiveOrganization({ session: pat, organizationId }));
    // Pat's session acts in Acme, in no team, so the lock read of the delete finds no session.
    const inAcme = await w.auth.api.getSession(pat.token);
    if (!inAcme) throw new Error("no session");

    let removal: Promise<unknown> | null = null;
    // 1: the delete, after its lock read. The set commits there, and the removal starts.
    w.probes.push(async () => {
      expect(await w.auth.api.setActiveTeam({ session: inAcme, teamId })).toMatchObject({
        ok: true,
      });
      removal = w.auth.api.removeMember({
        user: ada.user,
        organizationId,
        userId: pat.user.id,
      });
      removal.catch(() => {});
      await pause(DELETE_HOLD_MS);
    });
    // 2: the set, after its own session lock: no pause.
    w.probes.push(null);
    // 3: the removal, after its lock of Pat's sessions. The delete runs on meanwhile.
    w.probes.push(() => pause(REMOVAL_HOLD_MS));

    const deleting = w.auth.api.deleteTeam({ user: ada.user, teamId });
    const answers = await Promise.allSettled([
      deleting,
      (async () => {
        while (removal === null) await pause(10);
        return removal;
      })(),
    ]);
    for (const a of answers)
      expect(a.status, String(a.status === "rejected" && a.reason)).toBe("fulfilled");
    const [deleted, removed] = answers.map((a) => (a.status === "fulfilled" ? a.value : null));
    expect(deleted).toMatchObject({ ok: true });
    expect(removed).toMatchObject({ ok: true });
    expect(await db.sql`SELECT 1 FROM ta_team`).toHaveLength(0);
    expect(await db.sql`SELECT 1 FROM ta_team_member`).toHaveLength(0);
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
    const teamId = must(
      await w.auth.api.createTeam({ user: ada.user, organizationId, name: "Core" }),
    ).id;
    must(await w.auth.api.addTeamMember({ user: ada.user, teamId, userId: pat.user.id }));
    // Five sessions of Pat act in Acme, in no team.
    const sessions = [];
    for (let i = 0; i < 5; i++) {
      const s = await w.signIn("pat@example.com");
      must(await w.auth.api.setActiveOrganization({ session: s, organizationId }));
      const inAcme = await w.auth.api.getSession(s.token);
      if (!inAcme) throw new Error("no session");
      sessions.push(inAcme);
    }
    // Each round of the delete: after its lock read, a set moves one more session into the team.
    for (const s of sessions) {
      w.probes.push(async () => {
        expect(await w.auth.api.setActiveTeam({ session: s, teamId })).toMatchObject({ ok: true });
      });
      // The set's own session lock: no pause.
      w.probes.push(null);
    }

    expect(await w.auth.api.deleteTeam({ user: ada.user, teamId })).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(w.probes).toEqual([]);
    expect(await db.sql`SELECT 1 FROM ta_team`).toHaveLength(1);
    expect(await db.sql`SELECT 1 FROM ta_team_member`).toHaveLength(1);
    expect(await db.sql`SELECT 1 FROM ta_session WHERE active_team_id = ${teamId}`).toHaveLength(5);
  }, 60_000);
});
