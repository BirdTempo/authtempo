import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEndReason } from "../src/engine/hooks.js";
import { mintSessionJwt, sessionLive } from "../src/engine/jwt.js";
import { resolveSession } from "../src/engine/sessions.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { APP_ORIGIN, BASE_URL, LONG_TEST_MS } from "./helpers.js";
import { OPERATOR_SECRETS, type OperatorAuth, operatorFixture } from "./operator-helpers.js";
import { verifiedSession } from "./totp-helpers.js";

// The ban and the revoke of the platform role inside the call budget
// (rulings 44 and 45 of plan 12f). The memory adapter counts its port
// calls in statementsSent; the D1 test of adapter-d1 counts the binding.

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const REASON = "Support case 4711";
const SECRET = { authorization: `Operator ${OPERATOR_SECRETS.support}` };
/** The memory adapter has no readyStatements, so the budget takes 1 for the ready check, as core D1 sends. */
const READY = 1;

/** The fixture of plan 12f with a counting limiter and a `session.afterEnd` hook that records each end. */
async function world() {
  const limited = { calls: 0 };
  const endings: { id: string; reason: SessionEndReason }[] = [];
  const fx = await operatorFixture({
    config: {
      limiter: {
        allow: async () => {
          limited.calls++;
          return true;
        },
      },
      hooks: {
        session: {
          afterEnd: ({ session, reason }) => {
            endings.push({ id: session.id, reason });
          },
        },
      },
    },
  });
  const auth = fx.auth as OperatorAuth;
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  const cookieOf = (token: string) => ({ cookie: `${auth.config.cookieName}=${token}` });
  return { auth, handle, limited, endings, operator: fx.operator, root: fx.root, cookieOf };
}

type World = Awaited<ReturnType<typeof world>>;

/** `count` password sign-ins of one address: the user id and the token of each session. */
async function signIns(w: World, email: string, count: number) {
  const tokens: string[] = [];
  let userId = "";
  for (let i = 0; i < count; i++) {
    const s = await verifiedSession(w.auth, email);
    userId = s.user.id;
    tokens.push(s.token);
  }
  return { userId, tokens };
}

function post(path: string, body: unknown, headers: Record<string, string>): Request {
  return new Request(`${BASE_URL}/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers },
    body: JSON.stringify(body),
  });
}

/** One whole route call: its answer, and its calls (the limiter, the storage, and the ready check). */
async function counted(w: World, request: Request) {
  const sent = () => w.auth.storage.statementsSent?.() ?? 0;
  const start = sent();
  w.limited.calls = 0;
  const res = await w.handle(request);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body, calls: sent() - start + w.limited.calls + READY };
}

const sessionsOf = async (w: World, userId: string) =>
  (await w.auth.storage.findMany("session", [{ field: "userId", op: "eq", value: userId }])).length;

const pendingRows = async (w: World) =>
  w.auth.storage.findMany("verification", [{ field: "purpose", op: "eq", value: "session-end" }]);

/** The token of a session that stays after the act, and its row. */
async function leftSession(w: World, userId: string, tokens: string[]) {
  const rows = await w.auth.storage.findMany("session", [
    { field: "userId", op: "eq", value: userId },
  ]);
  for (const token of tokens) {
    const hash = await sha256Hex(token);
    const row = rows.find((r) => r.tokenHash === hash);
    if (row) return { token, row };
  }
  throw new Error("no left session");
}

/** Sweeps until no pending-end row stays: the count of sweeps and of the sessions they ended. */
async function sweepAll(w: World) {
  let sweeps = 0;
  let ended = 0;
  while ((await pendingRows(w)).length > 0) {
    if (++sweeps > 20) throw new Error("the sweep makes no progress");
    ended += (await sweepExpired(w.auth.config)).pendingSessions;
  }
  return { sweeps, ended };
}

/** The platform operator's own headers on a POST: the session cookie and the trusted Origin. */
const asOperator = (w: World) => ({ ...w.cookieOf(w.operator.token), origin: APP_ORIGIN });

describe("the ban and the revoke inside the call budget (rulings 44 and 45 of plan 12f)", () => {
  // Each case signs in 60 times. Its lowest time in the logs is 0.30 s, and its highest pass
  // is 1.20 s (2026-10-31). The user case timed out at the default 5 s once, at 5.03 s, in a
  // core run beside another lane at load 39.7 (2026-10-31). One limit covers both cases.
  for (const actor of ["secret", "user"] as const)
    it(`bans a user with 60 sessions and a hook in 50 calls or fewer, and the sweep ends the rest (${actor})`, {
      timeout: LONG_TEST_MS,
    }, async () => {
      const w = await world();
      const ada = await signIns(w, "ada@example.com", 60);
      // The sign-up opened one more session.
      const total = await sessionsOf(w, ada.userId);
      expect(total).toBe(61);
      w.endings.length = 0;
      const headers = actor === "secret" ? SECRET : asOperator(w);
      const r = await counted(
        w,
        post("/operator/users/ban", { userId: ada.userId, reason: REASON }, headers),
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toEqual({ auditId: expect.any(String) });
      expect(r.calls).toBeLessThanOrEqual(50);
      // The act ended a page; the rest stays with one pending-end row.
      const inAct = w.endings.length;
      expect(inAct).toBeGreaterThan(0);
      expect(await sessionsOf(w, ada.userId)).toBe(total - inAct);
      const pending = await pendingRows(w);
      expect(pending.map((p) => [p.identifier, p.data?.reason])).toEqual([[ada.userId, "banned"]]);
      // The row lives 3650 days from the fixture clock (2026-01-01), far past any session.
      expect(pending[0]?.expiresAt.toISOString().slice(0, 10)).toBe("2035-12-30");
      const audit = await w.auth.storage.findMany("operatorAudit", []);
      expect(audit.map((a) => [a.action, a.targetUserId])).toEqual([["ban", ada.userId]]);
      // The sweep ends every left session with its hook, and deletes the row.
      const swept = await sweepAll(w);
      expect(swept.ended).toBe(total - inAct);
      expect(await sessionsOf(w, ada.userId)).toBe(0);
      expect(await pendingRows(w)).toEqual([]);
      expect(w.endings).toHaveLength(total);
      expect(new Set(w.endings.map((e) => e.id)).size).toBe(total);
      expect(new Set(w.endings.map((e) => e.reason))).toEqual(new Set(["banned"]));
    });

  it("answers no door for a session that the ban left for the sweep", async () => {
    const w = await world();
    const ada = await signIns(w, "ada@example.com", 60);
    const r = await counted(
      w,
      post("/operator/users/ban", { userId: ada.userId, reason: REASON }, SECRET),
    );
    expect(r.status).toBe(200);
    // A session row that the act left for the sweep, and its token.
    const { token, row } = await leftSession(w, ada.userId, ada.tokens);
    const config = w.auth.config;
    expect(await sessionLive(config, { sid: row.id })).toBe(false);
    expect(await mintSessionJwt(config, { userId: ada.userId, sessionId: row.id })).toEqual({
      ok: false,
      code: "unauthorized",
      status: 401,
    });
    expect(await resolveSession(config, token, "read-only")).toBeNull();
    const refresh = await w.handle(
      post("/session/refresh", {}, { ...w.cookieOf(token), origin: APP_ORIGIN }),
    );
    expect(refresh.status).toBe(401);
    const page = await w.handle(
      new Request(`${BASE_URL}/auth/session`, { headers: w.cookieOf(token) }),
    );
    expect(page.status).toBe(401);
  });

  for (const actor of ["secret", "user"] as const)
    it(`revokes the platform role of an operator with 60 sessions in 50 calls or fewer, and a retry by a ${actor} actor and the sweep end the rest`, async () => {
      const w = await world();
      const bob = await signIns(w, "bob@example.com", 60);
      const total = await sessionsOf(w, bob.userId);
      // The secret grants the role through the route.
      const granted = await w.handle(
        post(
          "/operator/users/platform-role",
          { userId: bob.userId, grant: true, reason: REASON },
          SECRET,
        ),
      );
      expect(granted.status).toBe(200);
      w.endings.length = 0;
      // A user actor never revokes another platform operator (operator_required), so the
      // secret revokes first. With the role gone, a user actor may retry (ruling 45).
      const revoke = (headers: Record<string, string>) =>
        counted(
          w,
          post(
            "/operator/users/platform-role",
            { userId: bob.userId, grant: false, reason: REASON },
            headers,
          ),
        );
      const first = await revoke(SECRET);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.calls).toBeLessThanOrEqual(50);
      const inAct = w.endings.length;
      expect(inAct).toBeGreaterThan(0);
      expect(await sessionsOf(w, bob.userId)).toBe(total - inAct);
      expect((await pendingRows(w)).map((p) => p.data?.reason)).toEqual(["operator"]);
      // A left session holds no operator power: each operator check reads the role again.
      const { token } = await leftSession(w, bob.userId, bob.tokens);
      const asBob = await w.handle(
        new Request(`${BASE_URL}/auth/operator/users`, { headers: w.cookieOf(token) }),
      );
      expect(asBob.status).toBe(403);
      // A retry with the role gone still ends a page (ruling 45), in 50 calls or fewer.
      const second = await revoke(actor === "secret" ? SECRET : asOperator(w));
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(second.calls).toBeLessThanOrEqual(50);
      expect(w.endings.length).toBeGreaterThan(inAct);
      // The sweep ends the rest with the reason operator.
      await sweepAll(w);
      expect(await sessionsOf(w, bob.userId)).toBe(0);
      expect(w.endings).toHaveLength(total);
      expect(new Set(w.endings.map((e) => e.reason))).toEqual(new Set(["operator"]));
      const audit = await w.auth.storage.findMany("operatorAudit", []);
      expect(audit.map((a) => a.action)).toEqual([
        "platform_role_grant",
        "platform_role_revoke",
        "platform_role_revoke",
      ]);
    });

  it("ends no session of a sign-in after the act", async () => {
    const w = await world();
    const bob = await signIns(w, "bob@example.com", 60);
    await w.handle(
      post(
        "/operator/users/platform-role",
        { userId: bob.userId, grant: true, reason: REASON },
        SECRET,
      ),
    );
    const revoked = await w.handle(
      post(
        "/operator/users/platform-role",
        { userId: bob.userId, grant: false, reason: REASON },
        SECRET,
      ),
    );
    expect(revoked.status).toBe(200);
    const left = await sessionsOf(w, bob.userId);
    expect(left).toBeGreaterThan(0);
    // A sign-in one minute after the revoke is a session of a plain user.
    w.auth.clock.advance(60_000);
    const after = await verifiedSession(w.auth, "bob@example.com");
    await sweepAll(w);
    // The step ends the left rows only; the new sign-in stays.
    const rows = await w.auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: bob.userId },
    ]);
    expect(rows.map((s) => s.id)).toEqual([after.session.id]);
  });
});

describe("the call budget option of the sweep (ruling 41 item 1 of plan 12f)", () => {
  /** A ban of a user with 150 sessions and a hook: the act leaves rows for the sweep. */
  async function banned() {
    const w = await world();
    const ada = await signIns(w, "ada@example.com", 150);
    const r = await counted(
      w,
      post("/operator/users/ban", { userId: ada.userId, reason: REASON }, SECRET),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const left = await sessionsOf(w, ada.userId);
    expect(left).toBeGreaterThan(100);
    return { w, userId: ada.userId, left };
  }

  /** One sweep: its answer and its storage calls. */
  async function sweepOnce(w: World, options?: { callBudget?: number }) {
    const sent = () => w.auth.storage.statementsSent?.() ?? 0;
    const start = sent();
    const result = await sweepExpired(w.auth.config, options);
    return { result, calls: sent() - start };
  }

  it("keeps 50 calls by default, and ends every left session in one sweep of a larger budget", async () => {
    const small = await banned();
    const byDefault = await sweepOnce(small.w);
    expect(byDefault.calls).toBeLessThanOrEqual(50);
    expect(byDefault.result.pendingSessions).toBeLessThan(small.left);
    const large = await banned();
    const wide = await sweepOnce(large.w, { callBudget: 200 });
    expect(wide.calls).toBeGreaterThan(50);
    expect(wide.calls).toBeLessThanOrEqual(200);
    expect(wide.result.pendingSessions).toBe(large.left);
    expect(await sessionsOf(large.w, large.userId)).toBe(0);
    expect(await pendingRows(large.w)).toEqual([]);
  });

  it("takes 50 and 1000, and refuses another value before any call", async () => {
    const w = await world();
    for (const callBudget of [50, 1000])
      expect((await sweepOnce(w, { callBudget })).calls).toBeLessThanOrEqual(callBudget);
    for (const callBudget of [49, 1001, 50.5, Number.NaN, 0, -50]) {
      const start = w.auth.storage.statementsSent?.() ?? 0;
      await expect(sweepExpired(w.auth.config, { callBudget })).rejects.toThrow(
        new RangeError("authtempo: sweepExpired callBudget must be an integer from 50 to 1000"),
      );
      expect(w.auth.storage.statementsSent?.() ?? 0).toBe(start);
    }
  });
});
