import { base32Decode, totpCode } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import {
  call,
  type Harness,
  harness,
  linkIn,
  sessionCookieOf,
  signIn,
} from "../support/harness.ts";
import { createSecondFactorAuth } from "./second-factor.ts";

const PASSWORD = "correct horse battery";

/** A verified user with a password and the TOTP method on. Answers the cookie and the key. */
async function enrolled(h: Harness, auth: ReturnType<typeof createSecondFactorAuth>) {
  // A verified user with a password: a magic link sign-in, then a first password.
  const ada = await signIn(auth, h, "ada@example.com");
  await call(auth, "POST", "/auth/password/change", { newPassword: PASSWORD }, { cookie: ada });
  const setup = await call(
    auth,
    "POST",
    "/auth/totp/setup",
    { password: PASSWORD },
    { cookie: ada },
  );
  const { secret, uri, backupCodes } = (await setup.json()) as {
    secret: string;
    uri: string;
    backupCodes: string[];
  };
  const key = base32Decode(secret);
  const enable = await call(
    auth,
    "POST",
    "/auth/totp/enable",
    { code: await totpCode(key, new Date()) },
    { cookie: ada },
  );
  // The email method: a code to the user's address, offered after a password sign-in only.
  await call(
    auth,
    "POST",
    "/auth/second-factor/email/enable",
    { password: PASSWORD },
    { cookie: ada },
  );
  return { ada, key, uri, backupCodes, enable };
}

describe("turn on the second factor", () => {
  it("sets up a factor, gates the password sign-in, and opens the session with a code", async () => {
    const h = harness();
    const auth = createSecondFactorAuth(h);
    const { key, uri, backupCodes, enable } = await enrolled(h, auth);
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(new URL(uri).searchParams.get("issuer")).toBe("Example");
    expect(backupCodes.length).toBe(10);
    // A backup code holds 23 characters in groups: 113.9 bits, above the 112 of ASVS 5.0 6.5.2.
    expect(backupCodes[0]?.replaceAll("-", "").length).toBe(23);
    expect(((await enable.json()) as { enabled: boolean }).enabled).toBe(true);

    const signInAnswer = await call(auth, "POST", "/auth/password/sign-in", {
      email: "ada@example.com",
      password: PASSWORD,
    });
    const { twoFactor } = (await signInAnswer.json()) as {
      twoFactor: { challenge: string; methods: string[] };
    };
    expect(twoFactor.challenge.startsWith("tf_")).toBe(true);
    expect(twoFactor.methods).toEqual(["totp", "email", "backup"]);
    // A code passes once: the enable spent the code of this step, so use the next step's code.
    const next = await totpCode(key, new Date(Date.now() + 30_000));
    const verify = await call(auth, "POST", "/auth/totp/verify", {
      challenge: twoFactor.challenge,
      code: next,
    });
    expect(((await verify.json()) as { token: string }).token.startsWith("ts_")).toBe(true);
  });

  it("asks a magic link and a reset for the factor, and the reset still sets the password", async () => {
    const h = harness();
    const auth = createSecondFactorAuth(h);
    const { ada } = await enrolled(h, auth);

    await call(auth, "POST", "/auth/magic-link/request", { email: "ada@example.com" });
    const token = linkIn(h, "ada@example.com").searchParams.get("token") ?? "";
    const link = await call(auth, "POST", "/auth/magic-link/verify", { token });
    expect(sessionCookieOf(link)).toBe("");
    // The mailbox proved the address, so the email method is not offered.
    expect(((await link.json()) as { twoFactor: { methods: string[] } }).twoFactor.methods).toEqual(
      ["totp", "backup"],
    );

    await call(auth, "POST", "/auth/password/reset/request", { email: "ada@example.com" });
    const resetToken = linkIn(h, "ada@example.com").searchParams.get("token") ?? "";
    const reset = await call(auth, "POST", "/auth/password/reset", {
      token: resetToken,
      password: "a brand new long password",
    });
    expect(reset.status).toBe(200);
    expect(sessionCookieOf(reset)).toBe("");
    expect(
      ((await reset.json()) as { twoFactor: { challenge: string } }).twoFactor.challenge,
    ).toMatch(/^tf_/);
    // The reset ended the old session, and the new password is the one that signs in.
    expect((await call(auth, "GET", "/auth/session", undefined, { cookie: ada })).status).toBe(401);
    const again = await call(auth, "POST", "/auth/password/sign-in", {
      email: "ada@example.com",
      password: "a brand new long password",
    });
    expect("twoFactor" in ((await again.json()) as object)).toBe(true);
  });
});
