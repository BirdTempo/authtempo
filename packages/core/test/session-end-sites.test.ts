import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { deleteAccount } from "../src/engine/account-delete.js";
import { endSession } from "../src/engine/oauth-logout.js";
import { startImpersonation, stopImpersonation } from "../src/engine/operator/impersonation.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { removeMember, updateMemberRole } from "../src/engine/organizations.js";
import { revokeOtherSessions } from "../src/engine/session-list.js";
import { resolveSession } from "../src/engine/sessions.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { HOOK_EVENTS } from "../src/observe/events.js";
import type { AuthEvent } from "../src/observe/port.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { OPERATOR_SECRETS, operatorFixture } from "./operator-helpers.js";
import { verifiedSession } from "./totp-helpers.js";

// Plan 12h Task 5 with Task 6 (rulings 20 and 22). Each end of sessions in
// an operator act, an organization write, and the sweep emits one
// session.end with its exact count. The tests set no session.afterEnd hook.

const TARGET = "ada@example.com";
const APP = { kind: "app", name: "support-tool" } as const;
const REASON = "Ticket 4711: the user cannot see the invoices";

/**
 * A platform operator, a target with two sessions of their own, the
 * impersonation tool, and a recording sink. No hook listens, so every end
 * runs in one statement or in pages, and no row is read for an event.
 */
async function world(extra: Partial<AuthConfig> = {}) {
  const batches: AuthEvent[][] = [];
  const f = await operatorFixture({
    config: {
      operator: {
        secrets: [
          {
            name: "support",
            secretHash: await sha256Hex(OPERATOR_SECRETS.support),
            scopes: ["users", "sessions", "audit"],
          },
        ],
        users: true,
        impersonation: {},
      },
      observe: { sink: { write: (b) => void batches.push([...b]) } },
      ...extra,
    },
  });
  const target = await verifiedSession(f.auth, TARGET);
  async function events(): Promise<AuthEvent[]> {
    await f.auth.config.observe.flush();
    return batches.flat();
  }
  return { ...f, target, events };
}
type World = Awaited<ReturnType<typeof world>>;

/** An impersonation of the target by the operator. Answers its token. */
async function impersonate(w: World): Promise<string> {
  const r = await startImpersonation(w.auth.config, {
    operator: w.operator,
    userId: w.target.user.id,
    reason: REASON,
    ip: null,
    userAgent: null,
  });
  if (!r.ok) throw new Error(r.code);
  return r.value.token;
}

/** The session.end events that `act` emits, as reason and count. */
async function ends(w: World, act: () => Promise<{ ok: boolean }>) {
  const before = (await w.events()).length;
  expect((await act()).ok).toBe(true);
  return (await w.events())
    .slice(before)
    .filter((e) => e.name === "session.end")
    .map((e) => [e.reason, e.count]);
}

const sessionsOf = (w: World, userId: string) =>
  w.auth.storage.findMany("session", [{ field: "userId", op: "eq", value: userId }]);

const input = (userId: string) => ({
  actor: APP,
  userId,
  reason: "Abuse report 12",
  ip: null,
  userAgent: null,
});

describe("the session.end count of each end site (plan 12h Task 5)", () => {
  it("names session.end, sign_up, and email.verify in the hook map", () => {
    expect([
      HOOK_EVENTS["session.afterEnd"],
      HOOK_EVENTS["user.afterCreate"],
      HOOK_EVENTS["user.afterVerify"],
    ]).toEqual(["session.end", "sign_up", "email.verify"]);
  });

  it("counts an operator end of one user's sessions and of all sessions", async () => {
    // The target's two sessions and the impersonation session.
    const one = await world();
    await impersonate(one);
    expect(await sessionsOf(one, one.target.user.id)).toHaveLength(3);
    const base = { actor: APP, reason: "Key leak", ip: null, userAgent: null };
    const api = operatorApi(one.auth.config).sessions;
    expect(await ends(one, () => api.endUser({ ...base, userId: one.target.user.id }))).toEqual([
      ["operator", 3],
    ]);
    const all = await world();
    await impersonate(all);
    const live = (await all.auth.storage.findMany("session", [])).length;
    expect(await ends(all, () => operatorApi(all.auth.config).sessions.endAll(base))).toEqual([
      ["operator", live],
    ]);
  });

  it("counts a ban and a revoke of the platform role", async () => {
    const banned = await world();
    await impersonate(banned);
    expect(
      await ends(banned, () =>
        operatorApi(banned.auth.config).users.ban(input(banned.target.user.id)),
      ),
    ).toEqual([["banned", 3]]);
    // The revoke ends the impersonation session and the operator's own session.
    const revoked = await world();
    await impersonate(revoked);
    expect(await sessionsOf(revoked, revoked.operator.user.id)).toHaveLength(1);
    expect(
      await ends(revoked, () =>
        operatorApi(revoked.auth.config).platformRole.revoke(input(revoked.operator.user.id)),
      ),
    ).toEqual([["operator", 2]]);
  });

  it("counts the role loss of a removal and of a role change", async () => {
    const removed = await world();
    await impersonate(removed);
    expect(
      await ends(removed, () =>
        removeMember(removed.auth.config, {
          user: removed.root,
          organizationId: removed.platformOrg.id,
          userId: removed.operator.user.id,
        }),
      ),
    ).toEqual([["impersonation_end", 1]]);
    const changed = await world();
    await impersonate(changed);
    expect(
      await ends(changed, () =>
        updateMemberRole(changed.auth.config, {
          user: changed.root,
          organizationId: changed.platformOrg.id,
          userId: changed.operator.user.id,
          role: "member",
        }),
      ),
    ).toEqual([["impersonation_end", 1]]);
  });

  it("counts the stop of an impersonation and a relying party logout", async () => {
    const w = await world();
    const session = await resolveSession(w.auth.config, await impersonate(w));
    if (!session) throw new Error("no impersonation session");
    expect(
      await ends(w, () => stopImpersonation(w.auth.config, { session, ip: null, userAgent: null })),
    ).toEqual([["impersonation_end", 1]]);
    expect(await ends(w, async () => ({ ok: await endSession(w.auth.config, w.target) }))).toEqual([
      ["oidc_logout", 1],
    ]);
  });

  it("counts the account delete of an operator with its impersonation session", async () => {
    const w = await world();
    await impersonate(w);
    // The operator's own session and the impersonation session that the operator opened.
    expect(
      await ends(w, () =>
        deleteAccount(w.auth.config, { session: w.operator, ip: null, userAgent: null }),
      ),
    ).toEqual([["account_deleted", 2]]);
  });

  it("counts the pages of a ban that the sweep ends", async () => {
    // 50 impersonation sessions cost 2 calls each. So the ban ends one page
    // of them in its act, and a pending-end row holds the rest.
    const w = await world({ limiter: { allow: async () => true } });
    for (let i = 0; i < 50; i++) await impersonate(w);
    const before = (await w.events()).length;
    expect((await operatorApi(w.auth.config).users.ban(input(w.operator.user.id))).ok).toBe(true);
    const live = async () =>
      (await w.auth.storage.findMany("session", [{ field: "actorId", op: "ne", value: null }]))
        .length;
    const left = await live();
    expect(left).toBeGreaterThan(0);
    for (let i = 0; i < 10 && (await live()) > 0; i++) await sweepExpired(w.auth.config);
    expect(await live()).toBe(0);
    const counted = (await w.events())
      .slice(before)
      .filter((e) => e.name === "session.end")
      .map((e) => [e.reason, e.count]);
    // The act: the page and the operator's own session. Then the sweep: the rest, with the reason of the row.
    expect(counted[0]).toEqual(["banned", 50 - left + 1]);
    expect(counted.slice(1).every(([reason]) => reason === "banned")).toBe(true);
    expect(counted.slice(1).reduce((n, [, c]) => n + Number(c), 0)).toBe(left);
  });

  it("emits operator.action for each stop row of a flow that is no operator act", async () => {
    const w = await world();
    await impersonate(w);
    const before = (await w.events()).length;
    expect((await revokeOtherSessions(w.auth.config, { session: w.target })).ok).toBe(true);
    const acted = (await w.events()).slice(before).filter((e) => e.name === "operator.action");
    expect(acted.map((e) => e.action)).toEqual(["impersonation_stop"]);
  });
});
