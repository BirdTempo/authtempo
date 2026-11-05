import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { BASE, cookieClient } from "./helpers.js";

/** The code of the last mail to `email` that carried no link (TEST_MODE). */
async function lastCode(email: string): Promise<string> {
  const url = `${BASE}/__test/last-code?email=${encodeURIComponent(email)}`;
  const { code } = (await (await SELF.fetch(url)).json()) as {
    code: string | null;
  };
  if (!code) throw new Error("no code mailed");
  return code;
}

const wrongFor = (code: string) => (code === "000000" ? "111111" : "000000");

async function codeRow(email: string, purpose: string) {
  return env.DB.prepare(
    "SELECT value_hash, data, consumed_at FROM ta_verification WHERE purpose = ? AND identifier = ? ORDER BY created_at DESC, id DESC LIMIT 1",
  )
    .bind(purpose, email)
    .first<{ value_hash: string; data: string; consumed_at: number | null }>();
}

it("signs in by an email code on D1: the row holds a keyed hash, a wrong code counts, the right code opens a session", async () => {
  const client = cookieClient();
  const email = "otp-ada@example.com";
  expect(await client.emailOtp.request({ email })).toEqual({ ok: true, value: { sent: true } });
  const code = await lastCode(email);
  expect(code).toMatch(/^\d{6}$/);
  const row = await codeRow(email, "email-otp");
  expect(row?.value_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(row?.value_hash).not.toContain(code);
  expect(await client.emailOtp.verify({ email, code: wrongFor(code) })).toEqual({
    ok: false,
    code: "invalid_code",
    status: 400,
  });
  expect(JSON.parse((await codeRow(email, "email-otp"))?.data ?? "{}")).toEqual({ attempts: 1 });
  const v = await client.emailOtp.verify({ email, code });
  if (!v.ok) throw new Error(v.code);
  if ("twoFactor" in v.value) throw new Error("no session: a second-factor challenge");
  expect(v.value.user).toMatchObject({ email, emailVerified: true });
  const me = await SELF.fetch(`${BASE}/me`, {
    headers: { authorization: `Bearer ${v.value.token}` },
  });
  expect(await me.json()).toMatchObject({ email });
  expect(await client.emailOtp.verify({ email, code })).toEqual({
    ok: false,
    code: "invalid_code",
    status: 400,
  });
});

it("spends the code on D1 at the fifth of five parallel wrong codes, and a right code then answers too_many_attempts", async () => {
  const client = cookieClient();
  const email = "otp-cap@example.com";
  await client.emailOtp.request({ email });
  const code = await lastCode(email);
  const answers = await Promise.all(
    Array.from({ length: 5 }, () => client.emailOtp.verify({ email, code: wrongFor(code) })),
  );
  expect(answers.map((a) => (a.ok ? "ok" : a.code)).sort()).toEqual([
    "invalid_code",
    "invalid_code",
    "invalid_code",
    "invalid_code",
    "too_many_attempts",
  ]);
  const row = await codeRow(email, "email-otp");
  expect(JSON.parse(row?.data ?? "{}")).toEqual({ attempts: 5 });
  expect(row?.consumed_at).not.toBeNull();
  expect(await client.emailOtp.verify({ email, code })).toMatchObject({
    code: "too_many_attempts",
  });
});

it("resets a password by an email code on D1: a weak password spends the code, a good one ends the old session", async () => {
  const email = "otp-pat@example.com";
  const up = await SELF.fetch(`${BASE}/auth/password/sign-up`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: "correct horse battery" }),
  });
  // The uniform answer carries the sign-up proof (ruling 11 of plan 12q).
  expect(await up.json()).toEqual({
    sent: true,
    signUpProof: expect.stringMatching(/^sp_[A-Za-z0-9_-]{43}$/),
  });
  // The uniform sign-up opens no session (plan 12b); the password sign-in does.
  const signIn = await SELF.fetch(`${BASE}/auth/password/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: "correct horse battery" }),
  });
  const oldToken = ((await signIn.json()) as { token: string }).token;
  const client = cookieClient();
  expect(await client.emailOtp.requestReset({ email })).toEqual({
    ok: true,
    value: { sent: true },
  });
  const first = await lastCode(email);
  expect(await client.emailOtp.reset({ email, code: first, password: "short" })).toEqual({
    ok: false,
    code: "password_policy",
    status: 400,
  });
  expect(
    await client.emailOtp.reset({ email, code: first, password: "a new long password" }),
  ).toMatchObject({
    ok: false,
    code: "invalid_code",
  });
  await client.emailOtp.requestReset({ email });
  const r = await client.emailOtp.reset({
    email,
    code: await lastCode(email),
    password: "a new long password",
  });
  if (!r.ok) throw new Error(r.code);
  if ("twoFactor" in r.value) throw new Error("no session: a second-factor challenge");
  expect(r.value.user).toMatchObject({ email, emailVerified: true });
  const old = await SELF.fetch(`${BASE}/me`, { headers: { authorization: `Bearer ${oldToken}` } });
  expect(old.status).toBe(401);
  // The reset wrote the new password over the old one: the old one fails.
  expect(await client.password.signIn({ email, password: "correct horse battery" })).toEqual({
    ok: false,
    code: "invalid_credentials",
    status: 401,
  });
  expect((await client.password.signIn({ email, password: "a new long password" })).ok).toBe(true);
});
