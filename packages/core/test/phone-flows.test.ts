import { describe, expect, it, vi } from "vitest";
import type { AuthConfig, PhoneConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { codeHash } from "../src/engine/email-otp.js";
import { passwordSignIn } from "../src/engine/password.js";
import { addPhone, requestPhone, SEND_LATER_MS } from "../src/engine/phone.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { verifyTwoFactor } from "../src/engine/totp.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import type { HandleOptions } from "../src/observe/port.js";
import { currentSecret } from "../src/primitives/keyring.js";
import type { UserRow } from "../src/schema.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { APP_ORIGIN, BASE_URL, makeAuth, post, settled } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { codeNow, enrolled, PASSWORD } from "./totp-helpers.js";

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
  // `route` answers before the work after the answer; `handle` waits for that work too.
  const route = createRouter(auth.config, coreRoutes(auth.config));
  const handle = settled(route);
  // A new client IP for each call that needs none in particular, so the per-IP keys never decide.
  let n = 0;
  const ip = () => `198.51.100.${++n}`;
  return { ...auth, sms, route, handle, ip };
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
    const { user, secret: enrolledSecret } = await enrolled(w);
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
    // A trusted device of the user passes the gate (plan 12c): the token from a verify with trustDevice.
    const s = await passwordSignIn(w.config, {
      email: "ada@example.com",
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!s.ok || !("twoFactor" in s.value)) throw new Error("no challenge");
    const trusted = await verifyTwoFactor(w.config, {
      challenge: s.value.twoFactor.challenge,
      code: await codeNow(w, enrolledSecret),
      trustDevice: true,
      ip: null,
    });
    if (!trusted.ok || !trusted.value.trustDevice) throw new Error("no trust token");
    await request(w, A);
    const passed = await call(
      w,
      post(
        "/auth/phone/verify",
        { phone: A, code: codeTo(w, A), trustDevice: trusted.value.trustDevice.token },
        { "cf-connecting-ip": w.ip() },
      ),
    );
    expect(passed.status).toBe(200);
    expect(passed.body).toHaveProperty("token");
    expect(passed.body).not.toHaveProperty("twoFactor");
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
    const ada = await withPhone(w, "ada@example.com", A);
    // The add of one's own number again gets a code, not the note.
    expect((await add(w, ada.cookie, A)).body).toEqual({ sent: true });
    expect(w.sms.sent.at(-1)?.text).toMatch(/^\d{6} is your /);
    expect((await addVerify(w, ada.cookie, codeTo(w, A))).body).toEqual({ phone: A });
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
    // The note holds no code, and the taken number gets a decoy row: both paths write a row (plan 12a).
    const rows = await w.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "phone-add-otp" },
      { field: "identifier", op: "eq", value: bob.user.id },
    ]);
    const added = rows.map((r) => r.data as { phone: string; taken?: boolean });
    expect(added.map((d) => [d.phone, d.taken === true]).sort()).toEqual([
      [A, true],
      [B, false],
    ]);
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

  it("counts a password only while an identifier reaches it (final review A M1)", async () => {
    const w = world(
      { signUp: true },
      { password: { hash: FAST, uniformSignUp: false }, username: {} },
    );
    const remove = (cookie: string) =>
      call(w, post("/auth/phone/remove", {}, { cookie, "cf-connecting-ip": w.ip() }));
    /** A phone sign-up with a first password, and a fresh session of the password by phone. */
    async function withPassword(phone: string) {
      const up = await phoneSignUp(w, phone);
      const set = await call(
        w,
        post("/auth/password/change", { newPassword: PASSWORD }, { cookie: up.cookie }),
      );
      expect(set.status).toBe(200);
      const signIn = await call(w, post("/auth/password/sign-in", { phone, password: PASSWORD }));
      expect(signIn.status).toBe(200);
      return { ...up, cookie: `${w.config.cookieName}=${signIn.body.token as string}` };
    }
    // The phone is the only identifier: with it gone no sign-in reaches the password.
    const lone = await withPassword(A);
    expect(await remove(lone.cookie)).toMatchObject({
      status: 409,
      body: { error: "last_credential" },
    });
    expect((await userOf(w, lone.userId))?.phone).toBe(A);
    // A username reaches the password, so the phone can go.
    const named = await withPassword(B);
    const username = await call(
      w,
      post("/auth/user/username", { username: "bea" }, { cookie: named.cookie }),
    );
    expect(username.status).toBe(200);
    expect(await remove(named.cookie)).toMatchObject({ status: 200, body: { ok: true } });
    const signIn = await call(
      w,
      post("/auth/password/sign-in", { username: "bea", password: PASSWORD }),
    );
    expect(signIn.status).toBe(200);
    // With username turned off later, a username reaches nothing.
    const cia = await withPassword("+14155550102");
    const named2 = await call(
      w,
      post("/auth/user/username", { username: "cia" }, { cookie: cia.cookie }),
    );
    expect(named2.status).toBe(200);
    const off = { ...w.config, username: null };
    const offRoute = settled(createRouter(off, coreRoutes(off)));
    const refused = await offRoute(post("/auth/phone/remove", {}, { cookie: cia.cookie }));
    expect([refused.status, await refused.json()]).toEqual([409, { error: "last_credential" }]);
  });

  /**
   * A port that waits up to 1 s, or until the test lets it go (probe P1 of
   * the Task 5 review waited 150 ms). A send before the answer waits the
   * whole 1 s. Ada holds number A, and B has no account. `auth` is the core
   * of every host: the tests below call `auth.handle`, not the router.
   */
  async function heldWorld() {
    const PORT_MS = 1000;
    const inner = createRecordingSms();
    let returned = 0;
    let release = () => {};
    let held = Promise.resolve();
    const sms = {
      async send(input: { to: string; text: string }) {
        await Promise.race([held, new Promise((r) => setTimeout(r, PORT_MS))]);
        returned++;
        return inner.send(input);
      },
    };
    const w = world({ sms, signUp: false });
    const ada = await addressUser(w, "ada@example.com");
    // The add sends before its answer, with the port free.
    expect((await add(w, ada.cookie, A)).body).toEqual({ sent: true });
    const addCode = /^(\d+) /.exec(inner.sent.at(-1)?.text ?? "")?.[1] ?? "";
    expect((await addVerify(w, ada.cookie, addCode)).body).toEqual({ phone: A });
    held = new Promise<void>((r) => {
      release = r;
    });
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: w.storage,
      clock: w.clock,
      mail: { send: async () => {} },
      phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: false },
    });
    const before = returned;
    const timed = async (phone: string, options?: HandleOptions) => {
      const t0 = performance.now();
      const res = await auth.handle(
        post("/auth/phone/request", { phone }, { "cf-connecting-ip": w.ip() }),
        options,
      );
      return { ms: performance.now() - t0, portReturned: returned - before, res };
    };
    return {
      PORT_MS,
      inner,
      timed,
      world: w,
      auth,
      release: () => release(),
      hold: () => {
        held = new Promise<void>((r) => {
          release = r;
        });
      },
      returned: () => returned - before,
    };
  }

  it("answers a known and an unknown number through handle before the SMS port returns (ruling 23)", async () => {
    const h = await heldWorld();
    const after: Promise<unknown>[] = [];
    const options = { waitUntil: (p: Promise<unknown>) => void after.push(p) };
    const known = await h.timed(A, options);
    const unknown = await h.timed(B, options);
    h.release();
    await Promise.all(after);
    // The answer came before the port returned.
    expect([known.portReturned, unknown.portReturned]).toEqual([0, 0]);
    expect(unknown.res.status).toBe(known.res.status);
    expect(await unknown.res.json()).toEqual(await known.res.json());
    expect(known.ms).toBeLessThan(h.PORT_MS);
    expect(Math.abs(known.ms - unknown.ms)).toBeLessThan(h.PORT_MS / 2);
    // The work after the answer sent the code to the known number only.
    expect(h.returned()).toBe(1);
    expect(h.inner.sent.at(-1)?.to).toBe(A);
  });

  it("answers an add of a held and a free number through handle before the SMS port returns (ruling 44)", async () => {
    const h = await heldWorld();
    h.release();
    const w = h.world;
    const bob = await addressUser(w, "bob@example.com");
    h.hold();
    const after: Promise<unknown>[] = [];
    const timedAdd = async (phone: string) => {
      const before = h.returned();
      const t0 = performance.now();
      const res = await h.auth.handle(
        post("/auth/phone/add", { phone }, { cookie: bob.cookie, "cf-connecting-ip": w.ip() }),
        { waitUntil: (p) => void after.push(p) },
      );
      return { ms: performance.now() - t0, portReturned: h.returned() - before, res };
    };
    const held = await timedAdd(A);
    const free = await timedAdd(B);
    h.release();
    await Promise.all(after);
    // Neither answer waited for the port: the note and the code went after it.
    expect([held.portReturned, free.portReturned]).toEqual([0, 0]);
    expect(free.res.status).toBe(held.res.status);
    expect(await free.res.json()).toEqual(await held.res.json());
    expect(held.ms).toBeLessThan(h.PORT_MS);
    expect(Math.abs(held.ms - free.ms)).toBeLessThan(h.PORT_MS / 2);
    // The work after the answer sent the note to A and a code to B.
    expect(h.inner.sent.slice(-2).map((m) => [m.to, /^\d+ is your /.test(m.text)])).toEqual([
      [A, false],
      [B, true],
    ]);
  });

  it("answers through handle with no waitUntil before the SMS port returns, off Workers (ruling 29)", async () => {
    expect(globalThis.navigator?.userAgent).not.toBe("Cloudflare-Workers");
    const h = await heldWorld();
    const known = await h.timed(A);
    const unknown = await h.timed(B);
    expect([known.portReturned, unknown.portReturned]).toEqual([0, 0]);
    expect(await unknown.res.json()).toEqual(await known.res.json());
    expect(known.ms).toBeLessThan(h.PORT_MS);
    expect(Math.abs(known.ms - unknown.ms)).toBeLessThan(h.PORT_MS / 2);
    // The detached work still sends the code.
    h.release();
    await vi.waitFor(() => expect(h.returned()).toBe(1));
    expect(h.inner.sent.at(-1)?.to).toBe(A);
  });

  it("waits through handle for the work after the answer on Workers with no waitUntil (ruling 29)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    try {
      const h = await heldWorld();
      h.release();
      // No waitUntil: the code goes out before the answer, so a runtime that
      // stops detached work cannot drop it.
      const known = await h.timed(A);
      expect(known.portReturned).toBe(1);
      expect(h.inner.sent.at(-1)?.to).toBe(A);
      // An unknown number has no work after the answer: no wait and no line.
      const unknown = await h.timed(B);
      expect(await unknown.res.json()).toEqual(await known.res.json());
      expect(warn.mock.calls).toEqual([
        ["authtempo: no waitUntil on Workers; the answer waited for the work after it"],
      ]);
      // With waitUntil on Workers, the answer does not wait.
      const after: Promise<unknown>[] = [];
      const held = await heldWorld();
      const timed = await held.timed(A, { waitUntil: (p) => void after.push(p) });
      expect(timed.portReturned).toBe(0);
      held.release();
      await Promise.all(after);
      expect(held.returned()).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      warn.mockRestore();
    }
  });

  it("waits through handle for the work after the answer on Workers when waitUntil throws (final fix wave item 14)", async () => {
    const lines = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    try {
      const h = await heldWorld();
      h.release();
      // An unbound ctx.waitUntil throws: the work must still go out before the answer.
      const timed = await h.timed(A, {
        waitUntil: () => {
          throw new TypeError("Illegal invocation");
        },
      });
      expect(await timed.res.json()).toEqual({ sent: true });
      expect(timed.portReturned).toBe(1);
      expect(h.inner.sent.at(-1)?.to).toBe(A);
    } finally {
      vi.unstubAllGlobals();
      lines.mockRestore();
    }
  });

  it("gives up a hung send after the answer at the time limit (ruling 29, LB)", async () => {
    const lines = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const w = world({ sms: { send: () => new Promise<never>(() => {}) }, signUp: true });
      const after: Promise<unknown>[] = [];
      const res = await w.route(
        post("/auth/phone/request", { phone: B }, { "cf-connecting-ip": w.ip() }),
        { waitUntil: (p) => void after.push(p) },
      );
      expect(res.status).toBe(200);
      let done = false;
      void Promise.all(after).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(SEND_LATER_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      expect(lines.mock.calls).toEqual([
        ["authtempo: an SMS after the answer was not sent", "timeout"],
      ]);
    } finally {
      vi.useRealTimers();
      lines.mockRestore();
    }
  });

  it("turns a cap refusal and an outage after the answer into lines, not a 429 or a 503", async () => {
    const lines = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const w = world({ signUp: true, dailyCap: 1 });
      expect((await request(w, A)).body).toEqual({ sent: true });
      // The cap is spent: the next send stops after the answer.
      expect(await request(w, B)).toMatchObject({ status: 200, body: { sent: true } });
      expect(w.sms.sent.map((s) => s.to)).toEqual([A]);
      const down = world({ signUp: true });
      down.sms.down(true);
      expect(await request(down, A)).toMatchObject({ status: 200, body: { sent: true } });
      expect(lines.mock.calls).toEqual([
        ["authtempo: an SMS after the answer was not sent", "capped"],
        ["authtempo: an SMS after the answer was not sent", "unavailable"],
      ]);
      // In process, with no work after the answer, the outage answers 503 alike for both numbers.
      const known = await requestPhone(down.config, { phone: A, ip: null });
      const unknown = await requestPhone(down.config, { phone: B, ip: null });
      expect(known).toMatchObject({ ok: false, code: "sms_unavailable" });
      expect(unknown).toEqual(known);
    } finally {
      lines.mockRestore();
    }
  });

  it("refuses a code sent with signUp on at a verify with signUp off", async () => {
    const on = world({ signUp: true });
    expect((await request(on, A)).body).toEqual({ sent: true });
    const code = codeTo(on, A);
    // The same store and clock, and a config that turned signUp off since the send.
    const off = world({ signUp: false }, { storage: on.storage, clock: on.clock });
    const r = await verify(off, A, code);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "invalid_code" });
    expect(await on.storage.findMany("user", [])).toEqual([]);
  });

  it("spends no sign-in key of a number at an add by another account (ruling 23, m1)", async () => {
    const w = world(
      {},
      { captcha: { port: { verify: async () => "pass" }, flows: ["phone-request"] } },
    );
    await withPhone(w, "ada@example.com", A);
    // Mallory has her own account, a fresh session, and no captcha token.
    for (const email of ["mallory@example.com", "mal@example.com", "m@example.com"]) {
      const mallory = await addressUser(w, email);
      expect((await add(w, mallory.cookie, A)).body).toEqual({ sent: true });
    }
    // Ada passes the captcha, and her sign-in requests get the full per-number count.
    const signIn = () =>
      call(
        w,
        post(
          "/auth/phone/request",
          { phone: A },
          { "cf-connecting-ip": w.ip(), "x-captcha-response": "ok" },
        ),
      );
    for (let i = 0; i < 3; i++) expect((await signIn()).status).toBe(200);
    // The add has its own key per number: 10 per 24 hours over every user.
    const adds = world();
    for (let i = 0; i < 10; i++) {
      const u = await addressUser(adds, `u${i}@example.com`);
      expect((await add(adds, u.cookie, B)).status).toBe(200);
    }
    const last = await addressUser(adds, "u10@example.com");
    expect((await add(adds, last.cookie, B)).body).toEqual({ error: "rate_limited" });
  });

  it("answers a guess of a decoy row as a wrong code", async () => {
    const w = world();
    const ada = await withPhone(w, "ada@example.com", A);
    const bob = await addressUser(w, "bob@example.com");
    expect((await add(w, bob.cookie, A)).body).toEqual({ sent: true });
    // The decoy code went to no one. A guess that hits it is the same draw as any code.
    const [decoy] = await w.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "phone-add-otp" },
      { field: "identifier", op: "eq", value: bob.user.id },
    ]);
    if (!decoy) throw new Error("no decoy row");
    const hit = "123456";
    await w.storage.update("verification", [{ field: "id", op: "eq", value: decoy.id }], {
      valueHash: await codeHash(currentSecret(w.config.keyring), decoy.id, hit),
    });
    const r = await addVerify(w, bob.cookie, hit);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "invalid_code" });
    expect((await userOf(w, ada.user.id))?.phone).toBe(A);
    expect((await userOf(w, bob.user.id))?.phone).toBeNull();
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
    const lines = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const w = world({ dailyCap: 2 });
      await withPhone(w, "ada@example.com", A);
      // The add of ada spent one send of the cap. The note to the taken number spends the second.
      const bob = await addressUser(w, "bob@example.com");
      expect((await add(w, bob.cookie, A)).body).toEqual({ sent: true });
      const sent = w.sms.sent.length;
      // The route sends after the answer (ruling 44): the cap gives a line, not a 429.
      expect(await add(w, bob.cookie, A)).toMatchObject({ status: 200, body: { sent: true } });
      expect(w.sms.sent).toHaveLength(sent);
      expect(lines.mock.calls).toEqual([
        ["authtempo: an SMS after the answer was not sent", "capped"],
      ]);
      // In process, the send runs before the answer. A free number gets the same 429:
      // the cap counts both kinds.
      const token = bob.cookie.slice(bob.cookie.indexOf("=") + 1);
      const session = await resolveSession(w.config, token);
      if (!session) throw new Error("no session");
      const free = await addPhone(w.config, { session, phone: B, ip: null });
      expect(free).toMatchObject({ ok: false, code: "rate_limited" });
      expect(w.sms.sent).toHaveLength(sent);
    } finally {
      lines.mockRestore();
    }
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
    // The port is down: the add answers 200 and writes a line, as the request does (ruling 44).
    const lines = vi.spyOn(console, "error").mockImplementation(() => {});
    w.sms.down(true);
    try {
      expect(await add(w, me.cookie, A)).toMatchObject({ status: 200, body: { sent: true } });
      expect(lines.mock.calls).toEqual([
        ["authtempo: an SMS after the answer was not sent", "unavailable"],
      ]);
    } finally {
      lines.mockRestore();
      w.sms.down(false);
    }
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
