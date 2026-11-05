import { describe, expect, it } from "vitest";
import { type AuthConfig, ConfigError } from "../src/config.js";
import { requestEmailOtp, verifyEmailOtp } from "../src/engine/email-otp.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { startImpersonation } from "../src/engine/operator/impersonation.js";
import { passwordSignIn, passwordSignUp } from "../src/engine/password.js";
import type { AuthEvent } from "../src/observe/port.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { SessionRow } from "../src/schema.js";
import { makeAuth, recordAddress, recordCredential, tokenFromMail } from "./helpers.js";
import { OPERATOR_SECRETS, operatorFixture } from "./operator-helpers.js";
import { FAST, sessionOnly } from "./password-helpers.js";
import { verifiedSession } from "./totp-helpers.js";

// Decision 4 of plan 12q: `session.maxPerUser` bounds the live sessions of
// one user. A session create ends the oldest sessions past the cap before
// its insert, with the reason `capped`. The end fires after the commit,
// before the sign_in event of the new session. The D1 form with the query
// count is adapter-d1/test/session-cap-d1.test.ts, and the race of two
// sign-ins on Postgres is adapter-postgres/test/session-cap.test.ts.

const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery";
const DAY_MS = 86_400_000;

/** The engine view with a cap, the end hook and the events recorded. */
function world(maxPerUser: number, options: { hook?: boolean; extra?: Partial<AuthConfig> } = {}) {
  const ends: { id: string; reason: string }[] = [];
  const events: AuthEvent[] = [];
  const auth = makeAuth({
    password: { hash: FAST, uniformSignUp: false },
    emailOtp: {},
    session: { maxPerUser },
    observe: { sink: { write: (batch) => void events.push(...batch) } },
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
  });
  return { ...auth, ends, events };
}
type World = ReturnType<typeof world>;

/** The password sign-up of the user: an unverified user with its first session. */
async function signUp(w: World): Promise<SessionRow> {
  recordAddress(EMAIL);
  recordCredential(PASSWORD);
  const up = await passwordSignUp(w.config, {
    email: EMAIL,
    password: PASSWORD,
    ip: null,
    userAgent: null,
  });
  if (!up.ok || !("session" in up.value)) throw new Error("the sign-up opened no session");
  return up.value.session;
}

/** One password sign-in, 1 ms after the last write, so the ids sort by it. */
async function signIn(w: World): Promise<SessionRow> {
  w.clock.advance(1);
  const s = await sessionOnly(
    passwordSignIn(w.config, { email: EMAIL, password: PASSWORD, ip: null, userAgent: null }),
  );
  if (!s.ok) throw new Error(s.code);
  return s.value.session;
}

const sessionsOf = async (w: World, userId: string) =>
  (
    await w.storage.findMany("session", [{ field: "userId", op: "eq", value: userId }], {
      sort: { field: "id", dir: "asc" },
    })
  ).map((s) => s.id);

/** The count of events so far, after a flush: the buffer holds the newest. */
async function markOf(w: World): Promise<number> {
  await w.config.observe.flush();
  return w.events.length;
}

/** The events since `from` that the cap and the sign-in emit, in order. */
async function capEvents(w: World, from: number) {
  await w.config.observe.flush();
  return w.events
    .slice(from)
    .filter((e) => e.name === "session.end" || e.name === "sign_in")
    .map((e) => (e.name === "session.end" ? [e.name, e.reason, e.count] : [e.name]));
}

describe("session.maxPerUser (decision 4 of plan 12q)", () => {
  it("is 100 by default and refuses a value outside 1 to 1000", () => {
    expect(makeAuth().config.session.maxPerUser).toBe(100);
    expect(makeAuth({ session: { maxPerUser: 1 } }).config.session.maxPerUser).toBe(1);
    expect(makeAuth({ session: { maxPerUser: 1000 } }).config.session.maxPerUser).toBe(1000);
    // A string is what a JavaScript caller can pass, so this value leaves the type on purpose.
    for (const maxPerUser of [0, 1001, 2.5, "3" as unknown as number])
      expect(() => makeAuth({ session: { maxPerUser } })).toThrow(
        new ConfigError("session.maxPerUser must be an integer from 1 to 1000"),
      );
  });

  it("ends the oldest session past the cap with the reason capped, before the sign_in event", async () => {
    const w = world(3);
    const first = await signUp(w);
    const second = await signIn(w);
    const third = await signIn(w);
    expect(w.ends).toEqual([]);
    const mark = await markOf(w);
    const fourth = await signIn(w);
    expect(w.ends).toEqual([{ id: first.id, reason: "capped" }]);
    expect(await sessionsOf(w, first.userId)).toEqual([second.id, third.id, fourth.id]);
    expect(await capEvents(w, mark)).toEqual([["session.end", "capped", 1], ["sign_in"]]);
    // The next sign-in ends the next oldest.
    const fifth = await signIn(w);
    expect(w.ends.map((e) => e.id)).toEqual([first.id, second.id]);
    expect(await sessionsOf(w, first.userId)).toEqual([third.id, fourth.id, fifth.id]);
  });

  it("counts the ended sessions in session.end with no hook", async () => {
    const w = world(2, { hook: false });
    const first = await signUp(w);
    const second = await signIn(w);
    const mark = await markOf(w);
    const third = await signIn(w);
    expect(await sessionsOf(w, first.userId)).toEqual([second.id, third.id]);
    expect(await capEvents(w, mark)).toEqual([["session.end", "capped", 1], ["sign_in"]]);
  });

  it("ends every session past a cap that a deploy lowered, in one act", async () => {
    const w = world(5);
    const made = [await signUp(w)];
    for (let i = 0; i < 4; i++) made.push(await signIn(w));
    // The same store under a cap of 2: the next sign-in leaves the newest one and itself.
    const lower = makeAuth({
      storage: w.storage,
      clock: w.clock,
      password: { hash: FAST, uniformSignUp: false },
      session: { maxPerUser: 2 },
      hooks: {
        session: {
          afterEnd: ({ session, reason }) => void w.ends.push({ id: session.id, reason }),
        },
      },
    });
    w.clock.advance(1);
    const s = await sessionOnly(
      passwordSignIn(lower.config, { email: EMAIL, password: PASSWORD, ip: null, userAgent: null }),
    );
    if (!s.ok) throw new Error(s.code);
    expect(w.ends.map((e) => [e.id, e.reason])).toEqual(
      made.slice(0, 4).map((m) => [m.id, "capped"]),
    );
    expect(await sessionsOf(w, s.value.session.userId)).toEqual([made[4]?.id, s.value.session.id]);
  });

  it("counts only live sessions: an expired one neither counts nor ends", async () => {
    const w = world(2);
    const first = await signUp(w);
    // Past the 30 days of `ttlDays`: the first session is not live.
    w.clock.advance(31 * DAY_MS);
    const second = await signIn(w);
    const third = await signIn(w);
    expect(w.ends).toEqual([]);
    expect(await sessionsOf(w, first.userId)).toEqual([first.id, second.id, third.id]);
    const fourth = await signIn(w);
    expect(w.ends).toEqual([{ id: second.id, reason: "capped" }]);
    expect(await sessionsOf(w, first.userId)).toEqual([first.id, third.id, fourth.id]);
  });

  it("ends a session past the cap from the magic link and from the email code too", async () => {
    const w = world(1);
    const first = await signUp(w);
    w.clock.advance(1);
    expect((await requestMagicLink(w.config, { email: EMAIL, ip: null })).ok).toBe(true);
    const sent = w.mail.findLast((m) => m.to === EMAIL);
    const link = await verifyMagicLink(w.config, {
      token: tokenFromMail(sent?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    expect(link.ok).toBe(true);
    // The magic link claims the unverified user, so the claim ends the sign-up's session first.
    expect(w.ends).toEqual([{ id: first.id, reason: "claim" }]);
    const [byLink] = await sessionsOf(w, first.userId);
    w.clock.advance(1);
    expect((await requestEmailOtp(w.config, { email: EMAIL, ip: null })).ok).toBe(true);
    const text = w.mail.findLast((m) => m.to === EMAIL)?.text ?? "";
    const code = /\b(\d{6})\b/.exec(text)?.[1] ?? "";
    const otp = await verifyEmailOtp(w.config, { email: EMAIL, code, ip: null, userAgent: null });
    expect(otp.ok).toBe(true);
    expect(w.ends.at(-1)).toEqual({ id: byLink, reason: "capped" });
    expect((await sessionsOf(w, first.userId)).length).toBe(1);
  });
});

describe("the cap and an impersonation session (decision 4 of plan 12q)", () => {
  it("neither counts nor ends an impersonation session", async () => {
    const ends: { id: string; reason: string }[] = [];
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
        session: { maxPerUser: 2 },
        hooks: {
          session: {
            afterEnd: ({ session, reason }) => void ends.push({ id: session.id, reason }),
          },
        },
      },
    });
    const target = await verifiedSession(f.auth, EMAIL);
    const byTarget = () =>
      f.auth.storage.findMany("session", [{ field: "userId", op: "eq", value: target.user.id }], {
        sort: { field: "id", dir: "asc" },
      });
    const own = await byTarget();
    // The confirm's session and the sign-in: the cap of 2.
    expect(own.length).toBe(2);
    const before = ends.length;
    f.auth.clock.advance(1);
    const r = await startImpersonation(f.auth.config, {
      operator: f.operator,
      userId: target.user.id,
      reason: "Ticket 4711: the user cannot see the invoices",
      ip: null,
      userAgent: null,
    });
    if (!r.ok) throw new Error(r.code);
    // The impersonation ended no session of the target.
    expect(ends.slice(before)).toEqual([]);
    const all = await byTarget();
    expect(all.length).toBe(3);
    const acting = all.find((s) => s.actorId !== null);
    expect(acting).toBeDefined();
    // The target's next sign-in ends its oldest own session, and the impersonation stays.
    f.auth.clock.advance(1);
    const next = await verifiedSession(f.auth, EMAIL);
    expect(ends.slice(before)).toEqual([{ id: own[0]?.id, reason: "capped" }]);
    expect((await byTarget()).map((s) => s.id).sort()).toEqual(
      [own[1]?.id, acting?.id, next.session.id].map(String).sort(),
    );
  });
});
