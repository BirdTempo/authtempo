import { describe, expect, it, vi } from "vitest";
import {
  confirmEmailChange,
  requestEmailChange,
  verifyEmailChange,
} from "../src/engine/email-change.js";
import { passwordSignUp } from "../src/engine/password.js";
import { type Auth, EMAIL, PASSWORD, totpAuth, verifiedSession } from "./totp-helpers.js";

// The decoy row of a taken address holds a proof that core never mails. This
// file fixes the change-of-address token and every code, so a test can send
// that right proof and see that it moves nothing (review M1). Its own file:
// the fixed values must reach no other test.
// Each change-of-address token in turn: the first is `tokenAt(0)`, the next `tokenAt(1)`.
const fixed = vi.hoisted(() => ({ next: 0 }));
const tokenAt = (i: number) => `ec_${"Q".repeat(42)}${i}`;
vi.mock("../src/primitives/crypto.js", async (load) => {
  const real = await load<typeof import("../src/primitives/crypto.js")>();
  return {
    ...real,
    randomDigits: (n: number) => "4".repeat(n),
    randomToken: (prefix: string) =>
      prefix === "ec_" ? `ec_${"Q".repeat(42)}${fixed.next++}` : real.randomToken(prefix),
  };
});

const NEW = "ada.new@example.com";

async function takenBy(auth: Auth, email: string): Promise<void> {
  // An unverified sign-up at the address: a claim, which the request must not tell.
  const up = await passwordSignUp(auth.config, {
    email,
    password: PASSWORD,
    ip: null,
    userAgent: null,
  });
  if (!up.ok) throw new Error(up.code);
}

async function addressOf(auth: Auth, id: string): Promise<string | null | undefined> {
  return (await auth.storage.findOne("user", [{ field: "id", op: "eq", value: id }]))?.email;
}

describe("the decoy row of a taken address (plan 12a review M1)", () => {
  it("answers the right code of a decoy row as a wrong code, and moves nothing", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    await takenBy(auth, NEW);
    await requestEmailChange(auth.config, { session: me, newEmail: NEW, method: "code" });
    expect(auth.mail.at(-1)?.text).not.toContain("444444");
    expect(
      await verifyEmailChange(auth.config, {
        session: me,
        code: "444444",
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: false, code: "invalid_code", status: 400 });
    expect(await addressOf(auth, me.user.id)).toBe(EMAIL);
    // The same code on a free address moves it, so the fixed code is the right one.
    const free = "ada.free@example.com";
    await requestEmailChange(auth.config, { session: me, newEmail: free, method: "code" });
    expect(
      (
        await verifyEmailChange(auth.config, {
          session: me,
          code: "444444",
          ip: null,
          userAgent: null,
        })
      ).ok,
    ).toBe(true);
    expect(await addressOf(auth, me.user.id)).toBe(free);
  });

  it("answers the right token of a decoy row as an unknown link, and moves nothing", async () => {
    const auth = totpAuth();
    const me = await verifiedSession(auth);
    await takenBy(auth, NEW);
    fixed.next = 0;
    await requestEmailChange(auth.config, { session: me, newEmail: NEW });
    const TOKEN = tokenAt(0);
    expect(auth.mail.at(-1)?.text).not.toContain(TOKEN);
    expect(
      await confirmEmailChange(auth.config, { token: TOKEN, ip: null, userAgent: null }),
    ).toEqual({
      ok: false,
      code: "invalid_token",
      status: 400,
    });
    expect(await addressOf(auth, me.user.id)).toBe(EMAIL);
    const free = "ada.free@example.com";
    await requestEmailChange(auth.config, { session: me, newEmail: free });
    expect(auth.mail.at(-1)?.text).toContain(tokenAt(1));
    expect(
      (await confirmEmailChange(auth.config, { token: tokenAt(1), ip: null, userAgent: null })).ok,
    ).toBe(true);
    expect(await addressOf(auth, me.user.id)).toBe(free);
  });
});
