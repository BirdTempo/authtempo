import { createAuth, type MailMessage, type StorageAdapter } from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// A plain member removal, a leave, and an organization delete beside a team
// write, on the real Postgres adapter (ruling 49 of plan 12k). A team write
// takes the locks of the sessions it writes, and then the team row. A
// removal deleted the member and team member rows and then updated the
// sessions; an organization delete deleted the team rows first. So each pair
// waited on each other, and Postgres ended one with a deadlock. Now the
// removal locks the person's sessions after the user row, and the
// organization delete locks the sessions that act in it before its row, in
// the order of user-hold.ts. Each state comes from the flows: the magic
// link and the organization api.

const API = "https://api.example.com";
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

/**
 * The engine on Postgres with teams on, and one probe in its transactions.
 * The probe runs once, after the next lock read of the sessions, on the same
 * open transaction. It starts the other flow and waits `HOLD_MS`.
 */
function world() {
  const sent: MailMessage[] = [];
  let probe: (() => Promise<void>) | null = null;
  const adapter = createPostgresAdapter(db.sql);
  const wrap = (tx: StorageAdapter): StorageAdapter => ({
    ...tx,
    lockInOrder: (async (model, where) => {
      await tx.lockInOrder?.(model, where);
      const p = probe;
      if (model === "session" && p) {
        probe = null;
        await p();
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
  /** Arms the probe: after the next lock read of the sessions, `start` runs and the transaction waits `HOLD_MS`. */
  function during(start: () => Promise<unknown>) {
    const started: { flow: Promise<unknown> | null } = { flow: null };
    probe = async () => {
      started.flow = start();
      // A rejection is read below, after the answer of the paused flow.
      started.flow.catch(() => {});
      await new Promise((r) => setTimeout(r, HOLD_MS));
    };
    return async () => {
      while (started.flow === null) await new Promise((r) => setTimeout(r, 10));
      return started.flow;
    };
  }
  return { auth, signIn, during };
}

type World = ReturnType<typeof world>;

function must<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

/** Both answers came, with no throw (no deadlock). Answers them. */
async function settled(first: Promise<unknown>, other: () => Promise<unknown>) {
  const answers = await Promise.allSettled([first, other()]);
  for (const a of answers)
    expect(a.status, String(a.status === "rejected" && a.reason)).toBe("fulfilled");
  return answers.map((a) => (a.status === "fulfilled" ? a.value : null));
}

/** Ada owns Acme. Pat is a member, in the team Core, and Pat's session acts in Core. */
async function acme(w: World) {
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
  const inAcme = await w.auth.api.getSession(pat.token);
  if (!inAcme) throw new Error("no session");
  must(await w.auth.api.setActiveTeam({ session: inAcme, teamId }));
  const patNow = await w.auth.api.getSession(pat.token);
  if (!patNow) throw new Error("no session");
  expect(patNow.session.activeTeamId).toBe(teamId);
  return { ada, pat: patNow, organizationId, teamId };
}

type Removal = "remove" | "leave" | "remove with revokeTokens" | "organization delete";
type TeamWrite = "removeTeamMember" | "deleteTeam" | "setActiveTeam";

/** The 9 pairs of the probe of rereview2-12k-rebase. */
const PAIRS: [Removal, TeamWrite][] = [
  ["remove", "removeTeamMember"],
  ["remove", "deleteTeam"],
  ["leave", "removeTeamMember"],
  ["leave", "deleteTeam"],
  ["remove with revokeTokens", "removeTeamMember"],
  ["remove with revokeTokens", "deleteTeam"],
  ["organization delete", "removeTeamMember"],
  ["organization delete", "deleteTeam"],
  ["organization delete", "setActiveTeam"],
];

describe("a member removal or an organization delete beside a team write on Postgres (ruling 49 of plan 12k)", () => {
  for (const [removal, write] of PAIRS)
    it(`ends the ${removal} and the ${write} with no deadlock`, async () => {
      const w = world();
      const { ada, pat, organizationId, teamId } = await acme(w);
      // The team write pauses after its lock read of the sessions. The removal runs there,
      // as far as the locks let it.
      const removing = w.during(() =>
        removal === "organization delete"
          ? w.auth.api.deleteOrganization({ user: ada.user, organizationId })
          : removal === "leave"
            ? w.auth.api.removeMember({ user: pat.user, organizationId, userId: pat.user.id })
            : w.auth.api.removeMember({
                user: ada.user,
                organizationId,
                userId: pat.user.id,
                revokeTokens: removal === "remove with revokeTokens",
              }),
      );
      const writing =
        write === "removeTeamMember"
          ? w.auth.api.removeTeamMember({ user: ada.user, teamId, userId: pat.user.id })
          : write === "deleteTeam"
            ? w.auth.api.deleteTeam({ user: ada.user, teamId })
            : w.auth.api.setActiveTeam({ session: pat, teamId });
      const [wrote, removed] = await settled(writing, removing);
      // The team write holds the sessions first, so it commits first, and the removal after it.
      expect(wrote).toMatchObject({ ok: true });
      expect(removed).toMatchObject({ ok: true });
      expect(
        await db.sql`SELECT 1 FROM ta_member WHERE organization_id = ${organizationId} AND user_id = ${pat.user.id}`,
      ).toHaveLength(0);
      expect(await db.sql`SELECT 1 FROM ta_team_member`).toHaveLength(0);
      const sessions = await db.sql<{ org: string | null; team: string | null }[]>`
        SELECT active_organization_id AS org, active_team_id AS team FROM ta_session
        WHERE user_id = ${pat.user.id}`;
      expect(sessions).toEqual([{ org: null, team: null }]);
    }, 60_000);
});
