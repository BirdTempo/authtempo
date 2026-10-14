import { describe, expect, it } from "vitest";
import { requestResetOtp, resetPasswordWithOtp } from "../src/engine/email-otp.js";
import {
  changePassword,
  passwordSignIn,
  requestPasswordReset,
  resetPassword,
} from "../src/engine/password.js";
import { resolveSession } from "../src/engine/sessions.js";
import { newId } from "../src/primitives/ids.js";
import { APP_ORIGIN, BASE_URL, get, makeAuth, post, tokenFromMail } from "./helpers.js";
import { FAST, pwAuth, pwHandle, sessionOnly, signUpAndVerify } from "./password-helpers.js";

const down = async () => "unavailable" as const;
const PW = "correct horse battery";

/** Status, headers, and body: the full answer, so two answers compare byte for byte. */
async function wire(res: Response) {
  return { status: res.status, headers: [...res.headers.entries()], body: await res.text() };
}

describe("a breach check that cannot answer (plan 12b)", () => {
  it("refuses the sign-up with 503 breach_check_unavailable", async () => {
    const { auth } = pwHandle({ hash: FAST, breachCheck: down });
    const res = await auth.handle(
      post("/auth/password/sign-up", { email: "a@example.com", password: PW }),
    );
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 503,
      body: { error: "breach_check_unavailable" },
    });
  });

  it("answers the same bytes for a known and an unknown address, in both sign-up answers", async () => {
    for (const uniformSignUp of [true, false]) {
      const h = pwHandle({ hash: FAST, breachCheck: down, uniformSignUp });
      const now = h.clock.now();
      await h.storage.create("user", {
        id: newId(now),
        email: "known@example.com",
        emailVerified: true,
        name: null,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
      const known = await wire(
        await h.auth.handle(
          post("/auth/password/sign-up", { email: "known@example.com", password: PW }),
        ),
      );
      const unknown = await wire(
        await h.auth.handle(
          post("/auth/password/sign-up", { email: "unknown@example.com", password: PW }),
        ),
      );
      expect(known.status).toBe(503);
      expect(unknown).toEqual(known);
      expect(h.mails).toEqual([]);
    }
  });

  it("keeps the reset link usable, so the person tries again after the outage", async () => {
    let answer: boolean | "unavailable" = "unavailable";
    const auth = pwAuth({ breachCheck: async () => answer });
    await auth.seedUser("a@example.com");
    await requestPasswordReset(auth.config, { email: "a@example.com", ip: null });
    const token = tokenFromMail(auth.mail.at(-1)?.text ?? "");
    const input = { token, password: PW, ip: null, userAgent: null };
    expect(await resetPassword(auth.config, input)).toMatchObject({
      ok: false,
      code: "breach_check_unavailable",
      status: 503,
    });
    const row = await auth.storage.findOne("verification", [
      { field: "purpose", op: "eq", value: "password-reset" },
    ]);
    expect(row?.consumedAt).toBeNull();
    answer = false;
    expect((await resetPassword(auth.config, input)).ok).toBe(true);
  });

  it("sends a form post back to the reset page, which names the outage", async () => {
    const h = pwHandle({ hash: FAST, breachCheck: down });
    await h.auth.handle(post("/auth/password/reset/request", { email: "a@example.com" }));
    const token = h.mails.findLast((m) => m.subject.startsWith("Reset"))?.token ?? "";
    const res = await h.auth.handle(
      new Request(`${BASE_URL}/auth/password/reset`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: APP_ORIGIN },
        body: `token=${token}&password=correct+horse+battery`,
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${BASE_URL}/auth/password/reset?token=${token}&error=breach_check_unavailable`,
    );
    const page = await h.auth.handle(
      get(`/auth/password/reset?token=${token}&error=breach_check_unavailable`),
    );
    expect(await page.text()).toContain(
      "The password check is not available now. Try again in a few minutes.",
    );
  });

  it("spends a reset code, as for every refused password (plan 9e)", async () => {
    const auth = makeAuth({ password: { hash: FAST, breachCheck: down } });
    expect((await requestResetOtp(auth.config, { email: "a@example.com", ip: null })).ok).toBe(
      true,
    );
    const code = /\b(\d{8}|\d{6})\b/.exec(auth.mail.at(-1)?.text ?? "")?.[1] ?? "";
    const input = { email: "a@example.com", code, password: PW, ip: null, userAgent: null };
    expect(await resetPasswordWithOtp(auth.config, input)).toMatchObject({
      code: "breach_check_unavailable",
    });
    expect(await resetPasswordWithOtp(auth.config, input)).toMatchObject({ code: "invalid_code" });
  });

  it("refuses the change with breach_check_unavailable and keeps the old password", async () => {
    let answer: boolean | "unavailable" = false;
    const auth = pwAuth({ breachCheck: async () => answer });
    await signUpAndVerify(auth, "a@example.com", PW);
    const s = await sessionOnly(
      passwordSignIn(auth.config, {
        email: "a@example.com",
        password: PW,
        ip: null,
        userAgent: null,
      }),
    );
    if (!s.ok) throw new Error(s.code);
    const session = await resolveSession(auth.config, s.value.token);
    if (!session) throw new Error("no session");
    answer = "unavailable";
    expect(
      await changePassword(auth.config, {
        session,
        currentPassword: PW,
        newPassword: "a new long password",
      }),
    ).toMatchObject({ ok: false, code: "breach_check_unavailable" });
    const again = await sessionOnly(
      passwordSignIn(auth.config, {
        email: "a@example.com",
        password: PW,
        ip: null,
        userAgent: null,
      }),
    );
    expect(again.ok).toBe(true);
  });

  it("still refuses a breached password with password_breached", async () => {
    const auth = pwAuth({ breachCheck: async () => true });
    await requestPasswordReset(auth.config, { email: "a@example.com", ip: null });
    const token = tokenFromMail(auth.mail.at(-1)?.text ?? "");
    expect(
      await resetPassword(auth.config, { token, password: PW, ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "password_breached" });
  });

  it("keeps a throw of the app's own check a 500: it is a fault, not an outage", async () => {
    const { auth } = pwHandle({
      hash: FAST,
      breachCheck: async () => {
        throw new Error("the app's check is broken");
      },
    });
    const res = await auth.handle(
      post("/auth/password/sign-up", { email: "a@example.com", password: PW }),
    );
    expect(res.status).toBe(500);
  });
});
