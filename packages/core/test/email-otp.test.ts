import { describe, expect, it, vi } from "vitest";
import {
  codeHash,
  requestEmailOtp,
  requestResetOtp,
  verifyEmailOtp,
} from "../src/engine/email-otp.js";
import { defaultEmailOtpMail, defaultResetOtpMail } from "../src/engine/email-otp-mail.js";
import { hookRefusal } from "../src/engine/hooks.js";
import { passwordSignUp } from "../src/engine/password.js";
import { resolveSession } from "../src/engine/sessions.js";
import { hmacSha256Hex, sha256Hex } from "../src/primitives/crypto.js";
import { currentSecret } from "../src/primitives/keyring.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { makeAuth } from "./helpers.js";
import { FAST } from "./password-helpers.js";

const EMAIL = "ada@example.com";
type Auth = ReturnType<typeof makeAuth>;

/** The code in the newest mail to `to`. */
function codeFrom(auth: Auth, to = EMAIL): string {
  const text = auth.mail.findLast((m) => m.to === to)?.text ?? "";
  const m = /\b(\d{8}|\d{6})\b/.exec(text);
  if (!m?.[1]) throw new Error(`no code in the mail to ${to}`);
  return m[1];
}

/** A 6-digit code that is not `code`. */
const wrongFor = (code: string) => (code === "000000" ? "111111" : "000000");

async function request(auth: Auth, email = EMAIL): Promise<string> {
  const r = await requestEmailOtp(auth.config, { email, ip: null });
  if (!r.ok) throw new Error(r.code);
  return codeFrom(auth, email);
}

const verify = (auth: Auth, code: string, email = EMAIL, ip: string | null = null) =>
  verifyEmailOtp(auth.config, { email, code, ip, userAgent: null });

const rows = (auth: Auth) =>
  auth.storage.findMany("verification", [{ field: "purpose", op: "eq", value: "email-otp" }]);

describe("email code request (plan 9e)", () => {
  it("mails a 6-digit code and stores only its keyed hash", async () => {
    const auth = makeAuth();
    expect(
      await requestEmailOtp(auth.config, { email: "  Ada@Example.COM ", ip: "1.1.1.1" }),
    ).toEqual({ ok: true, value: { sent: true } });
    const code = codeFrom(auth);
    expect(code).toMatch(/^\d{6}$/);
    expect(auth.mail).toEqual([
      {
        to: EMAIL,
        subject: "Your sign-in code for api.example.com",
        text: `Your code is ${code}. It is valid for 10 minutes. If you did not ask for it, ignore this message.`,
      },
    ]);
    const [row] = await rows(auth);
    expect(row).toMatchObject({ identifier: EMAIL, consumedAt: null, data: { attempts: 0 } });
    expect(row?.expiresAt.getTime()).toBe(auth.clock.now().getTime() + 10 * 60_000);
    expect(row?.valueHash).toBe(
      await codeHash(currentSecret(auth.config.keyring), row?.id ?? "", code),
    );
    expect(JSON.stringify(await auth.storage.findMany("verification", []))).not.toContain(code);
  });

  it("answers sent and writes nothing for a malformed address", async () => {
    const auth = makeAuth();
    expect(await requestEmailOtp(auth.config, { email: "not-an-address", ip: null })).toEqual({
      ok: true,
      value: { sent: true },
    });
    expect(auth.mail).toEqual([]);
    expect(await auth.storage.findMany("verification", [])).toEqual([]);
  });

  it("makes 8 digits with length 8, and sends the app's mail to the code's address", async () => {
    const auth = makeAuth({
      emailOtp: {
        length: 8,
        mail: ({ code, ttlMinutes }) => ({
          to: "other@example.com",
          subject: "Code",
          text: `Code ${code} for ${ttlMinutes} min`,
        }),
      },
    });
    await requestEmailOtp(auth.config, { email: EMAIL, ip: null });
    expect(auth.mail).toEqual([
      { to: EMAIL, subject: "Code", text: expect.stringMatching(/^Code \d{8} for 10 min$/) },
    ]);
  });

  it("limits requests to 3 per address and 20 per IP per 15 minutes", async () => {
    const auth = makeAuth();
    for (let i = 0; i < 3; i++)
      expect((await requestEmailOtp(auth.config, { email: EMAIL, ip: `2.2.2.${i}` })).ok).toBe(
        true,
      );
    expect(await requestEmailOtp(auth.config, { email: EMAIL, ip: "2.2.2.9" })).toMatchObject({
      ok: false,
      code: "rate_limited",
      status: 429,
    });
    for (let i = 0; i < 20; i++)
      expect(
        (await requestEmailOtp(auth.config, { email: `u${i}@example.com`, ip: "3.3.3.3" })).ok,
      ).toBe(true);
    expect(
      await requestEmailOtp(auth.config, { email: "u99@example.com", ip: "3.3.3.3" }),
    ).toMatchObject({ code: "rate_limited" });
  });

  it("limits requests to 20 per address per 24 hours, for both purposes together; the twenty-first after 24 hours is sent", async () => {
    const auth = makeAuth({ password: { hash: FAST } });
    const start = auth.clock.now().getTime();
    const send = (i: number) =>
      (i % 2 === 0 ? requestEmailOtp : requestResetOtp)(auth.config, {
        email: EMAIL,
        ip: `6.6.6.${i}`,
      });
    for (let i = 0; i < 20; i++) {
      // A fresh 15-minute window every 3 requests, so only the daily key can refuse.
      if (i > 0 && i % 3 === 0) auth.clock.advance(15 * 60_000);
      expect((await send(i)).ok).toBe(true);
    }
    auth.clock.advance(15 * 60_000);
    expect(await send(20)).toMatchObject({ ok: false, code: "rate_limited", status: 429 });
    expect(auth.mail).toHaveLength(20);
    auth.clock.advance(start + 86_400_000 - auth.clock.now().getTime());
    expect(await send(21)).toEqual({ ok: true, value: { sent: true } });
    expect(auth.mail).toHaveLength(21);
  });

  it("keeps one live code: a second request makes the first code answer invalid_code (Review Focus 2)", async () => {
    const auth = makeAuth();
    const first = await request(auth);
    const second = await request(auth);
    expect((await rows(auth)).filter((r) => r.consumedAt === null)).toHaveLength(1);
    // One time in a million the two codes are equal; the first is then the live one.
    if (first !== second)
      expect(await verify(auth, first)).toMatchObject({ ok: false, code: "invalid_code" });
    expect((await verify(auth, second)).ok).toBe(true);
  });

  it("says 1 minute for a ttl of 1 and 10 minutes for 10 in both default mails (M-6)", () => {
    const at = (ttlMinutes: number) => ({
      email: EMAIL,
      code: "123456",
      ttlMinutes,
      appName: "App",
    });
    expect(defaultEmailOtpMail(at(1)).text).toBe(
      "Your code is 123456. It is valid for 1 minute. If you did not ask for it, ignore this message.",
    );
    expect(defaultResetOtpMail(at(1)).text).toBe(
      "Your password reset code for App is 123456. It is valid for 1 minute.",
    );
    expect(defaultEmailOtpMail(at(10)).text).toContain("It is valid for 10 minutes.");
    expect(defaultResetOtpMail(at(10)).text).toContain("It is valid for 10 minutes.");
  });

  it("answers not_found for both operations with emailOtp: false", async () => {
    const auth = makeAuth({ emailOtp: false });
    expect(await requestEmailOtp(auth.config, { email: EMAIL, ip: null })).toMatchObject({
      ok: false,
      code: "not_found",
      status: 404,
    });
    expect(await verify(auth, "123456")).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("email code verify (plan 9e)", () => {
  it("signs in with a right code: a verified user and a session; the same code then answers invalid_code", async () => {
    const auth = makeAuth();
    const code = await request(auth);
    const v = await verify(auth, code);
    if (!v.ok) throw new Error(v.code);
    if (!("token" in v.value)) throw new Error("the sign-in answered a challenge");
    expect(v.value.user).toMatchObject({ email: EMAIL, emailVerified: true });
    expect((await resolveSession(auth.config, v.value.token))?.session.id).toBe(v.value.session.id);
    expect(await verify(auth, code)).toEqual({ ok: false, code: "invalid_code", status: 400 });
  });

  it("counts a wrong code and answers invalid_code", async () => {
    const auth = makeAuth();
    const code = await request(auth);
    expect(await verify(auth, wrongFor(code))).toEqual({
      ok: false,
      code: "invalid_code",
      status: 400,
    });
    const [row] = await rows(auth);
    expect(row).toMatchObject({ consumedAt: null, data: { attempts: 1 } });
  });

  it("spends the code at the fifth wrong guess; the sixth and a right code answer too_many_attempts until a new request (Review Focus 1)", async () => {
    const auth = makeAuth();
    const code = await request(auth);
    const wrong = wrongFor(code);
    for (let i = 0; i < 4; i++)
      expect(await verify(auth, wrong)).toMatchObject({ code: "invalid_code" });
    expect(await verify(auth, wrong)).toEqual({
      ok: false,
      code: "too_many_attempts",
      status: 400,
    });
    expect(await verify(auth, wrong)).toMatchObject({ code: "too_many_attempts" });
    expect(await verify(auth, code)).toMatchObject({ code: "too_many_attempts" });
    const [row] = await rows(auth);
    expect(row?.consumedAt).not.toBeNull();
    expect(row?.data).toEqual({ attempts: 5 });
    expect(await auth.storage.findMany("session", [])).toEqual([]);
    expect((await verify(auth, await request(auth))).ok).toBe(true);
  });

  it("takes maxAttempts from the config", async () => {
    const auth = makeAuth({ emailOtp: { maxAttempts: 3 } });
    const wrong = wrongFor(await request(auth));
    for (let i = 0; i < 2; i++)
      expect(await verify(auth, wrong)).toMatchObject({ code: "invalid_code" });
    expect(await verify(auth, wrong)).toMatchObject({ code: "too_many_attempts" });
  });

  it("counts every guess of a parallel burst: five wrong codes at once spend the code", async () => {
    const auth = makeAuth();
    const wrong = wrongFor(await request(auth));
    const answers = await Promise.all(Array.from({ length: 5 }, () => verify(auth, wrong)));
    expect(answers.map((a) => (a.ok ? "ok" : a.code)).sort()).toEqual([
      "invalid_code",
      "invalid_code",
      "invalid_code",
      "invalid_code",
      "too_many_attempts",
    ]);
    const [row] = await rows(auth);
    expect(row?.data).toEqual({ attempts: 5 });
    expect(row?.consumedAt).not.toBeNull();
  });

  it("spends every live code of the address at the cap, so an older code from a parallel request gets no more guesses (M-3)", async () => {
    const auth = makeAuth();
    await Promise.all([
      requestEmailOtp(auth.config, { email: EMAIL, ip: null }),
      requestEmailOtp(auth.config, { email: EMAIL, ip: null }),
    ]);
    // Two parallel requests leave two live codes: the state this test needs.
    expect((await rows(auth)).filter((r) => r.consumedAt === null)).toHaveLength(2);
    const codes = auth.mail.map((m) => /\b(\d{6})\b/.exec(m.text)?.[1] ?? "");
    const wrong = ["000000", "111111", "222222"].find((c) => !codes.includes(c)) ?? "";
    for (let i = 0; i < 4; i++)
      expect(await verify(auth, wrong)).toMatchObject({ code: "invalid_code" });
    expect(await verify(auth, wrong)).toMatchObject({ code: "too_many_attempts" });
    expect((await rows(auth)).filter((r) => r.consumedAt === null)).toEqual([]);
    for (const code of codes)
      expect(await verify(auth, code)).toMatchObject({ code: "too_many_attempts" });
    expect(await auth.storage.findMany("session", [])).toEqual([]);
  });

  it("answers too_many_attempts after the cap when a second request of the same millisecond spent the first code (plan 9h, Review Focus 3)", async () => {
    // makeAuth's clock does not move by itself, so both requests below run in
    // one millisecond. The id is random inside its millisecond, so before plan
    // 9h about half of these addresses read the spent first row after the cap
    // and answered invalid_code. 16 addresses make a pass by chance 1 in 65,536.
    const auth = makeAuth();
    for (let i = 0; i < 16; i++) {
      const email = `same-ms-${i}@example.com`;
      // An IP per address: the per-IP request and verify limits would stop 16 addresses.
      const ip = `10.0.0.${i}`;
      const ask = async () => {
        const r = await requestEmailOtp(auth.config, { email, ip });
        if (!r.ok) throw new Error(r.code);
        return codeFrom(auth, email);
      };
      const first = await ask();
      const second = await ask();
      const [older, newer] = (
        await auth.storage.findMany("verification", [
          { field: "identifier", op: "eq", value: email },
        ])
      ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      // The second row is strictly newer than the row its request spent.
      expect(newer && older && newer.createdAt.getTime() - older.createdAt.getTime()).toBe(1);
      const wrong = ["000000", "111111", "222222"].find((c) => c !== first && c !== second) ?? "";
      for (let n = 0; n < 4; n++)
        expect(await verify(auth, wrong, email, ip)).toMatchObject({ code: "invalid_code" });
      expect(await verify(auth, wrong, email, ip)).toMatchObject({ code: "too_many_attempts" });
      expect({
        email,
        first: await verify(auth, first, email, ip),
        second: await verify(auth, second, email, ip),
      }).toEqual({
        email,
        first: { ok: false, code: "too_many_attempts", status: 400 },
        second: { ok: false, code: "too_many_attempts", status: 400 },
      });
    }
    expect(await auth.storage.findMany("session", [])).toEqual([]);
  });

  it("bounds the count to maxAttempts + 1 rounds when an update never matches, and logs (I-1)", async () => {
    const inner = createMemoryAdapter();
    let updates = 0;
    const storage: StorageAdapter = {
      ...inner,
      update: async () => {
        updates += 1;
        // A guard: without the bound the loop never ends; fail instead of hanging.
        if (updates > 100) throw new Error("countMiss did not stop");
        return 0;
      },
    };
    const auth = makeAuth({ storage });
    const wrong = wrongFor(await request(auth));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      updates = 0;
      expect(await verify(auth, wrong)).toEqual({ ok: false, code: "invalid_code", status: 400 });
      expect(updates).toBe(6);
      const [row] = await inner.findMany("verification", []);
      expect(errors).toHaveBeenCalledWith("authtempo: email code count gave up", row?.id);
    } finally {
      errors.mockRestore();
    }
  });

  it("answers invalid_code for an expired code, right or wrong, and counts no guess", async () => {
    const auth = makeAuth();
    const code = await request(auth);
    auth.clock.advance(10 * 60_000);
    expect(await verify(auth, wrongFor(code))).toMatchObject({ code: "invalid_code" });
    expect(await verify(auth, code)).toMatchObject({ code: "invalid_code" });
    const [row] = await rows(auth);
    expect(row).toMatchObject({ consumedAt: null, data: { attempts: 0 } });
  });

  it("answers invalid_code for an address with no code, and writes nothing", async () => {
    const auth = makeAuth();
    expect(await verify(auth, "123456", "nobody@example.com")).toEqual({
      ok: false,
      code: "invalid_code",
      status: 400,
    });
    expect(await verify(auth, "123456", "not-an-address")).toMatchObject({
      code: "invalid_code",
    });
    expect(await auth.storage.findMany("verification", [])).toEqual([]);
    expect(await auth.storage.findMany("user", [])).toEqual([]);
  });

  it("signs in once when two right verifies race", async () => {
    const auth = makeAuth();
    const code = await request(auth);
    const [a, b] = await Promise.all([verify(auth, code), verify(auth, code)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ code: "invalid_code" });
    expect(await auth.storage.findMany("session", [])).toHaveLength(1);
  });

  it("applies the claim rule: an unverified claimant's session and password go, and the proof opens a session (Review Focus 3)", async () => {
    const auth = makeAuth({ password: { hash: FAST } });
    const up = await passwordSignUp(auth.config, {
      email: EMAIL,
      password: "correct horse battery",
      ip: null,
      userAgent: null,
    });
    if (!up.ok) throw new Error(up.code);
    const v = await verify(auth, await request(auth));
    if (!v.ok) throw new Error(v.code);
    if (!("token" in v.value)) throw new Error("the sign-in answered a challenge");
    expect(v.value.user).toMatchObject({ id: up.value.user.id, emailVerified: true });
    expect((await auth.storage.findMany("session", [])).map((s) => s.id)).toEqual([
      v.value.session.id,
    ]);
    expect(await auth.storage.findMany("password", [])).toEqual([]);
  });

  it("runs the session hooks with via email_otp; a refusal spends the code and writes no user", async () => {
    const vias: string[] = [];
    let refuse = false;
    const auth = makeAuth({
      hooks: {
        session: {
          beforeCreate(e) {
            vias.push(e.via);
            if (refuse) throw hookRefusal("Not now.");
          },
          afterCreate(e) {
            vias.push(`after:${e.via}`);
          },
        },
      },
    });
    expect((await verify(auth, await request(auth))).ok).toBe(true);
    expect(vias).toEqual(["email_otp", "after:email_otp"]);
    refuse = true;
    const code = await request(auth, "bea@example.com");
    expect(await verify(auth, code, "bea@example.com")).toEqual({
      ok: false,
      code: "hook_refused",
      status: 403,
      message: "Not now.",
    });
    expect(
      await auth.storage.findOne("user", [{ field: "email", op: "eq", value: "bea@example.com" }]),
    ).toBeNull();
    expect(await verify(auth, code, "bea@example.com")).toMatchObject({ code: "invalid_code" });
  });

  it("gives nothing to a reader of the table without the secret (Review Focus)", async () => {
    const auth = makeAuth();
    const code = await request(auth);
    const [row] = await rows(auth);
    const id = row?.id ?? "";
    expect(row?.valueHash).toBe(
      await hmacSha256Hex(currentSecret(auth.config.keyring), `${id}:${code}`),
    );
    expect(row?.valueHash).not.toBe(
      await hmacSha256Hex("another secret of 32 characters!", `${id}:${code}`),
    );
    expect(row?.valueHash).not.toBe(await sha256Hex(code));
    expect(row?.valueHash).not.toBe(await sha256Hex(`${id}:${code}`));
  });

  it("limits verifies to 10 per address and 30 per IP per 15 minutes", async () => {
    const auth = makeAuth();
    for (let i = 0; i < 10; i++) await verify(auth, "000000", EMAIL, `4.4.4.${i}`);
    expect(await verify(auth, "000000", EMAIL, "4.4.4.99")).toMatchObject({
      code: "rate_limited",
      status: 429,
    });
    for (let i = 0; i < 30; i++) await verify(auth, "000000", `v${i}@example.com`, "5.5.5.5");
    expect(await verify(auth, "000000", "v99@example.com", "5.5.5.5")).toMatchObject({
      code: "rate_limited",
    });
  });
});
