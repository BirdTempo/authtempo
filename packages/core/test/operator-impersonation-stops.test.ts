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
import { enableTotp, setupTotp } from "../src/engine/totp.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { base32Decode } from "../src/primitives/totp.js";
import { post, tokenFromMail } from "./helpers.js";
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
          userId: w.target.user.id,
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
        "A member change took the platform role, and the impersonation session ended.",
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
