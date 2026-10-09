import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../src/config.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { passwordSignIn, passwordSignUp } from "../src/engine/password.js";
import { resolveSocialUser } from "../src/engine/social.js";
import { claimEmail, ensureEmailIdentity } from "../src/engine/users.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { createPbkdf2PasswordHash, type PasswordHashSeam } from "../src/seams/password-hash.js";
import { makeAuth, post, tokenFromMail } from "./helpers.js";
import { FAST, pwAuth, pwHandle } from "./password-helpers.js";

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
    dummy: inner.dummy,
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
  return passwordSignIn(auth.config, {
    email: EMAIL,
    password: PW,
    ip: "1.1.1.1",
    userAgent: "ua",
    ...over,
  });
}

/** The same storage, clock, and limiter, with another hash seam: a deployer who changed the cost. */
function withSeam(config: ResolvedConfig, hash: PasswordHashSeam): ResolvedConfig {
  if (!config.password) throw new Error("no password config");
  return { ...config, password: { ...config.password, hash } };
}

/**
 * A reachable verified user with a password: the sign-up, then what the
 * sign-up verify link does in one transaction (claim the email and keep
 * this password row, then add the email identity).
 */
async function signUpAndVerify(auth: ReturnType<typeof makeAuth>) {
  const up = await signUp(auth);
  if (!up.ok) throw new Error(up.code);
  const [row] = await auth.storage.findMany("password", []);
  if (!row) throw new Error("no password row");
  const now = auth.clock.now();
  await auth.storage.transaction(async (tx) => {
    await claimEmail(tx, up.value.user.id, { passwordId: row.id }, now);
    await ensureEmailIdentity(tx, up.value.user.id, EMAIL, now);
  });
  return row;
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
    expect(calls.verify.slice(0, 3)).toEqual([FAST.dummy, FAST.dummy, FAST.dummy]);
    // The dummy is made at seam construction: no sign-in runs a hash.
    expect(calls.hash).toBe(hashes);
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

  it("limits to 10 per email and to 20 per ip per 15 minutes", async () => {
    const auth = pwAuth();
    await signUp(auth);
    for (let i = 0; i < 10; i++)
      expect(
        await signIn(auth, {
          email: i % 2 ? EMAIL : " ADA@example.com",
          password: "wrong password",
          ip: `9.9.9.${i}`,
        }),
      ).toMatchObject({ code: "invalid_credentials" });
    expect(await signIn(auth, { ip: "9.9.9.99" })).toMatchObject({
      code: "rate_limited",
      status: 429,
    });
    auth.clock.advance(900 * 1000);
    expect((await signIn(auth, { ip: "9.9.9.99" })).ok).toBe(true);
    const other = pwAuth();
    for (let i = 0; i < 20; i++)
      expect(await signIn(other, { email: `x${i}@example.com`, ip: "2.2.2.2" })).toMatchObject({
        code: "invalid_credentials",
      });
    expect(await signIn(other, { email: "x20@example.com", ip: "2.2.2.2" })).toMatchObject({
      code: "rate_limited",
    });
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

  it("keeps a hash that a concurrent write put on the row between the verify and the rehash", async () => {
    const auth = pwAuth();
    const before = await signUpAndVerify(auth);
    // A concurrent write (a reset, for example) sets a new hash after this sign-in read the row.
    const other = await FAST.hash("the new password");
    const { seam } = counting(createPbkdf2PasswordHash({ iterations: 2000 }), async () => {
      await auth.storage.update("password", [{ field: "id", op: "eq", value: before.id }], {
        hash: other,
      });
    });
    const r = await passwordSignIn(withSeam(auth.config, seam), {
      email: EMAIL,
      password: PW,
      ip: null,
      userAgent: null,
    });
    expect(r.ok).toBe(true);
    expect(await auth.storage.findMany("password", [])).toMatchObject([
      { id: before.id, hash: other },
    ]);
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
