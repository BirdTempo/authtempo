import { describe, expect, it } from "vitest";
import { passwordSignUp } from "../src/engine/password.js";
import { resolveSocialUser } from "../src/engine/social.js";
import { makeAuth, post } from "./helpers.js";
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
