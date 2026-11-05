import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { deleteAccount } from "../src/engine/account-delete.js";
import { confirmEmailChange, requestEmailChange } from "../src/engine/email-change.js";
import { impersonationStops } from "../src/engine/operator/audit.js";
import { startImpersonation } from "../src/engine/operator/impersonation.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { removeMember } from "../src/engine/organizations.js";
import {
  changePassword,
  passwordSignUp,
  requestPasswordReset,
  resetPassword,
  verifyPasswordEmail,
} from "../src/engine/password.js";
import { revokeOtherSessions, revokeSession } from "../src/engine/session-list.js";
import { destroySession, resolveSession } from "../src/engine/sessions.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { enableTotp, setupTotp } from "../src/engine/totp.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { base32Decode } from "../src/primitives/totp.js";
import type { UserRow } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { get, post, tokenFromMail } from "./helpers.js";
import { OPERATOR_SECRETS, operatorFixture } from "./operator-helpers.js";
import { codeNow, PASSWORD, verifiedSession } from "./totp-helpers.js";

// The stop rows of ruling 43 of plan 12f: every end of an impersonation
// session but the expiry writes one `impersonation_stop` row with its
// cause, in the transaction of the end. Each state comes from the flows.

const TARGET = "ada@example.com";
const APP = { kind: "app", name: "support-tool" } as const;
const REASON = "Ticket 4711: the user cannot see the invoices";

async function operatorOn(impersonation: boolean): Promise<Pick<AuthConfig, "operator">> {
  return {
    operator: {
      secrets: [
        {
          name: "support",
          secretHash: await sha256Hex(OPERATOR_SECRETS.support),
          scopes: ["users", "sessions", "audit"],
        },
      ],
      users: true,
      ...(impersonation ? { impersonation: {} } : {}),
    },
  };
}

/** A platform operator, a target with a session of their own, and the routes. */
async function world(extra: Partial<AuthConfig> = {}, impersonation = true) {
  const f = await operatorFixture({ config: { ...(await operatorOn(impersonation)), ...extra } });
  const target = await verifiedSession(f.auth, TARGET);
  const handle = createRouter(f.auth.config, coreRoutes(f.auth.config));
  return { ...f, target, handle };
}
type World = Awaited<ReturnType<typeof world>>;

/** An impersonation of `userId` by the operator. Answers its token and session id. */
async function impersonate(w: World, userId = w.target.user.id) {
  const r = await startImpersonation(w.auth.config, {
    operator: w.operator,
    userId,
    reason: REASON,
    ip: null,
    userAgent: null,
  });
  if (!r.ok) throw new Error(r.code);
  return { token: r.value.token, sessionId: r.value.session.id };
}

/** The stop rows, oldest first, as the fields a reader of the audit needs. */
async function stops(w: World) {
  const rows = await w.auth.storage.findMany(
    "operatorAudit",
    [{ field: "action", op: "eq", value: "impersonation_stop" }],
    { sort: { field: "id", dir: "asc" } },
  );
  return rows.map((r) => ({
    actor: [r.actorKind, r.actorId],
    targetUserId: r.targetUserId,
    reason: r.reason,
    data: r.data,
  }));
}

/** The one stop row of a session of the target, with the fixed reason of its cause. */
function stopOf(w: World, sessionId: string, cause: string, reason: string, target = w.target) {
  return {
    actor: ["user", w.operator.user.id],
    targetUserId: target.user.id,
    reason,
    data: { sessionId, cause },
  };
}

const input = (userId: string) => ({
  actor: APP,
  userId,
  reason: "Abuse report 12",
  ip: null,
  userAgent: null,
});

describe("the stop rows of the impersonation (ruling 43 of plan 12f)", () => {
  it("writes the cause stop at the stop act", async () => {
    const w = await world();
    const { token, sessionId } = await impersonate(w);
    const res = await w.handle(
      post("/auth/operator/impersonate/stop", {}, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    expect(await stops(w)).toEqual([
      stopOf(w, sessionId, "stop", "The operator stopped the impersonation."),
    ]);
  });

  it("refuses a stop reason with a NUL or a lone surrogate as invalid_body (ruling 26)", async () => {
    const w = await world();
    for (const reason of ["Done\u0000", "Done \ud800"]) {
      // A session with no actor: past the reader, the stop answers not_found.
      // So the answer shows that the reader refused the body first.
      const res = await w.handle(
        post(
          "/auth/operator/impersonate/stop",
          { reason },
          { authorization: `Bearer ${w.target.token}` },
        ),
      );
      expect(res.status, reason).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    }
    const res = await w.handle(
      post("/auth/operator/impersonate/stop", {}, { authorization: `Bearer ${w.target.token}` }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("writes user_end when the user revokes the session, or all the others", async () => {
    for (const how of ["one", "others"] as const) {
      const w = await world();
      const { sessionId } = await impersonate(w);
      const r =
        how === "one"
          ? await revokeSession(w.auth.config, { session: w.target, id: sessionId })
          : await revokeOtherSessions(w.auth.config, { session: w.target });
      expect(r.ok, how).toBe(true);
      expect(await stops(w), how).toEqual([
        stopOf(w, sessionId, "user_end", "The user ended the impersonation session."),
      ]);
    }
  });

  it("writes user_end when the user changes the password", async () => {
    const w = await world();
    const { sessionId } = await impersonate(w);
    const r = await changePassword(w.auth.config, {
      session: w.target,
      currentPassword: PASSWORD,
      newPassword: "a new password for ada",
    });
    expect(r.ok).toBe(true);
    expect(await stops(w)).toEqual([
      stopOf(w, sessionId, "user_end", "The user ended the impersonation session."),
    ]);
  });

  it("writes user_end at a change of address, a reset, and a second-factor enable", async () => {
    for (const how of ["email", "reset", "factor"] as const) {
      const w = await world();
      const { sessionId } = await impersonate(w);
      if (how === "email") {
        await requestEmailChange(w.auth.config, {
          session: w.target,
          newEmail: "ada.new@example.com",
        });
        const token = /token=([A-Za-z0-9_%-]+)/.exec(w.auth.mail.at(-1)?.text ?? "")?.[1] ?? "";
        const r = await confirmEmailChange(w.auth.config, { token, ip: null, userAgent: null });
        expect(r.ok, how).toBe(true);
      } else if (how === "reset") {
        expect((await requestPasswordReset(w.auth.config, { email: TARGET, ip: null })).ok).toBe(
          true,
        );
        const r = await resetPassword(w.auth.config, {
          token: tokenFromMail(w.auth.mail.at(-1)?.text ?? ""),
          password: "a reset long password",
          ip: null,
          userAgent: null,
        });
        expect(r.ok, how).toBe(true);
      } else {
        const setup = await setupTotp(w.auth.config, {
          session: w.target,
          password: PASSWORD,
        });
        if (!setup.ok) throw new Error(setup.code);
        const r = await enableTotp(w.auth.config, {
          session: w.target,
          code: await codeNow(w.auth, base32Decode(setup.value.secret)),
        });
        expect(r.ok, how).toBe(true);
      }
      expect(await stops(w), how).toEqual([
        stopOf(w, sessionId, "user_end", "The user ended the impersonation session."),
      ]);
    }
  });

  it("writes operator_end at an end of one user's sessions and of all sessions", async () => {
    for (const hook of [false, true])
      for (const call of ["endUser", "endAll"] as const) {
        const w = await world(hook ? { hooks: { session: { afterEnd: () => {} } } } : {});
        const { sessionId } = await impersonate(w);
        const api = operatorApi(w.auth.config).sessions;
        const base = { actor: APP, reason: "Key leak", ip: null, userAgent: null };
        const r =
          call === "endUser"
            ? await api.endUser({ ...base, userId: w.target.user.id })
            : await api.endAll(base);
        expect(r.ok, call).toBe(true);
        expect(await stops(w), `${call} ${hook}`).toEqual([
          stopOf(
            w,
            sessionId,
            "operator_end",
            "An operator ended the sessions, and the impersonation session with them.",
          ),
        ]);
        expect(
          await w.auth.storage.findMany("session", [{ field: "actorId", op: "ne", value: null }]),
        ).toEqual([]);
      }
  });

  it("writes sign_out when the app signs the session out in process", async () => {
    const w = await world();
    const { token, sessionId } = await impersonate(w);
    expect(await destroySession(w.auth.config, token)).not.toBeNull();
    expect(await stops(w)).toEqual([
      stopOf(w, sessionId, "sign_out", "A sign-out ended the impersonation session."),
    ]);
  });

  it("writes claim when a proof of the mailbox claims an unverified account", async () => {
    const w = await world();
    const email = "eve@example.com";
    const up = await passwordSignUp(w.auth.config, {
      email,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!up.ok) throw new Error(up.code);
    const user = await w.auth.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
    if (!user) throw new Error("no user");
    const { sessionId } = await impersonate(w, user.id);
    const mail = w.auth.mail.findLast((m) => m.to === email && m.subject.startsWith("Confirm"));
    const v = await verifyPasswordEmail(w.auth.config, {
      token: tokenFromMail(mail?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    expect(v.ok).toBe(true);
    expect(await stops(w)).toEqual([
      {
        ...stopOf(w, sessionId, "claim", "A claim of the address ended the impersonation session."),
        targetUserId: user.id,
      },
    ]);
  });

  // The door of a claimed session (ruling 13 of plan 12q) ends an
  // impersonation session with its stop row, as the ban door does.
  it("writes claim when the door ends the impersonation session of a claimant (ruling 13 of plan 12q)", async () => {
    const w = await world();
    const email = "eve@example.com";
    const up = await passwordSignUp(w.auth.config, {
      email,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!up.ok) throw new Error(up.code);
    const user = await w.auth.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
    if (!user) throw new Error("no user");
    // The target is unverified, so the impersonation session is unproved.
    const { token, sessionId } = await impersonate(w, user.id);
    // Memory runs one transaction at a time. So the read in the claim's gap
    // runs its transaction on the store at once, as a parallel request on D1 does.
    const free: StorageAdapter = { ...w.auth.storage, transaction: (fn) => fn(free) };
    const side = { ...w.auth.config, storage: free };
    const reader = createRouter(side, coreRoutes(side));
    const gap: Record<string, unknown> = {};
    let armed = true;
    // The claim's gap: right after the flip, before the claim's session delete.
    const flipped = (a: StorageAdapter): StorageAdapter => ({
      ...a,
      update: async (m, where, data) => {
        const n = await a.update(m, where, data);
        if (armed && n > 0 && m === "user" && (data as Partial<UserRow>).emailVerified === true) {
          armed = false;
          const now = await free.findOne("user", [{ field: "id", op: "eq", value: user.id }]);
          gap.verified = now?.emailVerified;
          const read = await reader(get("/auth/session", { authorization: `Bearer ${token}` }));
          gap.read = read.status;
          gap.stops = await stops(w);
        }
        return n;
      },
      transaction: (fn) => a.transaction((tx) => fn(flipped(tx))),
    });
    const mail = w.auth.mail.findLast((m) => m.to === email && m.subject.startsWith("Confirm"));
    const v = await verifyPasswordEmail(
      { ...w.auth.config, storage: flipped(w.auth.storage) },
      { token: tokenFromMail(mail?.text ?? ""), ip: null, userAgent: null },
    );
    expect(v.ok).toBe(true);
    const stop = {
      ...stopOf(w, sessionId, "claim", "A claim of the address ended the impersonation session."),
      targetUserId: user.id,
    };
    expect(gap).toEqual({ verified: true, read: 401, stops: [stop] });
    // The claim's own delete found no session, so it wrote no second stop row.
    expect(await stops(w)).toEqual([stop]);
    expect(
      await w.auth.storage.findOne("session", [{ field: "id", op: "eq", value: sessionId }]),
    ).toBeNull();
  });

  it("writes ban at a ban of the target and at a ban of the operator", async () => {
    for (const whom of ["target", "operator"] as const) {
      const w = await world();
      const { sessionId } = await impersonate(w);
      const userId = whom === "target" ? w.target.user.id : w.operator.user.id;
      const r = await operatorApi(w.auth.config).users.ban(input(userId));
      expect(r.ok, whom).toBe(true);
      expect(await stops(w), whom).toEqual([
        stopOf(w, sessionId, "ban", "A ban ended the impersonation session."),
      ]);
    }
  });

  it("writes ban when a request presents an impersonation session that the ban left for the sweep", async () => {
    // Every request passes: the 60 sign-ins would fill the sign-in limit.
    const w = await world({
      hooks: { session: { afterEnd: () => {} } },
      limiter: { allow: async () => true },
    });
    // 60 sessions of the target, then the impersonation: a ban with a hook ends a page of
    // the first rows in its act and leaves the rest for the sweep (ruling 44).
    for (let i = 0; i < 59; i++) await verifiedSession(w.auth, TARGET);
    w.auth.clock.advance(1000);
    const { token, sessionId } = await impersonate(w);
    const r = await operatorApi(w.auth.config).users.ban(input(w.target.user.id));
    expect(r.ok).toBe(true);
    expect(
      await w.auth.storage.findOne("session", [{ field: "id", op: "eq", value: sessionId }]),
    ).not.toBeNull();
    expect(await stops(w)).toEqual([]);
    // The door of the ban ends the left row at its next use.
    expect(await resolveSession(w.auth.config, token)).toBeNull();
    expect(await stops(w)).toEqual([
      stopOf(w, sessionId, "ban", "A ban ended the impersonation session."),
    ]);
  });

  it("ends the impersonations of a banned operator in pages, with a door and the sweep for the rest", async () => {
    const w = await world({
      hooks: { session: { afterEnd: () => {} } },
      limiter: { allow: async () => true },
    });
    // 50 impersonation sessions: a ban with a hook ends a page of them in its act (ruling 44).
    const tokens: string[] = [];
    for (let i = 0; i < 50; i++) tokens.push((await impersonate(w)).token);
    const r = await operatorApi(w.auth.config).users.ban(input(w.operator.user.id));
    expect(r.ok).toBe(true);
    const live = () =>
      w.auth.storage.findMany("session", [{ field: "actorId", op: "ne", value: null }]);
    const left = (await live()).length;
    expect(left).toBeGreaterThan(0);
    expect((await stops(w)).length).toBe(50 - left);
    // The door refuses a left session at once and ends it with its stop row.
    const leftToken = await (async () => {
      for (const t of tokens)
        if (
          await w.auth.storage.findOne("session", [
            { field: "tokenHash", op: "eq", value: await sha256Hex(t) },
          ])
        )
          return t;
      throw new Error("no left session");
    })();
    expect(await resolveSession(w.auth.config, leftToken)).toBeNull();
    expect((await stops(w)).length).toBe(51 - left);
    // The sweep ends the rest, each with its stop row: every session ends once.
    for (let i = 0; i < 10 && (await live()).length > 0; i++) await sweepExpired(w.auth.config);
    expect(await live()).toEqual([]);
    const all = await stops(w);
    expect(all.map((s) => s.data)).toHaveLength(50);
    expect(new Set(all.map((s) => (s.data as { sessionId: string }).sessionId)).size).toBe(50);
    expect(new Set(all.map((s) => (s.data as { cause: string }).cause))).toEqual(new Set(["ban"]));
  });

  it("ends in the sweep an impersonation that an instance 2 s ahead opened before the ban (ruling 55 of plan 12d)", async () => {
    const w = await world({
      hooks: { session: { afterEnd: () => {} } },
      limiter: { allow: async () => true },
    });
    for (let i = 0; i < 50; i++) await impersonate(w);
    // An instance whose clock runs 2 s ahead opens one more.
    w.auth.clock.advance(2000);
    const ahead = await impersonate(w);
    w.auth.clock.advance(-2000);
    expect((await operatorApi(w.auth.config).users.ban(input(w.operator.user.id))).ok).toBe(true);
    const live = () =>
      w.auth.storage.findMany("session", [{ field: "actorId", op: "ne", value: null }]);
    // The act ends a page; the one from ahead sorts last and waits for the sweep.
    expect((await live()).map((r) => r.id)).toContain(ahead.sessionId);
    for (let i = 0; i < 10 && (await live()).length > 0; i++) await sweepExpired(w.auth.config);
    expect(await live()).toEqual([]);
  });

  it("writes revoke at a revoke of the platform role", async () => {
    const w = await world();
    const { sessionId } = await impersonate(w);
    const r = await operatorApi(w.auth.config).platformRole.revoke(input(w.operator.user.id));
    expect(r.ok).toBe(true);
    expect(await stops(w)).toEqual([
      stopOf(
        w,
        sessionId,
        "revoke",
        "A revoke of the platform role ended the impersonation session.",
      ),
    ]);
  });

  it("writes role_loss at a removal from the platform organization", async () => {
    const w = await world();
    const { sessionId } = await impersonate(w);
    const r = await removeMember(w.auth.config, {
      user: w.root,
      organizationId: w.platformOrg.id,
      userId: w.operator.user.id,
    });
    expect(r.ok).toBe(true);
    expect(await stops(w)).toEqual([
      stopOf(
        w,
        sessionId,
        "role_loss",
        "A change of the operator's platform role ended the impersonation session.",
      ),
    ]);
  });

  it("writes account_delete at the account delete of the target and of the operator", async () => {
    for (const whom of ["target", "operator"] as const) {
      const w = await world();
      const { sessionId } = await impersonate(w);
      const r = await deleteAccount(w.auth.config, {
        session: whom === "target" ? w.target : w.operator,
        ip: null,
        userAgent: null,
      });
      expect(r.ok, whom).toBe(true);
      expect(await stops(w), whom).toEqual([
        stopOf(
          w,
          sessionId,
          "account_delete",
          "An account delete ended the impersonation session.",
        ),
      ]);
    }
  });

  it("writes no stop row at the expiry", async () => {
    const w = await world();
    const { token } = await impersonate(w);
    w.auth.clock.advance(61 * 60_000);
    expect(await resolveSession(w.auth.config, token)).toBeNull();
    expect(await stops(w)).toEqual([]);
  });

  it("runs operator.afterAction once per stop row of a flow that is no operator act", async () => {
    const seen: unknown[] = [];
    const w = await world({
      hooks: {
        operator: {
          afterAction: ({ audit }) => {
            seen.push([audit.action, audit.data]);
          },
        },
      },
    });
    const { sessionId } = await impersonate(w);
    seen.length = 0;
    const r = await revokeOtherSessions(w.auth.config, { session: w.target });
    expect(r.ok).toBe(true);
    expect(seen).toEqual([["impersonation_stop", { sessionId, cause: "user_end" }]]);
  });

  it("reads no impersonation session while the tool is off", async () => {
    // The same flow in two worlds; the one with the tool on pays one read more.
    const costs: number[] = [];
    for (const on of [true, false]) {
      const w = await world({}, on);
      await verifiedSession(w.auth, TARGET);
      const storage = w.auth.config.storage;
      const before = storage.statementsSent?.() ?? Number.NaN;
      const r = await revokeOtherSessions(w.auth.config, { session: w.target });
      expect(r.ok).toBe(true);
      costs.push((storage.statementsSent?.() ?? Number.NaN) - before);
    }
    expect(costs[0]).toBe((costs[1] ?? 0) + 1);
    expect(impersonationStops({}, "ban")).toBeNull();
  });
});

describe("the order of the audit rows in one millisecond (ruling 58 Q4 of plan 12f)", () => {
  it("lists two acts and their stop rows in write order, 100 times on a fixed clock", async () => {
    // Every request passes: 300 starts on one clock would fill the start limit.
    const w = await world({ limiter: { allow: async () => true } });
    // The ids of the audit rows in the order of their writes, inside and outside a transaction.
    const written: string[] = [];
    const record = <T extends { create: StorageAdapter["create"] }>(handle: T): T => {
      const create = handle.create.bind(handle);
      handle.create = (async (model, data) => {
        const row = await create(model, data);
        if (model === "operatorAudit") written.push((row as { id: string }).id);
        return row;
      }) as StorageAdapter["create"];
      return handle;
    };
    const storage = record(w.auth.storage as StorageAdapter);
    const transaction = storage.transaction.bind(storage);
    storage.transaction = (fn) => transaction((tx) => fn(record({ ...tx })));
    const api = operatorApi(w.auth.config);
    const end = async () => {
      const r = await api.sessions.endUser({
        actor: APP,
        userId: w.target.user.id,
        reason: "Key leak",
        ip: null,
        userAgent: null,
      });
      if (!r.ok) throw new Error(r.code);
    };
    // The clock never moves: every row of the test shares one millisecond.
    const at = w.auth.clock.now().getTime();
    for (let i = 0; i < 100; i++) {
      await impersonate(w);
      await impersonate(w);
      await end();
      await impersonate(w);
      await end();
    }
    storage.transaction = transaction;
    expect(w.auth.clock.now().getTime()).toBe(at);
    // 100 rounds of 3 starts, 3 stop rows, and 2 end acts.
    expect(written).toHaveLength(800);
    const listed: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await api.audit.list({ actor: APP, limit: 100, ...(after ? { after } : {}) });
      if (!page.ok) throw new Error(page.code);
      listed.push(...page.value.rows.map((r) => r.id));
      if (page.value.next === null) break;
      after = page.value.next;
    }
    expect(listed).toEqual(written);
    const actions = (
      await w.auth.storage.findMany("operatorAudit", [], {
        sort: { field: "id", dir: "asc" },
      })
    ).map((r) => r.action);
    expect(actions.slice(0, 8)).toEqual([
      "impersonation_start",
      "impersonation_start",
      "impersonation_stop",
      "impersonation_stop",
      "sessions_end_user",
      "impersonation_start",
      "impersonation_stop",
      "sessions_end_user",
    ]);
  });
});

describe("the lock order of the revoke (final review L1 of plan 12f)", () => {
  it("locks the user row, then the sessions of the impersonation targets, then the member rows", async () => {
    const w = await world();
    await impersonate(w);
    // The writes and the locks of the act's transaction, in order. Memory has no
    // lockInOrder; the view adds the one that Postgres has, and records it.
    const steps: string[] = [];
    const storage = w.auth.storage as StorageAdapter;
    const transaction = storage.transaction.bind(storage);
    storage.transaction = (fn) =>
      transaction((tx) =>
        fn({
          ...tx,
          update: (model, where, patch) => {
            steps.push(`update ${model}`);
            return tx.update(model, where, patch);
          },
          delete: (model, where) => {
            steps.push(`delete ${model}`);
            return tx.delete(model, where);
          },
          lockInOrder: async (model) => {
            steps.push(`lock ${model}`);
          },
        }),
      );
    const r = await operatorApi(w.auth.config).platformRole.revoke(input(w.operator.user.id));
    storage.transaction = transaction;
    expect(r.ok).toBe(true);
    const lock = steps.indexOf("lock session");
    const member = steps.findIndex((s) => s.endsWith(" member"));
    expect(steps[0]).toBe("update user");
    expect(lock).toBe(1);
    expect(member).toBeGreaterThan(lock);
  });
});
