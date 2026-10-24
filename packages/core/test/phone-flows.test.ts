import { describe, expect, it, vi } from "vitest";
import type { AuthConfig, PhoneConfig } from "../src/config.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import type { UserRow } from "../src/schema.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { APP_ORIGIN, makeAuth, post } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { enrolled } from "./totp-helpers.js";

// The phone flows (plan 12i Task 5, spec 32 item 5). Every phone user here
// comes from a real code: a sign-up by `/phone/verify`, or an add by
// `/phone/add/verify`. No test writes a phone by `storage.create`.

const A = "+14155550100";
const B = "+14155550101";
const RP = { rpID: "example.com", rpName: "Example", origins: [APP_ORIGIN] };

/** Core with `phone` on the memory limiter (deviation 5 of plan 12i), and the router. */
function world(phone: Partial<PhoneConfig> = {}, extra: Partial<AuthConfig> = {}) {
  const sms = createRecordingSms();
  const auth = makeAuth({
    phone: { sms, regions: ["+1"], isolateLimiter: "allow", ...phone },
    ...extra,
  });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  // A new client IP for each call that needs none in particular, so the per-IP keys never decide.
  let n = 0;
  const ip = () => `198.51.100.${++n}`;
  return { ...auth, sms, handle, ip };
}
type World = ReturnType<typeof world>;

/** The code of the last text to `to`: the default message starts with it. */
function codeTo(w: World, to: string): string {
  const text = w.sms.sent.findLast((s) => s.to === to)?.text ?? "";
  const code = /^(\d+) is your /.exec(text)?.[1];
  if (code === undefined) throw new Error(`no code in the text: ${text}`);
  return code;
}

/** A code of the same length that is not `code`. */
function wrong(code: string): string {
  return code.replace(/^./, (d) => String((Number(d) + 1) % 10));
}

async function call(w: World, request: Request) {
  const res = await w.handle(request);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, res };
}

const request = (w: World, phone: string, ip = w.ip()) =>
  call(w, post("/auth/phone/request", { phone }, { "cf-connecting-ip": ip }));
const verify = (w: World, phone: string, code: string, ip = w.ip()) =>
  call(w, post("/auth/phone/verify", { phone, code }, { "cf-connecting-ip": ip }));

/** A verified user with an address and the cookie of a fresh session. */
async function addressUser(w: World, email: string) {
  const user = await w.seedUser(email);
  const { token } = await createSession(w.config, { userId: user.id, ip: null, userAgent: null });
  return { user, cookie: `${w.config.cookieName}=${token}` };
}

const add = (w: World, cookie: string, phone: string, ip = w.ip()) =>
  call(w, post("/auth/phone/add", { phone }, { cookie, "cf-connecting-ip": ip }));
const addVerify = (w: World, cookie: string, code: string) =>
  call(w, post("/auth/phone/add/verify", { code }, { cookie, "cf-connecting-ip": w.ip() }));

/** A user with an address whose phone `/phone/add/verify` set. */
async function withPhone(w: World, email: string, phone: string) {
  const me = await addressUser(w, email);
  expect((await add(w, me.cookie, phone)).body).toEqual({ sent: true });
  const set = await addVerify(w, me.cookie, codeTo(w, phone));
  expect(set.body).toEqual({ phone });
  return me;
}

/** A user with no address whose sign-up by `/phone/verify` made it, and its session cookie. */
async function phoneSignUp(w: World, phone: string) {
  expect((await request(w, phone)).body).toEqual({ sent: true });
  const r = await verify(w, phone, codeTo(w, phone));
  expect(r.status).toBe(200);
  const body = r.body as { token: string; user: { id: string } };
  return { userId: body.user.id, cookie: `${w.config.cookieName}=${body.token}` };
}

function userOf(w: World, id: string): Promise<UserRow | null> {
  return w.storage.findOne("user", [{ field: "id", op: "eq", value: id }]);
}

describe("the phone flows (plan 12i Task 5, spec 32 item 5)", () => {
  it("answers the same for a known and an unknown number", async () => {
    const w = world({ signUp: false });
    await withPhone(w, "ada@example.com", A);
    const sentBefore = w.sms.sent.length;
    const known = await request(w, A);
    const unknown = await request(w, B);
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(known.body).toEqual({ sent: true });
    expect([...unknown.res.headers.keys()]).toEqual([...known.res.headers.keys()]);
    // Only the known number gets an SMS.
    expect(w.sms.sent.slice(sentBefore).map((s) => s.to)).toEqual([A]);
    // The per-number limits come before the read: the 429 of the fourth request is the same too.
    for (let i = 0; i < 2; i++) {
      await request(w, A);
      await request(w, B);
    }
    const knownLimited = await request(w, A);
    const unknownLimited = await request(w, B);
    expect(knownLimited.status).toBe(429);
    expect(unknownLimited.status).toBe(429);
    expect(unknownLimited.body).toEqual(knownLimited.body);
  });

  it("signs in with a right code and opens a session with via phone", async () => {
    // The session row holds no `via`: the session hook reads it (plan 9d).
    const afterCreate = vi.fn();
    const w = world({}, { hooks: { session: { afterCreate } } });
    const me = await withPhone(w, "ada@example.com", A);
    await request(w, A);
    const r = await verify(w, A, codeTo(w, A));
    expect(r.status).toBe(200);
    const body = r.body as { token: string; user: { id: string }; session: { id: string } };
    expect(Object.keys(body).sort()).toEqual(["session", "token", "user"]);
    expect(body.user.id).toBe(me.user.id);
    expect(r.res.headers.getSetCookie().some((c) => c.startsWith(`${w.config.cookieName}=`))).toBe(
      true,
    );
    expect(afterCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        via: "phone",
        session: expect.objectContaining({ id: body.session.id }),
      }),
    );
  });

  it("creates a user on a right code with signUp", async () => {
    const w = world({ signUp: true });
    const { userId } = await phoneSignUp(w, A);
    expect(await userOf(w, userId)).toMatchObject({
      email: null,
      emailVerified: false,
      phone: A,
      isAnonymous: false,
    });
    // Under `signUp: "invited"` (plan 12b) a null address has no invitation:
    // `mayCreateUser(null)` refuses the create at the verify.
    const invited = world({ signUp: true }, { signUp: "invited", organizations: {} });
    expect((await request(invited, A)).body).toEqual({ sent: true });
    const closed = await verify(invited, A, codeTo(invited, A));
    expect(closed.status).toBe(403);
    expect(closed.body).toEqual({ error: "sign_up_closed" });
    expect(await invited.storage.findMany("user", [])).toEqual([]);
  });

  it("answers invalid_code for wrong, expired, spent, and unknown codes alike", async () => {
    const w = world({ signUp: true });
    await request(w, A);
    const code = codeTo(w, A);
    const wrongCode = await verify(w, A, wrong(code));
    expect((await verify(w, A, code)).status).toBe(200);
    const spent = await verify(w, A, code);
    await request(w, B);
    const late = codeTo(w, B);
    w.clock.advance(5 * 60_000);
    const expired = await verify(w, B, late);
    // A number that never got a code.
    const unknown = await verify(w, "+14155550199", "123456");
    for (const r of [wrongCode, spent, expired, unknown]) {
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "invalid_code" });
    }
  });

  it("gates a phone sign-in", async () => {
    const extra = { password: { hash: FAST, uniformSignUp: false }, passkey: RP };
    const w = world({}, extra);
    const { user } = await enrolled(w);
    const { token } = await createSession(w.config, { userId: user.id, ip: null, userAgent: null });
    const cookie = `${w.config.cookieName}=${token}`;
    await add(w, cookie, A);
    expect((await addVerify(w, cookie, codeTo(w, A))).body).toEqual({ phone: A });
    await request(w, A);
    const gated = await verify(w, A, codeTo(w, A));
    expect(gated.status).toBe(200);
    // The code proves the phone, not the mailbox: no email method (12c decision 4).
    expect(gated.body).toMatchObject({ twoFactor: { methods: ["totp", "backup"] } });
    expect(gated.res.headers.getSetCookie()).toEqual([]);
    // `totp.gate.phone: false` opens a session.
    const open = world({}, { ...extra, totp: { gate: { phone: false } } });
    const other = await enrolled(open);
    const t = await createSession(open.config, {
      userId: other.user.id,
      ip: null,
      userAgent: null,
    });
    const c = `${open.config.cookieName}=${t.token}`;
    await add(open, c, A);
    await addVerify(open, c, codeTo(open, A));
    await request(open, A);
    const signedIn = await verify(open, A, codeTo(open, A));
    expect(signedIn.body).toHaveProperty("token");
    expect(signedIn.body).not.toHaveProperty("twoFactor");
  });

  it("adds a phone with a fresh session, and a taken number gets a note", async () => {
    const w = world();
    await withPhone(w, "ada@example.com", A);
    const bob = await addressUser(w, "bob@example.com");
    const taken = await add(w, bob.cookie, A);
    const free = await add(w, bob.cookie, B);
    expect(taken.status).toBe(200);
    expect(free.status).toBe(taken.status);
    expect(taken.body).toEqual({ sent: true });
    expect(free.body).toEqual(taken.body);
    expect(w.sms.sent.at(-2)).toEqual({
      to: A,
      text: "This number is already in use with api.example.com.",
    });
    expect(w.sms.sent.at(-1)?.to).toBe(B);
    // The note holds no code and writes no row: only the free number has a code of bob.
    const rows = await w.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "phone-add-otp" },
      { field: "identifier", op: "eq", value: bob.user.id },
    ]);
    expect(rows.map((r) => (r.data as { phone: string }).phone)).toEqual([B]);
    // A stale session.
    w.clock.advance(w.config.session.freshMinutes * 60_000);
    const stale = await add(w, bob.cookie, B);
    expect(stale.status).toBe(403);
    expect(stale.body).toEqual({ error: "session_not_fresh" });
  });

  it("sets the phone at the verify and loses a race on the unique key", async () => {
    const w = world();
    const ada = await addressUser(w, "ada@example.com");
    const bob = await addressUser(w, "bob@example.com");
    await add(w, ada.cookie, A);
    const adaCode = codeTo(w, A);
    await add(w, bob.cookie, A);
    const bobCode = codeTo(w, A);
    w.mail.length = 0;
    const answers = await Promise.all([
      addVerify(w, ada.cookie, adaCode),
      addVerify(w, bob.cookie, bobCode),
    ]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    const loser = answers.find((a) => a.status === 409);
    expect(loser?.body).toEqual({ error: "phone_taken" });
    const holders = await w.storage.findMany("user", [{ field: "phone", op: "eq", value: A }]);
    expect(holders).toHaveLength(1);
    const winner = holders[0]?.id === ada.user.id ? ada : bob;
    const lost = winner === ada ? { ...bob, code: bobCode } : { ...ada, code: adaCode };
    // The winner's address gets the notice; the loser gets none.
    expect(w.mail.map((m) => m.to)).toEqual([winner.user.email]);
    expect(w.mail[0]?.text).toContain("The phone number of your account was changed.");
    // The loser's code stays live: after the winner removes the number, it sets it.
    const removed = await call(
      w,
      post("/auth/phone/remove", {}, { cookie: winner.cookie, "cf-connecting-ip": w.ip() }),
    );
    expect(removed.body).toEqual({ ok: true });
    expect((await addVerify(w, lost.cookie, lost.code)).body).toEqual({ phone: A });
  });

  it("removes a phone under the last-credential guard", async () => {
    const w = world({ signUp: true }, { passkey: RP });
    const lone = await phoneSignUp(w, A);
    const remove = (cookie: string) =>
      call(w, post("/auth/phone/remove", {}, { cookie, "cf-connecting-ip": w.ip() }));
    const last = await remove(lone.cookie);
    expect(last.status).toBe(409);
    expect(last.body).toEqual({ error: "last_credential" });
    expect((await userOf(w, lone.userId))?.phone).toBe(A);
    // A phone user who added a passkey can remove the phone.
    const user = await userOf(w, lone.userId);
    if (!user) throw new Error("no user");
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
    const options = await call(
      w,
      post("/auth/passkey/register/options", {}, { cookie: lone.cookie }),
    );
    const challenge = (options.body as { challenge: string }).challenge;
    const registered = await call(
      w,
      post(
        "/auth/passkey/register/verify",
        { response: await soft.register(challenge, new TextEncoder().encode(user.id)) },
        { cookie: lone.cookie },
      ),
    );
    expect(registered.status).toBe(200);
    expect((await remove(lone.cookie)).body).toEqual({ ok: true });
    expect((await userOf(w, lone.userId))?.phone).toBeNull();
    // No phone left: the next remove answers not_found.
    expect((await remove(lone.cookie)).body).toEqual({ error: "not_found" });
  });

  it("answers 503 sms_unavailable alike for a known number and an unknown number with signUp", async () => {
    const w = world({ signUp: true });
    await withPhone(w, "ada@example.com", A);
    w.sms.down(true);
    const known = await request(w, A);
    const unknown = await request(w, B);
    expect(known.status).toBe(503);
    expect(known.body).toEqual({ error: "sms_unavailable" });
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });

  it("applies each limit of spec 32 item 5", async () => {
    const number = (i: number) => `+1415555${String(1000 + i)}`;
    // phone-otp:ip, 10 per 15 minutes.
    const ipWorld = world();
    for (let i = 0; i < 10; i++)
      expect((await request(ipWorld, number(i), "203.0.113.1")).status).toBe(200);
    expect((await request(ipWorld, number(10), "203.0.113.1")).status).toBe(429);
    // phone-otp:phone, 3 per 15 minutes.
    const perPhone = world();
    for (let i = 0; i < 3; i++) expect((await request(perPhone, A)).status).toBe(200);
    expect((await request(perPhone, A)).status).toBe(429);
    // phone-otp:phone-day, 10 per 24 hours: three each quarter hour, so the 15-minute key passes.
    const perDay = world();
    for (let i = 0; i < 10; i++) {
      if (i > 0 && i % 3 === 0) perDay.clock.advance(15 * 60_000);
      expect((await request(perDay, A)).status).toBe(200);
    }
    perDay.clock.advance(15 * 60_000);
    expect((await request(perDay, A)).body).toEqual({ error: "rate_limited" });
    // phone-verify:ip, 30 per 15 minutes, over 30 numbers so the per-number key never decides.
    const verifyIp = world();
    for (let i = 0; i < 30; i++)
      expect((await verify(verifyIp, number(i), "123456", "203.0.113.2")).status).toBe(400);
    expect((await verify(verifyIp, number(30), "123456", "203.0.113.2")).status).toBe(429);
    // phone-verify:phone, 10 per 15 minutes.
    const verifyPhone = world();
    for (let i = 0; i < 10; i++) expect((await verify(verifyPhone, A, "123456")).status).toBe(400);
    expect((await verify(verifyPhone, A, "123456")).status).toBe(429);
    // phone-add:user, 3 per 15 minutes, on three numbers.
    const adds = world();
    const me = await addressUser(adds, "ada@example.com");
    for (let i = 0; i < 3; i++) expect((await add(adds, me.cookie, number(i))).status).toBe(200);
    expect((await add(adds, me.cookie, number(3))).status).toBe(429);
    adds.clock.advance(15 * 60_000 - 1000);
    expect((await add(adds, me.cookie, number(3))).status).toBe(429);
    // The session is stale by now: a sign-in by the address makes it fresh again.
    adds.clock.advance(1000);
    const again = await createSession(adds.config, {
      userId: me.user.id,
      ip: null,
      userAgent: null,
    });
    expect((await add(adds, `${adds.config.cookieName}=${again.token}`, number(3))).body).toEqual({
      sent: true,
    });
  });

  it("counts the note to a taken number against the daily cap", async () => {
    const w = world({ dailyCap: 2 });
    await withPhone(w, "ada@example.com", A);
    // The add of ada spent one send of the cap. The note to the taken number spends the second.
    const bob = await addressUser(w, "bob@example.com");
    expect((await add(w, bob.cookie, A)).body).toEqual({ sent: true });
    const sent = w.sms.sent.length;
    const capped = await add(w, bob.cookie, A);
    expect(capped.status).toBe(429);
    expect(capped.body).toEqual({ error: "rate_limited" });
    expect(w.sms.sent).toHaveLength(sent);
    // A free number now gets the same 429: the cap counts both kinds.
    expect((await add(w, bob.cookie, B)).body).toEqual({ error: "rate_limited" });
  });

  it("spends a right code in the transaction of the sign-in", async () => {
    const w = world({ signUp: true });
    await request(w, A);
    const code = codeTo(w, A);
    // A refusal of the session hook comes before the spend: the code stays live.
    const refuse = vi.fn(() => {
      throw new Error("no");
    });
    const hooked = world({ signUp: true }, { hooks: { session: { beforeCreate: refuse } } });
    await request(hooked, A);
    const refused = await verify(hooked, A, codeTo(hooked, A));
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const live = await hooked.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "phone-otp" },
      { field: "consumedAt", op: "eq", value: null },
    ]);
    expect(live).toHaveLength(1);
    // Two parallel verifies of one right code: one session, one invalid_code.
    const both = await Promise.all([verify(w, A, code), verify(w, A, code)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await w.storage.findMany("user", [])).toHaveLength(1);
    const winner = both.find((r) => r.status === 200)?.body as { token?: string } | undefined;
    expect((await resolveSession(w.config, winner?.token ?? ""))?.user.phone).toBe(A);
  });

  it("refuses a bad number, a failed captcha, a lost port, and a spent guess count on each route", async () => {
    const w = world({ signUp: true });
    const me = await addressUser(w, "ada@example.com");
    // A number that is not E.164, and a number outside every region: no SMS.
    for (const [phone, code] of [
      ["4155550100", "phone_invalid"],
      ["+447700900123", "phone_region"],
    ] as const) {
      expect((await request(w, phone)).body).toEqual({ error: code });
      expect((await add(w, me.cookie, phone)).body).toEqual({ error: code });
    }
    expect(w.sms.sent).toEqual([]);
    // The port is down: the add answers 503 as the request does.
    w.sms.down(true);
    const down = await add(w, me.cookie, A);
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ error: "sms_unavailable" });
    w.sms.down(false);
    // Three wrong guesses spend a code: the right code then answers too_many_attempts.
    await request(w, A);
    const signInCode = codeTo(w, A);
    for (let i = 0; i < 3; i++) await verify(w, A, wrong(signInCode));
    const spent = await verify(w, A, signInCode);
    expect(spent.status).toBe(400);
    expect(spent.body).toEqual({ error: "too_many_attempts" });
    // Another user: the three adds above spent the per-user limit of ada.
    const bob = await addressUser(w, "bob@example.com");
    await add(w, bob.cookie, B);
    const addCode = codeTo(w, B);
    for (let i = 0; i < 3; i++) await addVerify(w, bob.cookie, wrong(addCode));
    expect((await addVerify(w, bob.cookie, addCode)).body).toEqual({
      error: "too_many_attempts",
    });
    // The captcha flow of the request (plan 12b): the app names it, and the port refuses the token.
    const gated = world(
      {},
      {
        captcha: {
          port: { verify: async () => "fail" },
          flows: ["phone-request"],
        },
      },
    );
    const failed = await call(
      gated,
      post("/auth/phone/request", { phone: A }, { "x-captcha-response": "tok" }),
    );
    expect(failed.status).toBe(403);
    expect(failed.body).toEqual({ error: "captcha_failed" });
    expect(gated.sms.sent).toEqual([]);
  });
});
