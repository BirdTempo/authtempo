import { describe, expect, it } from "vitest";
import { deleteAccount } from "../src/engine/account-delete.js";
import { resolveSession } from "../src/engine/sessions.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { makeAuth } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { EMAIL, verifiedSession } from "./totp-helpers.js";

// The page of the own sessions of the self delete (ruling 1 of plan 12f2,
// item B1 and Q4). The delete ends a page of the sessions inside the call
// budget of 50 storage calls. The rest stay with one pending-end row of
// the reason account_deleted, and the sweep ends them. The doors refuse
// them before that, because the user row is gone.

/**
 * The calls that the engine call of the self delete may make: 50 less the
 * 6 calls of the route before it (`DELETE_CALLS_BEFORE`) and the ready
 * check of memory (1).
 */
const ENGINE_CALLS = 43;

function world() {
  const ended: { id: string; reason: string }[] = [];
  const auth = makeAuth({
    password: { hash: FAST, uniformSignUp: false },
    // Every sign-in passes: the page, not the limit of the sign-in, is under test.
    limiter: { allow: async () => true },
    hooks: {
      session: { afterEnd: ({ session, reason }) => void ended.push({ id: session.id, reason }) },
    },
  });
  return { auth, ended };
}

describe("the page of the own sessions of the self delete (ruling 1 of plan 12f2)", () => {
  it("ends the sessions past the page at the sweep, and the doors refuse them first", async () => {
    const { auth, ended } = world();
    const tokens: string[] = [];
    for (let i = 0; i < 40; i++) tokens.push((await verifiedSession(auth, EMAIL)).token);
    const me = await resolveSession(auth.config, tokens.at(-1) ?? "");
    if (!me) throw new Error("no session");
    const sessionsOf = () =>
      auth.storage.findMany("session", [{ field: "userId", op: "eq", value: me.user.id }]);
    // The sign-up link opened one more session.
    expect((await sessionsOf()).length).toBe(41);
    // The page of the own sessions keeps to the budget only on a store with a
    // per-invocation query limit (D1). This memory store claims one.
    auth.storage.queryLimitPerInvocation = true;
    ended.length = 0;
    const sent = auth.storage.statementsSent?.() ?? 0;
    expect(await deleteAccount(auth.config, { session: me, ip: null, userAgent: null })).toEqual({
      ok: true,
      value: { ok: true },
    });
    // The whole call, the steps after the commit too, fits the budget with a hook.
    expect((auth.storage.statementsSent?.() ?? 0) - sent).toBeLessThanOrEqual(ENGINE_CALLS);
    const inCall = ended.length;
    expect(inCall).toBeGreaterThan(0);
    expect(inCall).toBeLessThan(41);
    const pending = await auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "session-end" },
      { field: "identifier", op: "eq", value: me.user.id },
    ]);
    expect(pending.map((p) => p.data?.reason)).toEqual(["account_deleted"]);
    for (const token of tokens) expect(await resolveSession(auth.config, token)).toBeNull();
    for (let i = 0; i < 20 && (await sessionsOf()).length > 0; i++) await sweepExpired(auth.config);
    expect(await sessionsOf()).toEqual([]);
    expect(ended.length).toBe(41);
    expect(new Set(ended.map((e) => e.id)).size).toBe(41);
    expect(new Set(ended.map((e) => e.reason))).toEqual(new Set(["account_deleted"]));
    // The sweep deleted the pending-end row when its work was done.
    expect(
      await auth.storage.findMany("verification", [
        { field: "identifier", op: "eq", value: me.user.id },
      ]),
    ).toEqual([]);
  });

  it("ends every session in the call when they fit, and writes no pending-end row", async () => {
    const { auth, ended } = world();
    const me = await verifiedSession(auth, EMAIL);
    const ids = (
      await auth.storage.findMany("session", [{ field: "userId", op: "eq", value: me.user.id }])
    ).map((s) => s.id);
    ended.length = 0;
    expect((await deleteAccount(auth.config, { session: me, ip: null, userAgent: null })).ok).toBe(
      true,
    );
    expect(ended.map((e) => e.id).sort()).toEqual([...ids].sort());
    expect(
      await auth.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "session-end" },
      ]),
    ).toEqual([]);
  });
});
