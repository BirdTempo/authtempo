import { describe, expect, it } from "vitest";
import { type AuthConfig, resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { hasPendingEnd } from "../src/engine/operator/access-end.js";
import { writeClaimEnd } from "../src/engine/operator/pending-row.js";
import { createSession } from "../src/engine/sessions.js";
import { CLAIM_SESSION_CHUNKS } from "../src/engine/users.js";
import type { AuthEvent } from "../src/observe/port.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { SessionRow, UserRow } from "../src/schema.js";
import { IN_CHUNK } from "../src/storage/batch.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import {
  APP_ORIGIN,
  BASE_URL,
  LONG_TEST_MS,
  post,
  recordAddress,
  recordCredential,
  tokenFromMail,
} from "./helpers.js";
import { OPERATOR_SECRETS } from "./operator-helpers.js";
import { FAST } from "./password-helpers.js";

// Decision 3 of plan 12q, on the memory store. The memory store keeps an undo
// log, as D1 does, so it is not isolated. With an `afterEnd` hook a claim
// there ends at most two chunks of 50 sessions. It writes the pending-end row
// of a ban for the rest, with the reason `claimed`, and the sweep ends them
// with the hook. Only the claimant's sessions go: each was made before the
// proof, so its `proved` flag is false. The owner's session after the claim
// is proved, and the sweep keeps it. The D1 form with the query count is
// adapter-d1/test/claim-pending-end-d1.test.ts.

const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery";
const APP = { kind: "app", name: "support-tool" } as const;

/** One store, one clock, one mail list; the end hook and the events are recorded. */
async function world(options: { hook?: boolean; extra?: Partial<AuthConfig> } = {}) {
  let current = new Date("2026-11-05T00:00:00.000Z");
  const clock = {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
  const storage = createMemoryAdapter();
  const mail: { to: string; text: string }[] = [];
  const ends: { id: string; reason: string }[] = [];
  const events: AuthEvent[] = [];
  recordCredential(OPERATOR_SECRETS.support);
  const input: AuthConfig = {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage,
    clock,
    mail: { send: async (m) => void mail.push({ to: m.to, text: m.text }) },
    limiter: { allow: async () => true },
    password: { hash: FAST, uniformSignUp: false },
    observe: { sink: { write: (batch) => void events.push(...batch) } },
    operator: {
      secrets: [
        {
          name: "support",
          secretHash: await sha256Hex(OPERATOR_SECRETS.support),
          scopes: ["users", "sessions", "audit"],
        },
      ],
      users: true,
    },
    ...(options.hook === false
      ? {}
      : {
          hooks: {
            session: {
              afterEnd: ({ session, reason }) => void ends.push({ id: session.id, reason }),
            },
          },
        }),
    ...options.extra,
  };
  const auth = createAuth(input);
  return { auth, storage, clock, mail, ends, events };
}
type World = Awaited<ReturnType<typeof world>>;

/**
 * A claimant: the password sign-up of the owner's address, then more
 * sessions of that unverified user. Each has the flag that the engine sets
 * for it (false). Answers the user.
 */
async function claimant(w: World, sessions: number): Promise<UserRow> {
  recordAddress(EMAIL);
  recordCredential(PASSWORD);
  const up = await w.auth.handle(
    post("/auth/password/sign-up", { email: EMAIL, password: PASSWORD }),
  );
  expect(up.status).toBe(200);
  const user = await w.storage.findOne("user", [{ field: "email", op: "eq", value: EMAIL }]);
  if (!user || user.emailVerified) throw new Error("no unverified claimant");
  const config = resolveConfig({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: w.storage,
    mail: { send: async () => {} },
    clock: { now: () => w.clock.now() },
  });
  for (let i = 1; i < sessions; i++) {
    w.clock.advance(1);
    await createSession(config, { userId: user.id, ip: null, userAgent: null, proved: false });
  }
  return user;
}

/** The owner's magic link: the request, then the verify of the mailed token. */
async function ownerLink(w: World): Promise<Response> {
  w.clock.advance(1000);
  expect((await w.auth.handle(post("/auth/magic-link/request", { email: EMAIL }))).status).toBe(
    200,
  );
  const sent = w.mail.findLast((m) => m.to === EMAIL);
  return w.auth.handle(post("/auth/magic-link/verify", { token: tokenFromMail(sent?.text ?? "") }));
}

const sessionsOf = (w: World, userId: string): Promise<SessionRow[]> =>
  w.storage.findMany("session", [{ field: "userId", op: "eq", value: userId }], {
    sort: { field: "id", dir: "asc" },
  });

const pendingRows = (w: World, userId: string) =>
  w.storage.findMany(
    "verification",
    [
      { field: "purpose", op: "eq", value: "session-end" },
      { field: "identifier", op: "eq", value: userId },
    ],
    { sort: { field: "id", dir: "asc" } },
  );

/** The count of events so far, after a flush: the buffer holds the newest. */
async function markOf(w: World): Promise<number> {
  await w.auth.observe.flush();
  return w.events.length;
}

/** The session.end events since `from`, as reason and count. */
async function endEvents(w: World, from: number) {
  await w.auth.observe.flush();
  return w.events
    .slice(from)
    .filter((e) => e.name === "session.end")
    .map((e) => [e.reason, e.count]);
}

describe("the claim's bounded session delete on the memory store (decision 3 of plan 12q)", () => {
  it("ends two chunks, leaves the rest to the sweep with the reason claimed, and keeps the owner's session", {
    timeout: LONG_TEST_MS,
  }, async () => {
    expect(CLAIM_SESSION_CHUNKS * IN_CHUNK).toBe(100);
    const w = await world();
    const user = await claimant(w, 120);
    expect((await sessionsOf(w, user.id)).length).toBe(120);
    const mark = await markOf(w);
    const res = await ownerLink(w);
    expect(res.status).toBe(200);
    // The claim ended 100 claimant sessions with its own reason.
    expect(w.ends.length).toBe(100);
    expect(new Set(w.ends.map((e) => e.reason))).toEqual(new Set(["claim"]));
    expect(await endEvents(w, mark)).toEqual([["claim", 100]]);
    const after = await sessionsOf(w, user.id);
    const owner = after.filter((s) => s.proved);
    const left = after.filter((s) => !s.proved);
    expect(owner.length).toBe(1);
    expect(left.length).toBe(20);
    // The pending-end row of a ban, with the reason of a claim.
    const [row, ...more] = await pendingRows(w, user.id);
    expect(more).toEqual([]);
    expect(row?.data?.reason).toBe("claimed");
    expect(row?.data?.targets).toBeUndefined();
    expect(row?.data?.families).toBeUndefined();
    const before = Date.parse(String(row?.data?.before));
    for (const s of left) expect(s.createdAt.getTime()).toBeLessThanOrEqual(before);
    // The owner's session is inside `before` too: only its flag keeps it from the sweep.
    expect(owner[0]?.createdAt.getTime()).toBeLessThanOrEqual(before);
    // The sweep ends the rest with the hook and the reason `claimed`, and counts them.
    const swept = await markOf(w);
    w.clock.advance(1000);
    const result = await w.auth.api.sweepExpired();
    expect(result.pendingSessions).toBe(20);
    expect(w.ends.slice(100).map((e) => e.reason)).toEqual(Array(20).fill("claimed"));
    expect(new Set(w.ends.slice(100).map((e) => e.id))).toEqual(new Set(left.map((s) => s.id)));
    expect(await endEvents(w, swept)).toEqual([["claimed", 20]]);
    expect(await pendingRows(w, user.id)).toEqual([]);
    expect((await sessionsOf(w, user.id)).map((s) => s.id)).toEqual([owner[0]?.id]);
  });

  it("ends every session at once with no hook, and writes no row", {
    timeout: LONG_TEST_MS,
  }, async () => {
    const w = await world({ hook: false });
    const user = await claimant(w, 120);
    const mark = await markOf(w);
    expect((await ownerLink(w)).status).toBe(200);
    expect(await endEvents(w, mark)).toEqual([["claim", 120]]);
    const after = await sessionsOf(w, user.id);
    expect(after.map((s) => s.proved)).toEqual([true]);
    expect(await pendingRows(w, user.id)).toEqual([]);
  });

  it("writes no row when the sessions fit two chunks", { timeout: LONG_TEST_MS }, async () => {
    const w = await world();
    const user = await claimant(w, 100);
    expect((await ownerLink(w)).status).toBe(200);
    expect(w.ends.length).toBe(100);
    expect((await sessionsOf(w, user.id)).map((s) => s.proved)).toEqual([true]);
    expect(await pendingRows(w, user.id)).toEqual([]);
  });

  it("ends each session once when a ban's row waits too, and both rows go", {
    timeout: LONG_TEST_MS,
  }, async () => {
    const w = await world();
    const user = await claimant(w, 160);
    // A ban of an hour ends a page in its call and leaves a pending row for the rest.
    const banned = await w.auth.api.operator.users.ban({
      actor: APP,
      userId: user.id,
      reason: "Abuse report 7",
      until: new Date(w.clock.now().getTime() + 3_600_000).toISOString(),
      ip: null,
      userAgent: null,
    });
    expect(banned.ok).toBe(true);
    const byBan = w.ends.length;
    expect(byBan).toBeGreaterThan(0);
    expect((await sessionsOf(w, user.id)).length).toBeGreaterThan(100);
    expect((await pendingRows(w, user.id)).map((r) => r.data?.reason)).toEqual(["banned"]);
    // The ban ends; the owner proves the address before any sweep.
    w.clock.advance(2 * 3_600_000);
    expect((await ownerLink(w)).status).toBe(200);
    expect((await pendingRows(w, user.id)).map((r) => r.data?.reason)).toEqual([
      "banned",
      "claimed",
    ]);
    for (let i = 0; i < 5 && (await pendingRows(w, user.id)).length > 0; i++) {
      w.clock.advance(1000);
      await w.auth.api.sweepExpired();
    }
    expect(await pendingRows(w, user.id)).toEqual([]);
    // 160 claimant sessions ended, each once; the owner's session stays.
    const ids = w.ends.map((e) => e.id);
    expect(ids.length).toBe(160);
    expect(new Set(ids).size).toBe(160);
    expect((await sessionsOf(w, user.id)).map((s) => s.proved)).toEqual([true]);
  });

  it("does not count a claim's row as a revoke's row", async () => {
    const w = await world();
    const user = await claimant(w, 1);
    await w.storage.transaction((tx) =>
      writeClaimEnd(tx, w.clock, user.id, Number.NEGATIVE_INFINITY),
    );
    expect(await hasPendingEnd(w.storage, user.id)).toBe(false);
  });
});
