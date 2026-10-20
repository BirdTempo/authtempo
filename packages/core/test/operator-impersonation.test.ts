import { describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { HookRefusal } from "../src/engine/hooks.js";
import { mintSessionJwt, verifySessionJwt } from "../src/engine/jwt.js";
import { requireOperatorUser } from "../src/engine/operator/guards.js";
import { startImpersonation } from "../src/engine/operator/impersonation.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { addMember } from "../src/engine/organizations.js";
import { listSessions } from "../src/engine/session-list.js";
import { destroySession, resolveSession } from "../src/engine/sessions.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { post } from "./helpers.js";
import {
  OPERATOR_SECRETS,
  operatorFixture,
  operatorHeader,
  sessionOf,
} from "./operator-helpers.js";
import { enrolled, verifiedSession } from "./totp-helpers.js";

const MINUTE_MS = 60_000;
const TARGET = "ada@example.com";
const APP = { kind: "app", name: "support-tool" } as const;
const REASON = "Ticket 4711: the user cannot see the invoices";

/** The operator section of the fixture with impersonation on. */
async function operatorWith(impersonation: {
  ttlMinutes?: number;
  notice?: boolean;
}): Promise<Pick<AuthConfig, "operator">> {
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
      impersonation,
    },
  };
}

/**
 * A platform operator (Task 3 fixture), a target user with a session of
 * their own, and the HTTP view of the same config. Every state comes from
 * the flows of the product.
 */
async function world(
  impersonation: { ttlMinutes?: number; notice?: boolean } = {},
  extra: Partial<AuthConfig> = {},
) {
  const f = await operatorFixture({ config: { ...(await operatorWith(impersonation)), ...extra } });
  const target = await verifiedSession(f.auth, TARGET);
  const handle = createRouter(f.auth.config, coreRoutes(f.auth.config));
  return { ...f, target, handle };
}
type World = Awaited<ReturnType<typeof world>>;

const sessionCookie = (token: string) => `__Host-tempo_session=${token}`;

/** The start route with the operator's session cookie. */
function startRequest(w: World, userId = w.target.user.id, headers?: Record<string, string>) {
  return w.handle(
    post(
      "/auth/operator/impersonate",
      { userId, reason: REASON },
      headers ?? { cookie: sessionCookie(w.operator.token) },
    ),
  );
}

/** The value of the cookie `name` in the Set-Cookie lines, or null. */
function cookieOf(sets: string[], name: string): string | null {
  const line = sets.find((s) => s.startsWith(`${name}=`));
  return line === undefined ? null : (line.slice(name.length + 1).split(";")[0] ?? null);
}

/** Starts an impersonation through the route and answers its session token. */
async function started(w: World): Promise<string> {
  const res = await startRequest(w);
  expect(res.status).toBe(200);
  const token = cookieOf(res.headers.getSetCookie(), "__Host-tempo_session");
  if (token === null) throw new Error("the start set no session cookie");
  return token;
}

const auditRows = (w: World) =>
  w.auth.storage.findMany("operatorAudit", [], { sort: { field: "id", dir: "asc" } });

describe("the impersonation (plan 12f Task 11)", () => {
  it("starts and stops an impersonation with the cookie swap", async () => {
    const w = await world();
    const res = await startRequest(w);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["auditId", "expiresAt"]);
    const sets = res.headers.getSetCookie();
    const token = cookieOf(sets, "__Host-tempo_session");
    if (token === null) throw new Error("no session cookie");
    expect(token).not.toBe(w.operator.token);
    expect(sets).toContain(
      `__Host-tempo_session=${token}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(sets).toContain(
      `__Host-tempo_session_actor=${w.operator.token}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`,
    );

    const session = await w.handle(
      new Request("https://api.example.com/auth/session", {
        headers: { cookie: sessionCookie(token) },
      }),
    );
    const seen = (await session.json()) as {
      user: { id: string };
      session: { actorId: string | null; expiresAt: string };
    };
    expect(seen.user.id).toBe(w.target.user.id);
    expect(seen.session.actorId).toBe(w.operator.user.id);
    expect(seen.session.expiresAt).toBe(body.expiresAt);
    // Never fresh, and no operator address in the user's own list.
    const row = await w.auth.storage.findOne("session", [
      { field: "actorId", op: "eq", value: w.operator.user.id },
    ]);
    expect([row?.freshAt, row?.ip, row?.userAgent]).toEqual([null, null, null]);

    // A minute of support work: the stop row gets a later id than the start row.
    w.auth.clock.advance(MINUTE_MS);
    const stop = await w.handle(
      post(
        "/auth/operator/impersonate/stop",
        {},
        {
          cookie: `${sessionCookie(token)}; __Host-tempo_session_actor=${w.operator.token}`,
        },
      ),
    );
    expect(stop.status).toBe(200);
    const stopBody = (await stop.json()) as Record<string, unknown>;
    expect(stopBody.restored).toBe(true);
    const back = stop.headers.getSetCookie();
    expect(back).toContain(
      "__Host-tempo_session_actor=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    );
    expect(cookieOf(back, "__Host-tempo_session")).toBe(w.operator.token);
    expect(await resolveSession(w.auth.config, token)).toBeNull();
    expect((await resolveSession(w.auth.config, w.operator.token))?.user.id).toBe(
      w.operator.user.id,
    );

    const rows = await auditRows(w);
    expect(rows.map((r) => [r.action, r.actorKind, r.actorId, r.targetUserId])).toEqual([
      ["impersonation_start", "user", w.operator.user.id, w.target.user.id],
      ["impersonation_stop", "user", w.operator.user.id, w.target.user.id],
    ]);
    expect(rows[0]?.reason).toBe(REASON);
    // The stop named no reason: the row holds the fixed text.
    expect(rows[1]?.reason).toBe("The operator stopped the impersonation.");
    expect(rows[0]?.data).toEqual({ sessionId: expect.any(String), expiresAt: body.expiresAt });
    const startData = rows[0]?.data as { sessionId: string } | undefined;
    expect(rows[1]?.data).toEqual({ sessionId: startData?.sessionId });
    expect(stopBody.auditId).toBe(rows[1]?.id);
    expect(body.auditId).toBe(rows[0]?.id);
  });

  it("gives a bearer caller the token in the body and no cookie", async () => {
    const w = await world();
    const res = await startRequest(w, w.target.user.id, {
      authorization: `Bearer ${w.operator.token}`,
    });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    const body = (await res.json()) as { token: string; expiresAt: string };
    expect(Object.keys(body).sort()).toEqual(["auditId", "expiresAt", "token"]);
    const resolved = await resolveSession(w.auth.config, body.token);
    expect(resolved?.session.actorId).toBe(w.operator.user.id);
    const stop = await w.handle(
      post("/auth/operator/impersonate/stop", {}, { authorization: `Bearer ${body.token}` }),
    );
    expect(stop.status).toBe(200);
    expect(stop.headers.getSetCookie()).toEqual([]);
    expect(((await stop.json()) as { restored: boolean }).restored).toBe(false);
    expect(await resolveSession(w.auth.config, body.token)).toBeNull();
  });

  it("clears the session cookie at the stop when the operator's own session ended", async () => {
    const w = await world();
    const token = await started(w);
    // The operator's own session ends elsewhere, as api.signOut ends it.
    expect(await destroySession(w.auth.config, w.operator.token)).not.toBeNull();
    const stop = await w.handle(
      post(
        "/auth/operator/impersonate/stop",
        {},
        { cookie: `${sessionCookie(token)}; __Host-tempo_session_actor=${w.operator.token}` },
      ),
    );
    expect(stop.status).toBe(200);
    expect(((await stop.json()) as { restored: boolean }).restored).toBe(false);
    const sets = stop.headers.getSetCookie();
    expect(sets).toContain(
      "__Host-tempo_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    );
    expect(sets).toContain(
      "__Host-tempo_session_actor=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    );
  });

  it("answers not_found at the stop for a session that is not an impersonation", async () => {
    const w = await world();
    const res = await w.handle(
      post("/auth/operator/impersonate/stop", {}, { cookie: sessionCookie(w.target.token) }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(await resolveSession(w.auth.config, w.target.token)).not.toBeNull();
    expect(await auditRows(w)).toEqual([]);
  });

  it("ends at ttlMinutes with the sliding refresh due", async () => {
    const w = await world({ ttlMinutes: 30 }, { session: { slidingRefreshDays: 0 } });
    const token = await started(w);
    const first = await resolveSession(w.auth.config, token);
    if (!first) throw new Error("no session");
    const expiresAt = first.session.expiresAt.getTime();
    w.auth.clock.advance(29 * MINUTE_MS);
    const later = await resolveSession(w.auth.config, token);
    expect(later?.session.expiresAt.getTime()).toBe(expiresAt);
    expect(later?.refreshed).toBe(false);
    const row = await w.auth.storage.findOne("session", [
      { field: "id", op: "eq", value: first.session.id },
    ]);
    expect(row?.expiresAt.getTime()).toBe(expiresAt);
    w.auth.clock.advance(2 * MINUTE_MS);
    expect(await resolveSession(w.auth.config, token)).toBeNull();
    // The expiry writes no audit row: the start row holds expiresAt.
    expect((await auditRows(w)).map((r) => r.action)).toEqual(["impersonation_start"]);
  });

  it("refuses the operator, a platform operator, a banned target, and an absent user with one code", async () => {
    const w = await world();
    const second = await enrolled(w.auth, "op2@example.com");
    const added = await addMember(w.auth.config, {
      user: w.root,
      organizationId: w.platformOrg.id,
      userId: second.user.id,
      role: "operator",
    });
    if (!added.ok) throw new Error(added.code);
    const banned = await operatorApi(w.auth.config).users.ban({
      actor: APP,
      userId: w.target.user.id,
      reason: "Abuse report 12",
      ip: null,
      userAgent: null,
    });
    if (!banned.ok) throw new Error(banned.code);
    const answers = [];
    for (const userId of [w.operator.user.id, second.user.id, w.target.user.id, "absent-user"]) {
      const res = await startRequest(w, userId);
      answers.push({ status: res.status, body: await res.json() });
    }
    for (const a of answers)
      expect(a).toEqual({ status: 403, body: { error: "impersonation_refused" } });
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(
      await w.auth.storage.findMany("session", [{ field: "actorId", op: "ne", value: null }]),
    ).toEqual([]);
    expect((await auditRows(w)).map((r) => r.action)).toEqual(["ban"]);
  });

  it("refuses a secret", async () => {
    const w = await world();
    const res = await startRequest(w, w.target.user.id, operatorHeader(OPERATOR_SECRETS.support));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(await auditRows(w)).toEqual([]);
  });

  it("mints a session JWT with act and a capped exp", async () => {
    const w = await world(
      {},
      { jwtMint: { claims: () => ({ act: { sub: "someone" }, team: "a" }) } },
    );
    const token = await started(w);
    const resolved = await resolveSession(w.auth.config, token);
    if (!resolved) throw new Error("no session");
    // 55 minutes in, 5 minutes stay: less than the 15 of jwtMint.ttlMinutes.
    w.auth.clock.advance(55 * MINUTE_MS);
    const minted = await mintSessionJwt(w.auth.config, {
      userId: w.target.user.id,
      sessionId: resolved.session.id,
    });
    if (!minted.ok) throw new Error(minted.code);
    const claims = await verifySessionJwt(w.auth.config, minted.value.token);
    expect(claims?.act).toEqual({ sub: w.operator.user.id });
    expect(claims?.team).toBe("a");
    expect(claims?.exp).toBe(Math.floor(resolved.session.expiresAt.getTime() / 1000));
    expect(minted.value.expiresAt.getTime()).toBe(resolved.session.expiresAt.getTime());
    // The operator's own session JWT has no act from core, and no cap.
    const own = await mintSessionJwt(w.auth.config, {
      userId: w.operator.user.id,
      sessionId: w.operator.session.id,
    });
    if (!own.ok) throw new Error(own.code);
    const ownClaims = await verifySessionJwt(w.auth.config, own.value.token);
    expect(ownClaims?.act).toBeUndefined();
    expect((ownClaims?.exp ?? 0) - (ownClaims?.iat ?? 0)).toBe(15 * 60);
  });

  it("marks the session in the user's list, and mails the notice", async () => {
    const w = await world();
    const before = w.auth.mail.length;
    // A minute later: the list is newest first by id, and the impersonation row is the newest.
    w.auth.clock.advance(MINUTE_MS);
    await started(w);
    const res = await w.handle(
      new Request("https://api.example.com/auth/sessions", {
        headers: { cookie: sessionCookie(w.target.token) },
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(w.operator.user.id);
    const list = (JSON.parse(text) as { sessions: { current: boolean; impersonation: boolean }[] })
      .sessions;
    // Newest first: the impersonation row, then the user's own rows.
    expect(list.map((s) => s.impersonation)).toEqual([true, ...list.slice(1).map(() => false)]);
    expect(list[0]?.current).toBe(false);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    const mails = w.auth.mail.slice(before);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toBe(TARGET);
    expect(mails[0]?.text).toBe(
      "An operator of api.example.com opened a session on your account at 2026-01-01T00:01:30.000Z, for support.\nIf you did not ask for support, contact api.example.com.",
    );
    // The engine list answers the same mark.
    const listed = await listSessions(w.auth.config, { session: w.target });
    expect(listed.ok && listed.value.map((s) => s.impersonation)).toEqual(
      list.map((s) => s.impersonation),
    );

    const quiet = await world({ notice: false });
    const quietBefore = quiet.auth.mail.length;
    await started(quiet);
    expect(quiet.auth.mail.slice(quietBefore)).toEqual([]);
  });

  it("fires session.afterEnd with impersonation_end at the stop", async () => {
    const reasons: string[] = [];
    const w = await world(
      {},
      {
        hooks: {
          session: {
            afterEnd: ({ reason }) => {
              reasons.push(reason);
            },
          },
        },
      },
    );
    const res = await startRequest(w, w.target.user.id, {
      authorization: `Bearer ${w.operator.token}`,
    });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    reasons.length = 0;
    const stop = await w.handle(
      post("/auth/operator/impersonate/stop", {}, { authorization: `Bearer ${token}` }),
    );
    expect(stop.status).toBe(200);
    expect(reasons).toEqual(["impersonation_end"]);
  });

  it("refuses an impersonation session at the operator guard", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = await world();
    const token = await started(w);
    // The target gets the role, a factor, and a verified address, so only
    // the impersonation step and the fresh step can refuse the session.
    const grant = await operatorApi(w.auth.config).platformRole.grant({
      actor: APP,
      userId: w.target.user.id,
      reason: "New support hire",
      ip: null,
      userAgent: null,
    });
    if (!grant.ok) throw new Error(grant.code);
    const impersonation = await sessionOf(w.auth, token);
    // Step 1 refuses first (spec 26 item 2): the guard sends no statement.
    // Without it, the role read runs, and the fresh step refuses the session.
    const storage = w.auth.config.storage;
    const sent = () => {
      const n = storage.statementsSent?.();
      if (n === undefined) throw new Error("the memory storage counts its statements");
      return n;
    };
    const before = sent();
    expect(await requireOperatorUser(w.auth.config, impersonation)).toEqual({
      ok: false,
      code: "operator_required",
      status: 403,
    });
    expect(sent() - before).toBe(0);
    errors.mockRestore();
  });

  it("refuses an impersonation session as the operator of a new start", async () => {
    const w = await world();
    const token = await started(w);
    const impersonation = await sessionOf(w.auth, token);
    expect(
      await startImpersonation(w.auth.config, {
        operator: impersonation,
        userId: w.operator.user.id,
        reason: REASON,
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: false, code: "impersonation_session", status: 403 });
  });

  it("ends the impersonation sessions of an operator at a ban and at a revoke of the role", async () => {
    for (const act of ["ban", "revoke"] as const) {
      const w = await world();
      const token = await started(w);
      // Half an hour of support work: the act reads the start rows of the
      // last 240 minutes, not of this instant.
      w.auth.clock.advance(30 * MINUTE_MS);
      const api = operatorApi(w.auth.config);
      const done =
        act === "ban"
          ? await api.users.ban({
              actor: APP,
              userId: w.operator.user.id,
              reason: "The operator left",
              ip: null,
              userAgent: null,
            })
          : await api.platformRole.revoke({
              actor: APP,
              userId: w.operator.user.id,
              reason: "The operator left",
              ip: null,
              userAgent: null,
            });
      if (!done.ok) throw new Error(done.code);
      expect(await resolveSession(w.auth.config, token), act).toBeNull();
      expect(
        await w.auth.storage.findMany("session", [{ field: "actorId", op: "ne", value: null }]),
        act,
      ).toEqual([]);
      // The target's own session stays.
      expect((await resolveSession(w.auth.config, w.target.token))?.user.id, act).toBe(
        w.target.user.id,
      );
    }
  });

  it("refuses the start when a ban or a revoke of the operator commits during it", async () => {
    for (const act of ["ban", "revoke"] as const) {
      // The limiter runs between the guard and the transaction: the act of a
      // second request commits there, as two parallel requests can.
      let during: (() => Promise<void>) | null = null;
      const limiter = {
        allow: async (key: string) => {
          const run = during;
          if (key.startsWith("operator-impersonate:") && run) {
            during = null;
            await run();
          }
          return true;
        },
      };
      const w = await world({}, { limiter });
      const api = operatorApi(w.auth.config);
      const input = {
        actor: APP,
        userId: w.operator.user.id,
        reason: "The operator left",
        ip: null,
        userAgent: null,
      };
      during = async () => {
        const r = act === "ban" ? await api.users.ban(input) : await api.platformRole.revoke(input);
        if (!r.ok) throw new Error(r.code);
      };
      const r = await startImpersonation(w.auth.config, {
        operator: w.operator,
        userId: w.target.user.id,
        reason: REASON,
        ip: null,
        userAgent: null,
      });
      expect(during, act).toBeNull();
      expect(r, act).toEqual({ ok: false, code: "operator_required", status: 403 });
      expect(
        await w.auth.storage.findMany("session", [{ field: "actorId", op: "ne", value: null }]),
        act,
      ).toEqual([]);
      expect(
        (await auditRows(w)).map((row) => row.action),
        act,
      ).toEqual([act === "ban" ? "ban" : "platform_role_revoke"]);
    }
  });

  it("answers each code of the start and the stop", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const refusing = await world(
      {},
      {
        hooks: {
          operator: {
            beforeAction: ({ audit }) => {
              if (audit.action === "impersonation_start") throw new HookRefusal("Not now");
            },
          },
        },
      },
    );
    const failing = await world(
      {},
      {
        hooks: {
          session: {
            beforeCreate: ({ via }) => {
              if (via === "impersonation") throw new TypeError("broken hook");
            },
          },
        },
      },
    );
    const w = await world();
    const answer = async (res: Response) => ({ status: res.status, body: await res.json() });
    expect(await answer(await startRequest(refusing))).toEqual({
      status: 403,
      body: { error: "hook_refused", message: expect.any(String) },
    });
    expect(await answer(await startRequest(failing))).toEqual({
      status: 500,
      body: { error: "hook_failed" },
    });
    expect(
      await answer(
        await w.handle(
          post(
            "/auth/operator/impersonate",
            { userId: w.target.user.id, reason: "a\nb" },
            { cookie: sessionCookie(w.operator.token) },
          ),
        ),
      ),
    ).toEqual({ status: 400, body: { error: "invalid_body" } });
    // A user who is no platform operator.
    expect(
      await answer(
        await startRequest(w, w.operator.user.id, { cookie: sessionCookie(w.target.token) }),
      ),
    ).toEqual({ status: 403, body: { error: "operator_required" } });
    // 20 starts per operator per hour, also refused ones. The invalid_body
    // call above counted as the first, after the operator guard.
    for (let i = 0; i < 19; i++) {
      const res = await startRequest(w, w.operator.user.id);
      expect(res.status).toBe(403);
    }
    expect(await answer(await startRequest(w))).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });

    const stop = (world: World, body: unknown, cookie: string | null) =>
      world.handle(
        post("/auth/operator/impersonate/stop", body, cookie === null ? {} : { cookie }),
      );
    expect(await answer(await stop(w, {}, null))).toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
    const stopRefusing = await world(
      {},
      {
        hooks: {
          operator: {
            beforeAction: ({ audit }) => {
              if (audit.action === "impersonation_stop") throw new HookRefusal("Not now");
            },
          },
        },
      },
    );
    const t1 = await started(stopRefusing);
    expect(await answer(await stop(stopRefusing, {}, sessionCookie(t1)))).toEqual({
      status: 403,
      body: { error: "hook_refused", message: expect.any(String) },
    });
    const stopFailing = await world(
      {},
      {
        hooks: {
          operator: {
            beforeAction: ({ audit }) => {
              if (audit.action === "impersonation_stop") throw new TypeError("broken hook");
            },
          },
        },
      },
    );
    const t2 = await started(stopFailing);
    expect(await answer(await stop(stopFailing, {}, sessionCookie(t2)))).toEqual({
      status: 500,
      body: { error: "hook_failed" },
    });
    const fresh = await world();
    const t3 = await started(fresh);
    expect(await answer(await stop(fresh, { reason: "a\nb" }, sessionCookie(t3)))).toEqual({
      status: 400,
      body: { error: "invalid_body" },
    });
    // The refused stop leaves the session.
    expect(await resolveSession(fresh.auth.config, t3)).not.toBeNull();
    errors.mockRestore();
  });
});
