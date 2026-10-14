import { describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../src/config.js";
import { continueHandoff, redeemHandoff, startHandoff } from "../src/engine/handoff.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import {
  changePassword,
  passwordSignIn,
  passwordSignUp,
  requestPasswordReset,
  resendPasswordVerification,
  resetPassword,
  verifyPasswordEmail,
} from "../src/engine/password.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { resolveSocialUser } from "../src/engine/social.js";
import { randomBase64Url, sha256Base64Url, sha256Hex } from "../src/primitives/crypto.js";
import { createPbkdf2PasswordHash, type PasswordHashSeam } from "../src/seams/password-hash.js";
import type { StorageAdapter, Where } from "../src/storage/port.js";
import { makeAuth, post, tokenFromMail } from "./helpers.js";
import {
  FAST,
  pwAuth,
  pwHandle,
  recordNextTransaction,
  sessionOnly,
  signUpAndVerify,
} from "./password-helpers.js";

const EMAIL = "ada@example.com";
const PW = "correct horse battery";

function signUp(
  auth: ReturnType<typeof makeAuth>,
  over: Partial<Parameters<typeof passwordSignUp>[1]> = {},
) {
  return passwordSignUp(auth.config, {
    email: EMAIL,
    password: PW,
    ip: "1.1.1.1",
    userAgent: "ua",
    ...over,
  });
}

describe("passwordSignUp", () => {
  it("creates an unverified user, the password row, a session, and mails a verify link", async () => {
    const auth = pwAuth();
    const r = await signUp(auth, { email: " Ada@Example.com ", name: "Ada" });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.token).toMatch(/^ts_[A-Za-z0-9_-]{43}$/);
    expect(r.value.user).toMatchObject({ email: EMAIL, emailVerified: false, name: "Ada" });
    const rows = await auth.storage.findMany("password", []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(r.value.user.id);
    expect(rows[0]?.hash).toMatch(/^pbkdf2-sha256\$1000\$/);
    expect(await auth.storage.findMany("session", [])).toHaveLength(1);
    expect(auth.mail).toHaveLength(1);
    expect(auth.mail[0]?.to).toBe(EMAIL);
    expect(auth.mail[0]?.subject).toBe("Confirm your email for api.example.com");
    expect(auth.mail[0]?.text).toMatch(
      /https:\/\/api\.example\.com\/auth\/password\/verify\?token=pv_[A-Za-z0-9_-]{43}/,
    );
    const v = await auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "password-verify" },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.identifier).toBe(EMAIL);
    expect(v[0]?.data).toEqual({ passwordId: rows[0]?.id });
    expect(v[0]?.expiresAt.getTime()).toBe(auth.clock.now().getTime() + 15 * 60_000);
  });

  it("answers email_taken for a verified user and for a user with a password, and sends no mail", async () => {
    const auth = pwAuth();
    await auth.seedUser(EMAIL);
    expect(await signUp(auth)).toMatchObject({ ok: false, code: "email_taken", status: 409 });
    expect(auth.mail).toEqual([]);
    const other = pwAuth();
    await signUp(other);
    expect(await signUp(other)).toMatchObject({ ok: false, code: "email_taken" });
    expect(other.mail).toHaveLength(1);
    expect(await other.storage.findMany("password", [])).toHaveLength(1);
  });

  it("answers email_taken_unverified for an unverified user with no password", async () => {
    const auth = pwAuth();
    // A reachable state: a provider that does not verify the address creates
    // an unverified user with a social identity and no password.
    const social = await resolveSocialUser(
      auth.storage,
      "google",
      { subject: "g-1", email: EMAIL, emailVerified: false, name: null, image: null },
      auth.clock.now(),
    );
    if (!social.ok) throw new Error(social.code);
    expect(social.value.emailVerified).toBe(false);
    expect(await signUp(auth)).toMatchObject({
      ok: false,
      code: "email_taken_unverified",
      status: 409,
    });
    expect(await auth.storage.findMany("password", [])).toEqual([]);
    expect(auth.mail).toEqual([]);
  });

  it("refuses a malformed email, a bad name, the policy, and a breached password before any write (Review Focus 5)", async () => {
    const seen: string[] = [];
    const auth = pwAuth({
      breachCheck: async (p) => {
        seen.push(p);
        return p === "password1234";
      },
    });
    expect(await signUp(auth, { email: "not-an-email" })).toMatchObject({
      code: "invalid_body",
      status: 400,
    });
    expect(await signUp(auth, { name: "A\nB" })).toMatchObject({ code: "invalid_body" });
    expect(await signUp(auth, { name: "" })).toMatchObject({ code: "invalid_body" });
    expect(await signUp(auth, { name: "a".repeat(201) })).toMatchObject({ code: "invalid_body" });
    expect(await signUp(auth, { password: "ADA@EXAMPLE.COM" })).toMatchObject({
      code: "password_policy",
      status: 400,
    });
    // The policy compares against the normalized address, not the raw input.
    expect(
      await signUp(auth, { email: " Ada@Example.COM ", password: "ada@example.com" }),
    ).toMatchObject({ code: "password_policy" });
    expect(await signUp(auth, { password: "a".repeat(129) })).toMatchObject({
      code: "password_policy",
    });
    expect(await signUp(auth, { password: "password1234" })).toMatchObject({
      code: "password_breached",
      status: 400,
    });
    expect(seen).toEqual(["password1234"]);
    expect(await auth.storage.findMany("user", [])).toEqual([]);
    expect(auth.mail).toEqual([]);
  });

  it("limits sign-ups to 10 per ip per hour", async () => {
    const auth = pwAuth();
    for (let i = 0; i < 10; i++)
      expect((await signUp(auth, { email: `u${i}@example.com` })).ok).toBe(true);
    expect(await signUp(auth, { email: "u10@example.com" })).toMatchObject({
      code: "rate_limited",
      status: 429,
    });
    auth.clock.advance(3600 * 1000);
    expect((await signUp(auth, { email: "u10@example.com" })).ok).toBe(true);
  });

  it("answers not_found with no password config", async () => {
    const auth = makeAuth();
    expect(await signUp(auth)).toMatchObject({ code: "not_found", status: 404 });
  });
});

describe("POST /password/sign-up", () => {
  it("answers the token and the session with the cookie", async () => {
    const h = pwHandle({ hash: FAST });
    const res = await h.auth.handle(post("/auth/password/sign-up", { email: EMAIL, password: PW }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      user: { email: string; emailVerified: boolean };
      session: { id: string };
    };
    expect(body.token).toMatch(/^ts_/);
    expect(body.user).toMatchObject({ email: EMAIL, emailVerified: false });
    expect(res.headers.get("set-cookie")).toMatch(
      /^tempo_session=ts_.*HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0]?.token).toMatch(/^pv_[A-Za-z0-9_-]{43}$/);
    expect(await h.auth.api.getSession(body.token)).toMatchObject({
      user: { email: EMAIL },
      session: { id: body.session.id },
    });
  });

  it("answers 404 and has no api.password without a password config", async () => {
    const h = pwHandle(undefined);
    const res = await h.auth.handle(post("/auth/password/sign-up", { email: EMAIL, password: PW }));
    expect(res.status).toBe(404);
    expect(h.auth.api.password).toBeUndefined();
    expect(await h.storage.findMany("user", [])).toEqual([]);
  });

  it("has api.password.signUp with a password config", async () => {
    const h = pwHandle({ hash: FAST });
    const r = await h.auth.api.password?.signUp({
      email: EMAIL,
      password: PW,
      ip: null,
      userAgent: null,
    });
    expect(r).toMatchObject({ ok: true, value: { user: { email: EMAIL } } });
  });

  it("answers invalid_body for a body that is not the shape", async () => {
    const res = await pwHandle({ hash: FAST }).auth.handle(
      post("/auth/password/sign-up", { email: EMAIL }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("answers the engine's failure code", async () => {
    const h = pwHandle({ hash: FAST });
    const res = await h.auth.handle(
      post("/auth/password/sign-up", { email: EMAIL, password: "short" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "password_policy" });
  });
});

/** A seam that records each call and passes it to `inner`. `beforeHash` runs before each hash. */
function counting(inner: PasswordHashSeam, beforeHash: () => Promise<void> = async () => {}) {
  const calls = { hash: 0, verify: [] as string[] };
  const seam: PasswordHashSeam = {
    dummy: () => inner.dummy(),
    hash: async (p) => {
      calls.hash++;
      await beforeHash();
      return inner.hash(p);
    },
    verify: (p, stored) => {
      calls.verify.push(stored);
      return inner.verify(p, stored);
    },
  };
  return { calls, seam };
}

function signIn(
  auth: ReturnType<typeof makeAuth>,
  over: Partial<Parameters<typeof passwordSignIn>[1]> = {},
) {
  return sessionOnly(
    passwordSignIn(auth.config, {
      email: EMAIL,
      password: PW,
      ip: "1.1.1.1",
      userAgent: "ua",
      ...over,
    }),
  );
}

/** The same storage, clock, and limiter, with another hash seam: a deployer who changed the cost. */
function withSeam(config: ResolvedConfig, hash: PasswordHashSeam): ResolvedConfig {
  if (!config.password) throw new Error("no password config");
  return { ...config, password: { ...config.password, hash } };
}

/**
 * The statements of a reset (`keep` null) or a change (`keep` the
 * changer's session), as they land inside another flow's open transaction
 * on D1: the new hash first, then the session delete. The engine keeps the
 * same order; "writes the new hash before the session delete" pins it.
 */
async function writeHashThenEndSessions(
  auth: ReturnType<typeof makeAuth>,
  userId: string,
  hash: string,
  keep: string | null,
): Promise<void> {
  await auth.storage.update("password", [{ field: "userId", op: "eq", value: userId }], { hash });
  const where: Where<"session">[] = [{ field: "userId", op: "eq", value: userId }];
  if (keep) where.push({ field: "id", op: "ne", value: keep });
  await auth.storage.delete("session", where);
}

/**
 * Wraps the next `storage.transaction` call so that `before` runs inside
 * it, just before its session insert. The work in `before` uses the outer
 * storage, which does not wait for the transaction, as on D1.
 */
function beforeSessionInsert(
  storage: StorageAdapter,
  before: () => Promise<void>,
): { fired: () => boolean } {
  const original = storage.transaction.bind(storage);
  let armed = true;
  let fired = false;
  storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> => {
    if (!armed) return original(fn);
    armed = false;
    return original((tx) =>
      fn({
        ...tx,
        create: async (m, d) => {
          if (m === "session" && !fired) {
            fired = true;
            await before();
          }
          return tx.create(m, d);
        },
      }),
    );
  };
  return { fired: () => fired };
}

describe("passwordSignIn", () => {
  it("signs in an unverified user with the right password and refuses a wrong one", async () => {
    // Reachable: a sign-up whose verify link was not used.
    const auth = pwAuth();
    await signUp(auth);
    const r = await signIn(auth);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.user).toMatchObject({ email: EMAIL, emailVerified: false });
    expect(r.value.token).toMatch(/^ts_[A-Za-z0-9_-]{43}$/);
    expect(
      await auth.storage.findOne("session", [{ field: "id", op: "eq", value: r.value.session.id }]),
    ).not.toBeNull();
    expect(await signIn(auth, { password: "wrong password" })).toMatchObject({
      ok: false,
      code: "invalid_credentials",
      status: 401,
    });
    // The lookup uses the normalized address.
    expect((await signIn(auth, { email: " ADA@Example.com " })).ok).toBe(true);
  });

  it("signs in a verified user whose sign-up link was used", async () => {
    const auth = pwAuth();
    await signUpAndVerify(auth);
    const r = await signIn(auth);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.user).toMatchObject({ email: EMAIL, emailVerified: true });
    expect(await signIn(auth, { password: "wrong password" })).toMatchObject({
      code: "invalid_credentials",
    });
  });

  it("runs exactly one verify, at the seam's cost, for an unknown address, a user with no password, a malformed address, and a wrong password (Review Focus 1)", async () => {
    const { calls, seam } = counting(FAST);
    const auth = pwAuth({ hash: seam });
    // Reachable: a magic link sign-in makes a verified user with no password.
    await requestMagicLink(auth.config, { email: "nopw@example.com", ip: null });
    const ml = await verifyMagicLink(auth.config, {
      token: tokenFromMail(auth.mail.at(-1)?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    if (!ml.ok) throw new Error(ml.code);
    await signUp(auth);
    const hashes = calls.hash;
    const cases = [
      { email: "nobody@example.com", password: PW },
      { email: "nopw@example.com", password: PW },
      { email: "not-an-email", password: PW },
      { email: EMAIL, password: "wrong password" },
    ];
    for (const c of cases) {
      const before = calls.verify.length;
      expect(await signIn(auth, c)).toMatchObject({ ok: false, code: "invalid_credentials" });
      expect(calls.verify.length - before).toBe(1);
      expect(calls.verify.at(-1)).toMatch(/^pbkdf2-sha256\$1000\$/);
    }
    // The three cases with no row verify against the seam's dummy.
    const dummy = await FAST.dummy();
    expect(calls.verify.slice(0, 3)).toEqual([dummy, dummy, dummy]);
    // The dummy is not a hash: no sign-in runs a hash.
    expect(calls.hash).toBe(hashes);
  });

  it("builds the dummy on the first sign-in with no row and reuses it, not at construction (Important 2)", async () => {
    const random = vi.spyOn(crypto, "getRandomValues");
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    try {
      const seam = createPbkdf2PasswordHash({ iterations: 1000 });
      expect(random).not.toHaveBeenCalled();
      expect(derive).not.toHaveBeenCalled();
      const auth = pwAuth({ hash: seam });
      random.mockClear();
      expect(await signIn(auth, { email: "nobody@example.com" })).toMatchObject({
        code: "invalid_credentials",
      });
      // One salt and one digest, drawn once.
      expect(random).toHaveBeenCalledTimes(2);
      expect(derive).toHaveBeenCalledTimes(1);
      random.mockClear();
      expect(await signIn(auth, { email: "nobody2@example.com" })).toMatchObject({
        code: "invalid_credentials",
      });
      expect(random).not.toHaveBeenCalled();
      expect(derive).toHaveBeenCalledTimes(2);
      expect(derive.mock.calls[1]?.[0]).toMatchObject({ name: "PBKDF2", iterations: 1000 });
    } finally {
      random.mockRestore();
      derive.mockRestore();
    }
  });

  it("answers invalid_credentials for a password over 128 code points with no verify (Review Focus 5)", async () => {
    const { calls, seam } = counting(FAST);
    const auth = pwAuth({ hash: seam });
    await signUp(auth);
    const before = calls.verify.length;
    expect(await signIn(auth, { password: "a".repeat(129) })).toMatchObject({
      code: "invalid_credentials",
    });
    expect(calls.verify.length).toBe(before);
    // 128 code points of a 2-unit character is 256 UTF-16 units, and it still runs the verify.
    expect(await signIn(auth, { password: "\u{1F600}".repeat(128) })).toMatchObject({
      code: "invalid_credentials",
    });
    expect(calls.verify.length).toBe(before + 1);
  });

  it("limits to 10 per email and to 20 per ip per 15 minutes, with no verify on a refusal", async () => {
    const { calls, seam } = counting(FAST);
    const auth = pwAuth({ hash: seam });
    await signUp(auth);
    for (let i = 0; i < 10; i++)
      expect(
        await signIn(auth, {
          email: i % 2 ? EMAIL : " ADA@example.com",
          password: "wrong password",
          ip: `9.9.9.${i}`,
        }),
      ).toMatchObject({ code: "invalid_credentials" });
    let before = calls.verify.length;
    expect(await signIn(auth, { ip: "9.9.9.99" })).toMatchObject({
      code: "rate_limited",
      status: 429,
    });
    // A refusal runs no verify, so the limit bounds the CPU.
    expect(calls.verify.length).toBe(before);
    auth.clock.advance(900 * 1000);
    expect((await signIn(auth, { ip: "9.9.9.99" })).ok).toBe(true);
    const o = counting(FAST);
    const other = pwAuth({ hash: o.seam });
    for (let i = 0; i < 20; i++)
      expect(await signIn(other, { email: `x${i}@example.com`, ip: "2.2.2.2" })).toMatchObject({
        code: "invalid_credentials",
      });
    before = o.calls.verify.length;
    expect(await signIn(other, { email: "x20@example.com", ip: "2.2.2.2" })).toMatchObject({
      code: "rate_limited",
    });
    expect(o.calls.verify.length).toBe(before);
  });

  it("checks the ip limit before the email limit, so an ip refusal does not spend the email budget", async () => {
    const auth = pwAuth();
    await signUp(auth);
    // Spend the ip budget of 3.3.3.3 on other addresses.
    for (let i = 0; i < 20; i++) await signIn(auth, { email: `y${i}@example.com`, ip: "3.3.3.3" });
    // Ten more for the victim's address from that ip: each is refused by the ip limit.
    for (let i = 0; i < 10; i++)
      expect(await signIn(auth, { password: "wrong password", ip: "3.3.3.3" })).toMatchObject({
        code: "rate_limited",
      });
    // The victim's email budget is whole: a fresh ip signs in.
    expect((await signIn(auth, { ip: "4.4.4.4" })).ok).toBe(true);
  });

  it("rewrites a hash with a lower cost at the current cost on a right sign-in, once", async () => {
    // Reachable: a sign-up at cost 1000, then the deployer raises the cost to 2000.
    const auth = pwAuth();
    const before = await signUpAndVerify(auth);
    expect(before.hash).toMatch(/^pbkdf2-sha256\$1000\$/);
    const { calls, seam } = counting(createPbkdf2PasswordHash({ iterations: 2000 }));
    const raised = withSeam(auth.config, seam);
    expect(
      (await passwordSignIn(raised, { email: EMAIL, password: PW, ip: null, userAgent: null })).ok,
    ).toBe(true);
    const after = await auth.storage.findOne("password", [
      { field: "id", op: "eq", value: before.id },
    ]);
    expect(after?.hash).toMatch(/^pbkdf2-sha256\$2000\$/);
    expect(after?.updatedAt).toEqual(auth.clock.now());
    expect(calls.hash).toBe(1);
    // The new hash is at the current cost, so the next sign-in does not rehash.
    expect(
      (await passwordSignIn(raised, { email: EMAIL, password: PW, ip: null, userAgent: null })).ok,
    ).toBe(true);
    expect(calls.hash).toBe(1);
    expect(
      (await auth.storage.findOne("password", [{ field: "id", op: "eq", value: before.id }]))?.hash,
    ).toBe(after?.hash);
  });

  it("signs in both of two right sign-ins that race one rehash (plan 8b, Review Focus 4)", async () => {
    // Reachable: a verified user at cost 1000, then the deployer raises the
    // cost to 2000. Two devices sign in at once: both read the old hash, and
    // the second finishes its rehash while the first derives its new hash.
    const auth = pwAuth();
    const before = await signUpAndVerify(auth);
    let race: () => Promise<void> = async () => {};
    const { calls, seam } = counting(createPbkdf2PasswordHash({ iterations: 2000 }), () => race());
    const raised = withSeam(auth.config, seam);
    let second: Awaited<ReturnType<typeof sessionOnly>> | null = null;
    race = async () => {
      race = async () => {};
      second = await sessionOnly(
        passwordSignIn(raised, {
          email: EMAIL,
          password: PW,
          ip: "2.2.2.2",
          userAgent: "ua",
        }),
      );
    };
    const first = await sessionOnly(
      passwordSignIn(raised, {
        email: EMAIL,
        password: PW,
        ip: "1.1.1.1",
        userAgent: "ua",
      }),
    );
    const other = second as Awaited<ReturnType<typeof sessionOnly>> | null;
    if (!first.ok) throw new Error(`the first sign-in answered ${first.code}`);
    if (!other?.ok) throw new Error("the second sign-in did not sign in");
    expect(calls.hash).toBe(2);
    // Two first verifies, and one more on the sign-in that loses the rehash.
    expect(calls.verify).toHaveLength(3);
    const row = await auth.storage.findOne("password", [
      { field: "id", op: "eq", value: before.id },
    ]);
    expect(row?.hash).toMatch(/^pbkdf2-sha256\$2000\$/);
    const ids = (await auth.storage.findMany("session", [])).map((s) => s.id);
    expect(ids).toContain(first.value.session.id);
    expect(ids).toContain(other.value.session.id);
    expect(first.value.session.id).not.toBe(other.value.session.id);
  });
  it("keeps the hash and no session when a change lands between the verify and the rehash", async () => {
    const auth = pwAuth();
    const before = await signUpAndVerify(auth);
    // A change writes the new hash, then deletes the sessions, after this sign-in read the row.
    const other = await FAST.hash("the new password");
    const { seam } = counting(createPbkdf2PasswordHash({ iterations: 2000 }), async () => {
      await writeHashThenEndSessions(auth, before.userId, other, null);
    });
    const transactions = vi.spyOn(auth.storage, "transaction");
    const r = await passwordSignIn(withSeam(auth.config, seam), {
      email: EMAIL,
      password: PW,
      ip: null,
      userAgent: null,
    });
    expect(r).toMatchObject({ ok: false, code: "invalid_credentials" });
    // The rehash matched zero rows, so the sign-in answers at once: no session transaction.
    expect(transactions).not.toHaveBeenCalled();
    transactions.mockRestore();
    expect(await auth.storage.findMany("password", [])).toMatchObject([
      { id: before.id, hash: other },
    ]);
    expect(await auth.storage.findMany("session", [])).toEqual([]);
  });

  it("keeps no session for a sign-in with the old password that races a reset (Important 1)", async () => {
    const auth = pwAuth();
    const before = await signUpAndVerify(auth);
    const other = await FAST.hash("the new password");
    // A reset: write the new hash, then delete every session. It
    // runs inside the sign-in's transaction, after the verify and before
    // the session insert, as on D1.
    const gate = beforeSessionInsert(auth.storage, () =>
      writeHashThenEndSessions(auth, before.userId, other, null),
    );
    expect(await signIn(auth)).toMatchObject({ ok: false, code: "invalid_credentials" });
    expect(gate.fired()).toBe(true);
    expect(await auth.storage.findMany("session", [])).toEqual([]);
    expect(await auth.storage.findMany("password", [])).toMatchObject([
      { id: before.id, hash: other },
    ]);
  });

  it("keeps only the changer's session for a sign-in with the old password that races a change (Important 1)", async () => {
    const auth = pwAuth();
    const before = await signUpAndVerify(auth);
    const mine = await signIn(auth);
    if (!mine.ok) throw new Error(mine.code);
    const other = await FAST.hash("the new password");
    // A change: write the new hash, then delete every other session.
    const gate = beforeSessionInsert(auth.storage, () =>
      writeHashThenEndSessions(auth, before.userId, other, mine.value.session.id),
    );
    expect(await signIn(auth, { ip: "5.5.5.5" })).toMatchObject({
      ok: false,
      code: "invalid_credentials",
    });
    expect(gate.fired()).toBe(true);
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((x) => x.id)).toEqual([mine.value.session.id]);
  });

  it("writes no password row back when a claim deleted it between the verify and the rehash", async () => {
    // Reachable: an unverified sign-up at cost 1000, then the cost is raised,
    // and the owner of the address uses a magic link during the claimant's sign-in.
    const auth = pwAuth();
    const up = await signUp(auth);
    if (!up.ok) throw new Error(up.code);
    await requestMagicLink(auth.config, { email: EMAIL, ip: null });
    const link = tokenFromMail(auth.mail.at(-1)?.text ?? "");
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    const { calls, seam } = counting(createPbkdf2PasswordHash({ iterations: 2000 }), async () => {
      owner = await verifyMagicLink(auth.config, { token: link, ip: null, userAgent: null });
    });
    const r = await passwordSignIn(withSeam(auth.config, seam), {
      email: EMAIL,
      password: PW,
      ip: null,
      userAgent: null,
    });
    expect(calls.hash).toBe(1);
    expect(r).toMatchObject({ ok: false, code: "invalid_credentials" });
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    if (!proved?.ok) throw new Error("the owner's verify failed");
    expect(await auth.storage.findMany("password", [])).toEqual([]);
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
  });

  it("does not normalize Unicode: the NFD form of an NFC password does not sign in", async () => {
    const nfc = "caf\u{E9} secret phrase";
    const nfd = "cafe\u{301} secret phrase";
    // The two differ only in the normal form.
    expect(nfd).not.toBe(nfc);
    expect(nfd.normalize("NFC")).toBe(nfc);
    const auth = pwAuth();
    await signUp(auth, { password: nfc });
    expect((await signIn(auth, { password: nfc })).ok).toBe(true);
    expect(await signIn(auth, { password: nfd })).toMatchObject({ code: "invalid_credentials" });
  });

  it("answers not_found with no password config", async () => {
    expect(await signIn(makeAuth())).toMatchObject({ code: "not_found", status: 404 });
  });
});

describe("POST /password/sign-in", () => {
  it("answers the token and the session with the cookie, and 401 for a wrong password", async () => {
    const h = pwHandle({ hash: FAST });
    const up = await h.auth.handle(post("/auth/password/sign-up", { email: EMAIL, password: PW }));
    expect(up.status).toBe(200);
    const res = await h.auth.handle(post("/auth/password/sign-in", { email: EMAIL, password: PW }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      user: { email: string };
      session: { id: string };
    };
    expect(body.token).toMatch(/^ts_/);
    expect(body.user).toMatchObject({ email: EMAIL });
    expect(res.headers.get("set-cookie")).toMatch(
      /^tempo_session=ts_.*HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(await h.auth.api.getSession(body.token)).toMatchObject({
      session: { id: body.session.id },
    });
    const wrong = await h.auth.handle(
      post("/auth/password/sign-in", { email: EMAIL, password: "wrong password" }),
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "invalid_credentials" });
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });

  it("answers invalid_body for a body that is not the shape, and 404 with no password config", async () => {
    const res = await pwHandle({ hash: FAST }).auth.handle(
      post("/auth/password/sign-in", { email: EMAIL }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    const off = await pwHandle(undefined).auth.handle(
      post("/auth/password/sign-in", { email: EMAIL, password: PW }),
    );
    expect(off.status).toBe(404);
  });

  it("has api.password.signIn with a password config", async () => {
    const h = pwHandle({ hash: FAST });
    await h.auth.api.password?.signUp({ email: EMAIL, password: PW, ip: null, userAgent: null });
    const r = await h.auth.api.password?.signIn({
      email: EMAIL,
      password: PW,
      ip: null,
      userAgent: null,
    });
    expect(r).toMatchObject({ ok: true, value: { user: { email: EMAIL } } });
  });
});

const verifyToken = (auth: ReturnType<typeof pwAuth>) =>
  tokenFromMail(auth.mail.find((m) => m.subject.startsWith("Confirm"))?.text ?? "");
const resetToken = (auth: ReturnType<typeof pwAuth>) =>
  tokenFromMail(auth.mail.filter((m) => m.subject.startsWith("Reset")).at(-1)?.text ?? "");
const req = { ip: "1.1.1.1", userAgent: "ua" };

/**
 * An auth whose mail port records, for each mail, whether a transaction
 * was open and which verification rows existed at the send.
 */
function mailWatchAuth() {
  let open = 0;
  const seen: { open: number; purposes: string[]; users: number }[] = [];
  const auth = makeAuth({
    password: { hash: FAST },
    mail: {
      send: async () => {
        const rows = await auth.storage.findMany("verification", []);
        const users = (await auth.storage.findMany("user", [])).length;
        seen.push({ open, purposes: rows.map((r) => r.purpose), users });
      },
    },
  });
  const original = auth.storage.transaction.bind(auth.storage);
  auth.storage.transaction = async <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> => {
    open++;
    try {
      return await original(fn);
    } finally {
      open--;
    }
  };
  return { auth, seen };
}

describe("verifyPasswordEmail", () => {
  it("verifies the user, keeps the password, adds the email identity, and makes the only session", async () => {
    const auth = pwAuth();
    const up = await signUp(auth);
    if (!up.ok) throw new Error(up.code);
    const [row] = await auth.storage.findMany("password", []);
    const r = await verifyPasswordEmail(auth.config, { token: verifyToken(auth), ...req });
    if (!r.ok || !r.value.signedIn) throw new Error("no session");
    expect(r.value.user.emailVerified).toBe(true);
    expect(
      await auth.storage.findOne("password", [{ field: "id", op: "eq", value: row?.id ?? "" }]),
    ).not.toBeNull();
    expect(
      await auth.storage.findOne("identity", [{ field: "provider", op: "eq", value: "email" }]),
    ).toMatchObject({ subject: EMAIL });
    expect(await resolveSession(auth.config, up.value.token)).toBeNull();
    expect(await resolveSession(auth.config, r.value.signedIn.token)).not.toBeNull();
    expect((await signIn(auth)).ok).toBe(true);
  });

  it("answers invalid_token on a replay and token_expired after the ttl", async () => {
    const auth = pwAuth();
    await signUp(auth);
    const token = verifyToken(auth);
    expect((await verifyPasswordEmail(auth.config, { token, ...req })).ok).toBe(true);
    expect(await verifyPasswordEmail(auth.config, { token, ...req })).toMatchObject({
      code: "invalid_token",
    });
    const late = pwAuth();
    await signUp(late);
    late.clock.advance(15 * 60_000);
    expect(
      await verifyPasswordEmail(late.config, { token: verifyToken(late), ...req }),
    ).toMatchObject({ code: "token_expired" });
  });

  it("consumes the link and answers invalid_token with no change when a magic link claim deleted the password", async () => {
    const auth = pwAuth();
    await signUp(auth);
    await requestMagicLink(auth.config, { email: EMAIL, ip: null });
    const ml = tokenFromMail(auth.mail.at(-1)?.text ?? "");
    expect((await verifyMagicLink(auth.config, { token: ml, ip: null, userAgent: null })).ok).toBe(
      true,
    );
    const user = await auth.storage.findOne("user", [{ field: "email", op: "eq", value: EMAIL }]);
    const sessions = await auth.storage.findMany("session", []);
    auth.clock.advance(1000);
    const r = await verifyPasswordEmail(auth.config, { token: verifyToken(auth), ...req });
    expect(r).toMatchObject({ ok: false, code: "invalid_token" });
    expect(await auth.storage.findMany("password", [])).toEqual([]);
    expect(await auth.storage.findMany("session", [])).toEqual(sessions);
    expect(
      await auth.storage.findOne("user", [{ field: "email", op: "eq", value: EMAIL }]),
    ).toEqual(user);
    const [link] = await auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "password-verify" },
    ]);
    expect(link?.consumedAt).toEqual(auth.clock.now());
  });

  it("sends the verify mail after the sign-up transaction commits and after the row exists", async () => {
    const { auth, seen } = mailWatchAuth();
    expect((await signUp(auth)).ok).toBe(true);
    expect(seen).toEqual([{ open: 0, purposes: ["password-verify"], users: 1 }]);
  });
});

describe("requestPasswordReset and resetPassword", () => {
  it("always answers sent, mails a reset link for a well-formed address, and nothing for a malformed one", async () => {
    const auth = pwAuth();
    expect(await requestPasswordReset(auth.config, { email: "not-an-email", ip: null })).toEqual({
      ok: true,
      value: { sent: true },
    });
    expect(auth.mail).toEqual([]);
    expect(
      await requestPasswordReset(auth.config, { email: "nobody@example.com", ip: null }),
    ).toEqual({ ok: true, value: { sent: true } });
    expect(auth.mail[0]?.subject).toBe("Reset your password for api.example.com");
    expect(auth.mail[0]?.text).toMatch(
      /https:\/\/api\.example\.com\/auth\/password\/reset\?token=pr_[A-Za-z0-9_-]{43}/,
    );
    const [row] = await auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "password-reset" },
    ]);
    expect(row?.expiresAt.getTime()).toBe(auth.clock.now().getTime() + 15 * 60_000);
  });

  it("normalizes the address before the limit key and the row", async () => {
    const auth = pwAuth();
    await requestPasswordReset(auth.config, { email: "  ADA@Example.COM ", ip: null });
    const [row] = await auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "password-reset" },
    ]);
    expect(row?.identifier).toBe(EMAIL);
    expect(auth.mail[0]?.to).toBe(EMAIL);
    for (let i = 0; i < 4; i++) await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    expect(
      await requestPasswordReset(auth.config, { email: "Ada@example.com", ip: null }),
    ).toMatchObject({ code: "rate_limited" });
  });

  it("sends the reset mail after the row exists and outside any transaction", async () => {
    const { auth, seen } = mailWatchAuth();
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    expect(seen).toEqual([{ open: 0, purposes: ["password-reset"], users: 0 }]);
  });

  it("limits to 5 per email and 20 per ip per 15 minutes", async () => {
    const auth = pwAuth();
    for (let i = 0; i < 5; i++)
      await requestPasswordReset(auth.config, { email: EMAIL, ip: `3.3.3.${i}` });
    expect(await requestPasswordReset(auth.config, { email: EMAIL, ip: "3.3.3.9" })).toMatchObject({
      code: "rate_limited",
    });
    for (let i = 0; i < 20; i++)
      await requestPasswordReset(auth.config, { email: `r${i}@example.com`, ip: "4.4.4.4" });
    expect(
      await requestPasswordReset(auth.config, { email: "r20@example.com", ip: "4.4.4.4" }),
    ).toMatchObject({ code: "rate_limited" });
  });

  it("creates a verified user with the password for an unknown address", async () => {
    const auth = pwAuth();
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const r = await resetPassword(auth.config, {
      token: resetToken(auth),
      password: "new password 1",
      ...req,
    });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.user).toMatchObject({ email: EMAIL, emailVerified: true });
    expect(r.value.next).toBe("/");
    expect(
      await auth.storage.findMany("identity", [{ field: "provider", op: "eq", value: "email" }]),
    ).toMatchObject([{ subject: EMAIL, userId: r.value.user.id }]);
    expect((await signIn(auth, { password: "new password 1" })).ok).toBe(true);
  });

  it("claims an unverified claimant's account: the claimant's password and session go", async () => {
    const auth = pwAuth();
    const claimant = await signUp(auth, { password: "claimant password" });
    if (!claimant.ok) throw new Error(claimant.code);
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    expect(
      (
        await resetPassword(auth.config, {
          token: resetToken(auth),
          password: "owner password 1",
          ...req,
        })
      ).ok,
    ).toBe(true);
    expect(await resolveSession(auth.config, claimant.value.token)).toBeNull();
    expect(await signIn(auth, { password: "claimant password" })).toMatchObject({
      code: "invalid_credentials",
    });
    expect((await signIn(auth, { password: "owner password 1" })).ok).toBe(true);
  });

  it("claims an unverified social claimant: the claimant's identity goes, the new password stays", async () => {
    const auth = pwAuth();
    // Reachable: a provider that does not verify the address created the user.
    const social = await resolveSocialUser(
      auth.storage,
      "google",
      { subject: "g-1", email: EMAIL, emailVerified: false, name: null, image: null },
      auth.clock.now(),
    );
    if (!social.ok) throw new Error(social.code);
    const claimant = await auth.storage.findOne("user", [
      { field: "email", op: "eq", value: EMAIL },
    ]);
    if (!claimant || claimant.emailVerified) throw new Error("no unverified claimant");
    const old = await createSession(auth.config, {
      userId: claimant.id,
      ip: null,
      userAgent: null,
    });
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const r = await resetPassword(auth.config, {
      token: resetToken(auth),
      password: "owner password 1",
      ...req,
    });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.user).toMatchObject({ id: claimant.id, emailVerified: true });
    expect(await resolveSession(auth.config, old.token)).toBeNull();
    const identities = await auth.storage.findMany("identity", []);
    expect(identities.map((x) => [x.provider, x.subject])).toEqual([["email", EMAIL]]);
    expect((await signIn(auth, { password: "owner password 1" })).ok).toBe(true);
  });

  it("ends every session of a verified user and keeps the user's passkeys and social identities", async () => {
    const auth = pwAuth();
    const user = await auth.seedUser(EMAIL);
    const now = auth.clock.now();
    await auth.storage.create("identity", {
      id: "i1",
      userId: user.id,
      provider: "google",
      subject: "g-1",
      linkedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await auth.storage.create("passkey", {
      id: "k1",
      userId: user.id,
      credentialId: "c1",
      publicKey: "pk",
      counter: 0,
      transports: null,
      deviceType: "singleDevice",
      backedUp: false,
      name: null,
      createdAt: now,
      updatedAt: now,
    });
    const old = await createSession(auth.config, { userId: user.id, ip: null, userAgent: null });
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const r = await resetPassword(auth.config, {
      token: resetToken(auth),
      password: "new password 1",
      ...req,
    });
    if (!r.ok) throw new Error(r.code);
    if (!("token" in r.value)) throw new Error("the reset answered a challenge");
    expect(await resolveSession(auth.config, old.token)).toBeNull();
    expect(await resolveSession(auth.config, r.value.token)).not.toBeNull();
    expect(
      await auth.storage.findMany("identity", [{ field: "provider", op: "eq", value: "google" }]),
    ).toHaveLength(1);
    expect(await auth.storage.findMany("passkey", [])).toHaveLength(1);
  });

  it("refuses a replay, an expired link, and leaves the link usable after a refused password (Review Focus 3)", async () => {
    const auth = pwAuth({ breachCheck: async (p) => p === "breached password" });
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const token = resetToken(auth);
    expect(await resetPassword(auth.config, { token, password: "short", ...req })).toMatchObject({
      code: "password_policy",
    });
    expect(
      await resetPassword(auth.config, { token, password: "breached password", ...req }),
    ).toMatchObject({ code: "password_breached" });
    expect(
      (await resetPassword(auth.config, { token, password: "first password", ...req })).ok,
    ).toBe(true);
    expect(
      await resetPassword(auth.config, { token, password: "second password", ...req }),
    ).toMatchObject({ code: "invalid_token" });
    expect(await signIn(auth, { password: "second password" })).toMatchObject({
      code: "invalid_credentials",
    });
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const late = resetToken(auth);
    auth.clock.advance(15 * 60_000);
    expect(
      await resetPassword(auth.config, { token: late, password: "third password", ...req }),
    ).toMatchObject({ code: "token_expired" });
  });

  it("carries a safe next and drops an unsafe one", async () => {
    const auth = pwAuth();
    await requestPasswordReset(auth.config, {
      email: EMAIL,
      next: "/auth/handoff/continue?h=hs_x",
      ip: null,
    });
    const r = await resetPassword(auth.config, {
      token: resetToken(auth),
      password: "new password 1",
      ...req,
    });
    expect(r.ok && r.value.next).toBe("/auth/handoff/continue?h=hs_x");
    await requestPasswordReset(auth.config, {
      email: "b@example.com",
      next: "//evil.example",
      ip: null,
    });
    const s = await resetPassword(auth.config, {
      token: resetToken(auth),
      password: "new password 1",
      ...req,
    });
    expect(s.ok && s.value.next).toBe("/");
  });

  it("writes the new hash before the session delete, for a verified and an unverified user", async () => {
    const auth = pwAuth();
    await signUp(auth);
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const claim = recordNextTransaction(auth.storage);
    expect(
      (
        await resetPassword(auth.config, {
          token: resetToken(auth),
          password: "owner pw 1",
          ...req,
        })
      ).ok,
    ).toBe(true);
    expect(claim.indexOf("update:password")).toBeGreaterThanOrEqual(0);
    expect(claim.indexOf("update:password")).toBeLessThan(claim.indexOf("delete:session"));
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const verified = recordNextTransaction(auth.storage);
    expect(
      (
        await resetPassword(auth.config, {
          token: resetToken(auth),
          password: "owner pw 2",
          ...req,
        })
      ).ok,
    ).toBe(true);
    expect(verified.indexOf("update:password")).toBeGreaterThanOrEqual(0);
    expect(verified.indexOf("update:password")).toBeLessThan(verified.indexOf("delete:session"));
    // The OAuth refresh tokens go in the same transaction, after the sessions, in each branch (plan 9g final fix wave).
    for (const writes of [claim, verified]) {
      // Each list holds the session delete, so the order check below cannot pass on a -1.
      expect(writes).toContain("delete:session");
      expect(writes.indexOf("delete:oauthToken")).toBeGreaterThan(writes.indexOf("delete:session"));
    }
  });
});

describe("changePassword", () => {
  async function verifiedWithPassword(auth: ReturnType<typeof pwAuth>) {
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const r = await resetPassword(auth.config, { token: resetToken(auth), password: PW, ...req });
    if (!r.ok) throw new Error(r.code);
    if (!("token" in r.value)) throw new Error("the reset answered a challenge");
    const resolved = await resolveSession(auth.config, r.value.token);
    if (!resolved) throw new Error("no session");
    return resolved;
  }

  it("changes the password with the right current one and ends every other session", async () => {
    const auth = pwAuth();
    const session = await verifiedWithPassword(auth);
    const other = await createSession(auth.config, {
      userId: session.user.id,
      ip: null,
      userAgent: null,
    });
    expect(
      await changePassword(auth.config, {
        session,
        currentPassword: PW,
        newPassword: "changed password",
      }),
    ).toEqual({ ok: true, value: { ok: true } });
    expect(await resolveSession(auth.config, other.token)).toBeNull();
    expect(
      await auth.storage.findOne("session", [{ field: "id", op: "eq", value: session.session.id }]),
    ).not.toBeNull();
    expect((await signIn(auth, { password: "changed password" })).ok).toBe(true);
    expect(await signIn(auth, { password: PW })).toMatchObject({ code: "invalid_credentials" });
  });

  it("refuses a wrong or missing current password, and sets a first password with none", async () => {
    const auth = pwAuth();
    const session = await verifiedWithPassword(auth);
    expect(
      await changePassword(auth.config, {
        session,
        currentPassword: "wrong",
        newPassword: "changed password",
      }),
    ).toMatchObject({ code: "invalid_credentials" });
    expect(
      await changePassword(auth.config, { session, newPassword: "changed password" }),
    ).toMatchObject({ code: "invalid_credentials" });
    const fresh = pwAuth();
    const user = await fresh.seedUser(EMAIL);
    const s = await createSession(fresh.config, { userId: user.id, ip: null, userAgent: null });
    const resolved = await resolveSession(fresh.config, s.token);
    if (!resolved) throw new Error("no session");
    expect(
      (await changePassword(fresh.config, { session: resolved, newPassword: "first password" })).ok,
    ).toBe(true);
    expect((await signIn(fresh, { password: "first password" })).ok).toBe(true);
  });

  it("refuses an unverified user and limits to 10 per user per 15 minutes", async () => {
    const auth = pwAuth();
    const up = await signUp(auth);
    if (!up.ok) throw new Error(up.code);
    const unverified = await resolveSession(auth.config, up.value.token);
    if (!unverified) throw new Error("no session");
    expect(
      await changePassword(auth.config, {
        session: unverified,
        currentPassword: PW,
        newPassword: "changed password",
      }),
    ).toMatchObject({ code: "email_unverified", status: 403 });
    const other = pwAuth();
    const session = await verifiedWithPassword(other);
    for (let i = 0; i < 10; i++)
      await changePassword(other.config, {
        session,
        currentPassword: "wrong",
        newPassword: "changed password",
      });
    expect(
      await changePassword(other.config, {
        session,
        currentPassword: PW,
        newPassword: "changed password",
      }),
    ).toMatchObject({ code: "rate_limited" });
  });

  it("writes the new hash before the session delete", async () => {
    const auth = pwAuth();
    const session = await verifiedWithPassword(auth);
    const writes = recordNextTransaction(auth.storage);
    expect(
      (
        await changePassword(auth.config, {
          session,
          currentPassword: PW,
          newPassword: "changed password",
        })
      ).ok,
    ).toBe(true);
    expect(writes).toEqual([
      "update:password",
      // The second-factor challenges, before the session delete (plan 9f).
      "delete:verification",
      "delete:session",
      // The OAuth refresh tokens, in the same transaction (plan 9g final fix wave).
      "delete:oauthToken",
      // The user's OAuth codes (plan 9g final fix wave, round 2).
      "delete:verification",
      "delete:verification",
      "delete:verification",
    ]);
  });

  it("ends the address's pending reset links and keeps another address's link (plan 8 final review M-3)", async () => {
    const auth = pwAuth();
    const session = await verifiedWithPassword(auth);
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const pending = resetToken(auth);
    await requestPasswordReset(auth.config, { email: "bob@example.com", ip: null });
    expect(
      await changePassword(auth.config, {
        session,
        currentPassword: PW,
        newPassword: "changed password",
      }),
    ).toEqual({ ok: true, value: { ok: true } });
    expect(
      await resetPassword(auth.config, { token: pending, password: "mailbox password", ...req }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    const rows = await auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "password-reset" },
    ]);
    // The spent link of the first reset stays as a record; the other address keeps its live link.
    expect(rows.map((r) => [r.identifier, r.consumedAt === null])).toEqual([
      [EMAIL, false],
      ["bob@example.com", true],
    ]);
    expect((await signIn(auth, { password: "changed password" })).ok).toBe(true);
  });
});

/** An auth with password sign-in and the handoff on. */
function handoffAuth() {
  return makeAuth({ password: { hash: FAST }, handoff: { schemes: ["consumera://"] } });
}

/** Mints a handoff code from a live session, as the browser continue does. */
async function mintCode(auth: ReturnType<typeof makeAuth>, userId: string, sessionId: string) {
  const verifier = randomBase64Url(32);
  const start = await startHandoff(auth.config, {
    challenge: await sha256Base64Url(verifier),
    redirect: "consumera://auth",
    ip: null,
  });
  if (!start.ok) throw new Error(start.code);
  const cont = await continueHandoff(auth.config, {
    handoffId: start.value.handoffId,
    userId,
    sessionId,
  });
  if (!cont.ok) throw new Error(cont.code);
  const code = new URL(cont.value.location).searchParams.get("code") ?? "";
  return () => redeemHandoff(auth.config, { code, verifier, ip: null, userAgent: null });
}

describe("fix round 1: handoff codes end with the sessions", () => {
  it("a reset of a verified user ends the user's pending handoff codes (Important 1)", async () => {
    const auth = handoffAuth();
    await signUpAndVerify(auth);
    const mine = await signIn(auth);
    if (!mine.ok) throw new Error(mine.code);
    const control = await mintCode(auth, mine.value.user.id, mine.value.session.id);
    expect((await control()).ok).toBe(true);
    const pending = await mintCode(auth, mine.value.user.id, mine.value.session.id);
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const r = await resetPassword(auth.config, {
      token: resetToken(auth),
      password: "new password 1",
      ...req,
    });
    if (!r.ok) throw new Error(r.code);
    expect(await pending()).toMatchObject({ ok: false, code: "invalid_token" });
  });

  it("a change ends the user's pending handoff codes (Important 1)", async () => {
    const auth = handoffAuth();
    await signUpAndVerify(auth);
    const mine = await signIn(auth);
    if (!mine.ok) throw new Error(mine.code);
    const pending = await mintCode(auth, mine.value.user.id, mine.value.session.id);
    const session = await resolveSession(auth.config, mine.value.token);
    if (!session) throw new Error("no session");
    expect(
      (
        await changePassword(auth.config, {
          session,
          currentPassword: PW,
          newPassword: "changed password",
        })
      ).ok,
    ).toBe(true);
    expect(await pending()).toMatchObject({ ok: false, code: "invalid_token" });
  });
});

describe("fix round 1: the reset POST order", () => {
  /** A config whose breach check and hash seam count their calls. */
  function countingAuth() {
    const counts = { breach: 0 };
    const auth = pwAuth({
      breachCheck: async (p) => {
        counts.breach++;
        return p === "breached password";
      },
    });
    return { auth, counts };
  }

  it("answers a spent or an expired link at once, with no breach call and no hash (Important 2)", async () => {
    const { auth, counts } = countingAuth();
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const spent = resetToken(auth);
    expect(
      (await resetPassword(auth.config, { token: spent, password: "first password", ...req })).ok,
    ).toBe(true);
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const late = resetToken(auth);
    auth.clock.advance(15 * 60_000);
    counts.breach = 0;
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    try {
      expect(
        await resetPassword(auth.config, { token: spent, password: "second password", ...req }),
      ).toMatchObject({ ok: false, code: "invalid_token" });
      expect(
        await resetPassword(auth.config, { token: late, password: "second password", ...req }),
      ).toMatchObject({ ok: false, code: "token_expired" });
      expect(counts.breach).toBe(0);
      expect(derive).not.toHaveBeenCalled();
      // The positive control: one hash through the engine's own seam must
      // hit the spy, so the spy watches the object the engine derives on.
      await auth.config.password?.hash.hash("control password");
      expect(derive).toHaveBeenCalledTimes(1);
    } finally {
      derive.mockRestore();
    }
  });

  it("writes one password when two POSTs of one token run at once (Important 2)", async () => {
    const auth = pwAuth();
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const token = resetToken(auth);
    let writes = 0;
    const original = auth.storage.transaction.bind(auth.storage);
    auth.storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
      original((tx) =>
        fn({
          ...tx,
          create: (m, d) => {
            if (m === "password") writes++;
            return tx.create(m, d);
          },
          update: (m, w, d) => {
            if (m === "password") writes++;
            return tx.update(m, w, d);
          },
        }),
      );
    const [a, b] = await Promise.all([
      resetPassword(auth.config, { token, password: "password one", ...req }),
      resetPassword(auth.config, { token, password: "password two", ...req }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((x) => !x.ok)).toMatchObject({ code: "invalid_token" });
    expect(writes).toBe(1);
  });

  it("leaves the link live after a refused password (Important 2)", async () => {
    const { auth, counts } = countingAuth();
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const token = resetToken(auth);
    const live = async () =>
      (
        await auth.storage.findMany("verification", [
          { field: "purpose", op: "eq", value: "password-reset" },
        ])
      )[0]?.consumedAt;
    expect(await resetPassword(auth.config, { token, password: "short", ...req })).toMatchObject({
      code: "password_policy",
    });
    expect(await live()).toBeNull();
    expect(
      await resetPassword(auth.config, { token, password: "breached password", ...req }),
    ).toMatchObject({ code: "password_breached" });
    expect(counts.breach).toBe(1);
    expect(await live()).toBeNull();
    expect(
      (await resetPassword(auth.config, { token, password: "good password", ...req })).ok,
    ).toBe(true);
  });

  it("limits the reset POST to 20 per ip per 15 minutes", async () => {
    const auth = pwAuth();
    const unknown = `pr_${"A".repeat(43)}`;
    for (let i = 0; i < 20; i++)
      expect(
        await resetPassword(auth.config, {
          token: unknown,
          password: "x",
          ip: "6.6.6.6",
          userAgent: null,
        }),
      ).toMatchObject({ code: "invalid_token" });
    expect(
      await resetPassword(auth.config, {
        token: unknown,
        password: "x",
        ip: "6.6.6.6",
        userAgent: null,
      }),
    ).toMatchObject({ code: "rate_limited" });
  });

  it("ends the address's other reset links (Minor 2)", async () => {
    const auth = pwAuth();
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const other = resetToken(auth);
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const used = resetToken(auth);
    expect(
      (await resetPassword(auth.config, { token: used, password: "new password 1", ...req })).ok,
    ).toBe(true);
    expect(
      await resetPassword(auth.config, { token: other, password: "new password 2", ...req }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    const rows = await auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "password-reset" },
    ]);
    expect(rows.map((r) => r.consumedAt === null)).toEqual([false]);
  });
});

describe("fix round 1: the verify link of a verified user", () => {
  it("changes nothing when the owner opens a claimant's old link after a reset kept its row id (Minor 1)", async () => {
    const auth = pwAuth();
    // Reachable: a claimant signs up (the Confirm mail carries the
    // claimant's row id), the owner resets (the row keeps its id and gets
    // the owner's hash), and the owner then presses the old Confirm button.
    const claimant = await signUp(auth, { password: "claimant password" });
    if (!claimant.ok) throw new Error(claimant.code);
    const link = verifyToken(auth);
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const r = await resetPassword(auth.config, {
      token: resetToken(auth),
      password: "owner password 1",
      ...req,
    });
    if (!r.ok) throw new Error(r.code);
    const now = auth.clock.now();
    await auth.storage.create("identity", {
      id: "i1",
      userId: r.value.user.id,
      provider: "google",
      subject: "g-1",
      linkedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await auth.storage.create("passkey", {
      id: "k1",
      userId: r.value.user.id,
      credentialId: "c1",
      publicKey: "pk",
      counter: 0,
      transports: null,
      deviceType: "singleDevice",
      backedUp: false,
      name: null,
      createdAt: now,
      updatedAt: now,
    });
    const before = {
      identities: await auth.storage.findMany("identity", []),
      passkeys: await auth.storage.findMany("passkey", []),
      sessions: await auth.storage.findMany("session", []),
      user: await auth.storage.findOne("user", [{ field: "email", op: "eq", value: EMAIL }]),
    };
    const v = await verifyPasswordEmail(auth.config, { token: link, ...req });
    expect(v).toMatchObject({ ok: true, value: { signedIn: null } });
    expect(await auth.storage.findMany("identity", [])).toEqual(before.identities);
    expect(await auth.storage.findMany("passkey", [])).toEqual(before.passkeys);
    expect(await auth.storage.findMany("session", [])).toEqual(before.sessions);
    expect(
      await auth.storage.findOne("user", [{ field: "email", op: "eq", value: EMAIL }]),
    ).toEqual(before.user);
    expect((await signIn(auth, { password: "owner password 1" })).ok).toBe(true);
  });
});

describe("resendPasswordVerification (plan 8b)", () => {
  const resend = (
    auth: ReturnType<typeof makeAuth>,
    email = EMAIL,
    ip: string | null = "1.1.1.1",
  ) => resendPasswordVerification(auth.config, { email, ip });

  it("mails a new link to an unverified user with a password and ends the earlier link", async () => {
    const auth = pwAuth();
    await signUp(auth);
    const first = tokenFromMail(auth.mail.at(-1)?.text ?? "");
    expect(await resend(auth, " Ada@Example.com ")).toEqual({ ok: true, value: { sent: true } });
    expect(auth.mail).toHaveLength(2);
    expect(auth.mail[1]?.to).toBe(EMAIL);
    expect(auth.mail[1]?.subject).toBe("Confirm your email for api.example.com");
    const second = tokenFromMail(auth.mail[1]?.text ?? "");
    expect(second).not.toBe(first);
    expect(
      await auth.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "password-verify" },
      ]),
    ).toHaveLength(1);
    expect(
      await verifyPasswordEmail(auth.config, { token: first, ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    const v = await verifyPasswordEmail(auth.config, { token: second, ip: null, userAgent: null });
    expect(v.ok && v.value.user.emailVerified).toBe(true);
  });

  it("answers sent and mails nothing for an unknown, a malformed, or a verified address", async () => {
    const auth = pwAuth();
    await signUpAndVerify(auth);
    const mails = auth.mail.length;
    for (const email of ["nobody@example.com", "not an address", EMAIL])
      expect(await resend(auth, email)).toEqual({ ok: true, value: { sent: true } });
    expect(auth.mail).toHaveLength(mails);
  });

  it("limits each address to 3 and each IP to 20 per 15 minutes", async () => {
    const auth = pwAuth();
    await signUp(auth);
    for (let i = 0; i < 3; i++) expect((await resend(auth, EMAIL, `9.9.9.${i}`)).ok).toBe(true);
    expect(await resend(auth, EMAIL, "9.9.9.9")).toMatchObject({ ok: false, code: "rate_limited" });
    for (let i = 0; i < 20; i++) await resend(auth, `x${i}@example.com`, "8.8.8.8");
    expect(await resend(auth, "y@example.com", "8.8.8.8")).toMatchObject({
      code: "rate_limited",
    });
    auth.clock.advance(16 * 60_000);
    expect((await resend(auth, EMAIL, "9.9.9.9")).ok).toBe(true);
  });

  it("checks the IP key before the email key", async () => {
    const auth = pwAuth();
    const keys: string[] = [];
    const allow = auth.config.limiter.allow.bind(auth.config.limiter);
    const spy = vi.spyOn(auth.config.limiter, "allow").mockImplementation((key, window) => {
      keys.push(key);
      return allow(key, window);
    });
    await resend(auth, EMAIL, "4.4.4.4");
    spy.mockRestore();
    expect(keys).toEqual(["password-resend:ip:4.4.4.4", `password-resend:email:${EMAIL}`]);
  });

  it("answers not_found with no password config", async () => {
    expect(await resend(makeAuth())).toMatchObject({ code: "not_found", status: 404 });
  });
});
