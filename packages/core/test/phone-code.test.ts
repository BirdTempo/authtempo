import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhoneConfig } from "../src/config.js";
import { consumeCode } from "../src/engine/email-otp.js";
import {
  checkPhoneCode,
  type PhoneCodePurpose,
  phoneRequestGate,
  sendPhoneCode,
} from "../src/engine/phone.js";
import { hmacSha256Hex } from "../src/primitives/crypto.js";
import { currentSecret } from "../src/primitives/keyring.js";
import type { SmsPort } from "../src/seams/sms.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { makeAuth } from "./helpers.js";

const A = "+14155550100";
const B = "+14155550101";

/** Core with `phone` on the memory limiter, for tests (deviation 5 of plan 12i). */
function phoneAuth(phone: Partial<PhoneConfig> = {}) {
  const sms = createRecordingSms();
  const auth = makeAuth({
    phone: { sms, regions: ["+1", "+44"], isolateLimiter: "allow", ...phone },
  });
  return { ...auth, sms };
}
type PhoneAuth = ReturnType<typeof phoneAuth>;

function send(auth: PhoneAuth, to: string, purpose: PhoneCodePurpose = "phone-otp", id = to) {
  return sendPhoneCode(auth.config, { purpose, identifier: id, to, data: {} });
}

function check(
  auth: PhoneAuth,
  identifier: string,
  code: string,
  purpose: PhoneCodePurpose = "phone-otp",
  ip: string | null = "203.0.113.9",
) {
  return checkPhoneCode(auth.config, { purpose, identifier, code, ip });
}

/** The code of the last text: the default message starts with it. */
function lastCode(auth: PhoneAuth): string {
  const text = auth.sms.sent.at(-1)?.text ?? "";
  const code = /^(\d+) is your /.exec(text)?.[1];
  if (code === undefined) throw new Error(`no code in the text: ${text}`);
  return code;
}

/** A code of the same length that is not `code`. */
function wrong(code: string): string {
  return code.replace(/^./, (d) => String((Number(d) + 1) % 10));
}

function rows(auth: PhoneAuth) {
  return auth.storage.findMany("verification", []);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the phone code (plan 12i Task 4, spec 32 item 4)", () => {
  it("draws a code as the email code does and keys it under the current secret version", async () => {
    const auth = phoneAuth();
    expect(await send(auth, A)).toBe("sent");
    const code = lastCode(auth);
    expect(code).toMatch(/^\d{6}$/);
    expect(auth.sms.sent).toEqual([
      { to: A, text: `${code} is your api.example.com code. It expires in 5 minutes.` },
    ]);
    const [row] = await rows(auth);
    if (!row) throw new Error("no row");
    expect(row).toMatchObject({
      purpose: "phone-otp",
      identifier: A,
      consumedAt: null,
      data: { attempts: 0 },
      secretVersion: auth.config.keyring.current,
      // A short life: 5 minutes by default.
      expiresAt: new Date(auth.clock.now().getTime() + 5 * 60_000),
    });
    expect(row.valueHash).toBe(
      await hmacSha256Hex(currentSecret(auth.config.keyring), `${row.id}:${code}`),
    );
    const long = phoneAuth({ length: 8 });
    await send(long, A);
    expect(lastCode(long)).toMatch(/^\d{8}$/);
  });

  it("keeps one live code per number", async () => {
    const auth = phoneAuth();
    await send(auth, A);
    const first = lastCode(auth);
    await send(auth, A);
    const second = lastCode(auth);
    const live = (await rows(auth)).filter((r) => r.consumedAt === null);
    expect(live).toHaveLength(1);
    if (first !== second)
      expect(await check(auth, A, first)).toMatchObject({ ok: false, code: "invalid_code" });
    expect(await check(auth, A, second)).toMatchObject({ ok: true });
  });

  it("uses a code once and only within its life", async () => {
    const auth = phoneAuth();
    await send(auth, A);
    const code = lastCode(auth);
    const checked = await check(auth, A, code);
    if (!checked.ok) throw new Error(checked.code);
    expect(await consumeCode(auth.storage, checked.value, auth.clock.now())).toMatchObject({
      ok: true,
    });
    expect(await check(auth, A, code)).toMatchObject({ ok: false, code: "invalid_code" });
    await send(auth, A);
    const late = lastCode(auth);
    auth.clock.advance(5 * 60_000);
    expect(await check(auth, A, late)).toMatchObject({ ok: false, code: "invalid_code" });
  });

  it("caps the guesses by compare-and-set", async () => {
    const auth = phoneAuth({ maxAttempts: 3 });
    await send(auth, A);
    const code = lastCode(auth);
    expect(await check(auth, A, wrong(code))).toMatchObject({ code: "invalid_code" });
    // Two parallel wrong guesses at attempts 1: both count, so the row reaches 3 and is spent.
    await Promise.all([check(auth, A, wrong(code)), check(auth, A, wrong(code))]);
    const [row] = await rows(auth);
    expect(row?.data).toEqual({ attempts: 3 });
    expect(row?.consumedAt).not.toBeNull();
    // The fourth guess answers too_many_attempts even with the right code.
    expect(await check(auth, A, code)).toMatchObject({ ok: false, code: "too_many_attempts" });
  });

  it("binds a code to its number and purpose", async () => {
    const auth = phoneAuth();
    await send(auth, A);
    const signIn = lastCode(auth);
    // A sign-in code of A is no add code of A, and no sign-in code of B (ASVS 5.0.0 6.6.2).
    expect(await check(auth, A, signIn, "phone-add-otp")).toMatchObject({ code: "invalid_code" });
    expect(await check(auth, B, signIn)).toMatchObject({ code: "invalid_code" });
    await send(auth, B, "phone-add-otp", "user-1");
    const add = lastCode(auth);
    expect(await check(auth, B, add)).toMatchObject({ code: "invalid_code" });
    expect(await check(auth, "user-2", add, "phone-add-otp")).toMatchObject({
      code: "invalid_code",
    });
    expect(await check(auth, A, signIn)).toMatchObject({ ok: true });
    expect(await check(auth, "user-1", add, "phone-add-otp")).toMatchObject({ ok: true });
    // A sign-in code goes only to its own number.
    await expect(send(auth, B, "phone-otp", A)).rejects.toThrow(
      "a phone-otp code goes to its own number",
    );
  });

  it("refuses a number outside every region", async () => {
    const auth = phoneAuth();
    expect(await send(auth, "+33612345678")).toBe("phone_region");
    expect(await phoneRequestGate(auth.config, { phone: "+33612345678", ip: null })).toEqual({
      ok: false,
      code: "phone_region",
      status: 400,
    });
    expect(auth.sms.sent).toEqual([]);
    expect(await rows(auth)).toEqual([]);
  });

  it("refuses a number that is not E.164", async () => {
    const auth = phoneAuth();
    for (const to of ["4155550100", "+04155550100", "+1415555010a", "+1415", "+1 415 555 0100"]) {
      expect(await send(auth, to), to).toBe("phone_invalid");
      expect(await phoneRequestGate(auth.config, { phone: to, ip: null }), to).toMatchObject({
        code: "phone_invalid",
        status: 400,
      });
    }
    expect(auth.sms.sent).toEqual([]);
    expect(await rows(auth)).toEqual([]);
  });

  it("counts the daily cap before the send", async () => {
    const calls: string[] = [];
    let answer: "sent" | "unavailable" = "unavailable";
    const sms: SmsPort = {
      send: async ({ to }) => {
        calls.push(to);
        return answer;
      },
    };
    const auth = phoneAuth({ sms, dailyCap: 2 });
    // A send that the port answers "unavailable" still counts.
    expect(await send(auth, A)).toBe("unavailable");
    answer = "sent";
    expect(await send(auth, B)).toBe("sent");
    expect(await send(auth, "+14155550102")).toBe("capped");
    expect(calls).toEqual([A, B]);
    // A capped send writes no row.
    expect((await rows(auth)).map((r) => r.identifier).sort()).toEqual([A, B]);
    // The cap is one count for every number and purpose, for 24 hours.
    expect(await send(auth, A, "phone-add-otp", "user-1")).toBe("capped");
    auth.clock.advance(24 * 60 * 60_000);
    expect(await send(auth, "+14155550102")).toBe("sent");
  });

  it("treats a throw of the port as unavailable and writes one line with no number", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const sms: SmsPort = {
      send: async ({ to, text }) => {
        throw new Error(`supplier refused ${to}: ${text}`);
      },
    };
    const auth = phoneAuth({ sms });
    expect(await send(auth, A)).toBe("unavailable");
    expect(errors.mock.calls).toEqual([["authtempo: the SMS port threw", "Error"]]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("+");
  });

  it("sends no code outside text", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const auth = phoneAuth();
    const answer = await send(auth, A);
    const code = lastCode(auth);
    expect(answer).toBe("sent");
    expect(JSON.stringify(await rows(auth))).not.toContain(code);
    const checked = await check(auth, A, code);
    expect(checked.ok).toBe(true);
    expect(JSON.stringify(checked)).not.toContain(`"${code}"`);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(code);
    expect(auth.mail).toEqual([]);
  });

  it("applies the request limits per IP and per number before any branch", async () => {
    const auth = phoneAuth();
    const gate = (phone: string, ip: string) => phoneRequestGate(auth.config, { phone, ip });
    // phone-otp:ip, 10 per 15 minutes.
    for (let i = 0; i < 10; i++)
      expect(await gate(`+1415555${String(200 + i).padStart(4, "0")}`, "198.51.100.1")).toEqual({
        ok: true,
        value: `+1415555${String(200 + i).padStart(4, "0")}`,
      });
    expect(await gate(A, "198.51.100.1")).toMatchObject({ code: "rate_limited", status: 429 });
    // phone-otp:phone, 3 per 15 minutes, from three other addresses.
    for (const ip of ["198.51.100.2", "198.51.100.3", "198.51.100.4"])
      expect(await gate(A, ip)).toMatchObject({ ok: true });
    expect(await gate(A, "198.51.100.5")).toMatchObject({ code: "rate_limited" });
    // phone-otp:phone-day, 10 per 24 hours: 3 more in each of the next windows.
    let n = 10;
    for (let window = 0; window < 3; window++) {
      auth.clock.advance(15 * 60_000);
      for (let i = 0; i < 3; i++) await gate(A, `198.51.101.${n++}`);
    }
    // 3 + 3 + 3 + 3 = 12 calls, and the 11th and 12th were refused by the day key.
    auth.clock.advance(15 * 60_000);
    expect(await gate(A, "198.51.102.1")).toMatchObject({ code: "rate_limited" });
    expect(await gate(B, "198.51.102.2")).toMatchObject({ ok: true });
    // A refused form spends no per-number key.
    expect(await gate("+1415", "198.51.102.3")).toMatchObject({ code: "phone_invalid" });
  });

  it("checks the captcha after the per-IP limit and before the per-number keys", async () => {
    const verified: string[] = [];
    const sms = createRecordingSms();
    const auth = makeAuth({
      phone: { sms, regions: ["+1"], isolateLimiter: "allow" },
      captcha: {
        port: {
          verify: async ({ token, flow }) => {
            verified.push(flow);
            return token === "pass" ? "pass" : "fail";
          },
        },
        flows: ["phone-request"],
      },
    });
    const gate = (captchaToken: string | null, ip: string) =>
      phoneRequestGate(auth.config, { phone: A, ip, captchaToken });
    // Four refused requests from four addresses spend no per-number key of A.
    for (let i = 0; i < 4; i++)
      expect(await gate(i % 2 ? null : "bad", `198.51.104.${i}`)).toMatchObject({
        code: i % 2 ? "captcha_required" : "captcha_failed",
      });
    expect(await gate("pass", "198.51.104.9")).toMatchObject({ ok: true });
    expect(verified).toEqual(["phone-request", "phone-request", "phone-request"]);
  });

  it("applies the verify limits per IP and per number", async () => {
    const auth = phoneAuth();
    // phone-verify:ip, 30 per 15 minutes.
    for (let i = 0; i < 30; i++)
      expect(
        await check(
          auth,
          `+1415555${String(300 + i).padStart(4, "0")}`,
          "000000",
          "phone-otp",
          "198.51.100.7",
        ),
      ).toMatchObject({ code: "invalid_code" });
    expect(await check(auth, A, "000000", "phone-otp", "198.51.100.7")).toMatchObject({
      code: "rate_limited",
      status: 429,
    });
    // phone-verify:phone, 10 per 15 minutes, from other addresses.
    for (let i = 0; i < 10; i++)
      expect(await check(auth, B, "000000", "phone-otp", `198.51.103.${i}`)).toMatchObject({
        code: "invalid_code",
      });
    expect(await check(auth, B, "000000", "phone-otp", "198.51.103.99")).toMatchObject({
      code: "rate_limited",
    });
  });

  it("answers invalid_code for a sign-in check of a number that is not E.164, with no per-number key", async () => {
    const auth = phoneAuth();
    const long = `+1${"5".repeat(400)}`;
    for (let i = 0; i < 12; i++)
      expect(await check(auth, long, "000000", "phone-otp", `198.51.105.${i}`)).toMatchObject({
        code: "invalid_code",
      });
  });

  it("answers not_found and sends nothing with phone off", async () => {
    const auth = makeAuth();
    expect(
      await sendPhoneCode(auth.config, { purpose: "phone-otp", identifier: A, to: A, data: {} }),
    ).toBe("unavailable");
    expect(
      await checkPhoneCode(auth.config, {
        purpose: "phone-otp",
        identifier: A,
        code: "1",
        ip: null,
      }),
    ).toMatchObject({ code: "not_found" });
    expect(await phoneRequestGate(auth.config, { phone: A, ip: null })).toMatchObject({
      code: "not_found",
    });
  });
});
