import { base32Decode, totpCode } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { call, harness, signIn } from "../support/harness.ts";
import { createSecondFactorAuth } from "./second-factor.ts";

describe("turn on the second factor", () => {
  it("sets up a factor, gates the password sign-in, and opens the session with a code", async () => {
    const h = harness();
    const auth = createSecondFactorAuth(h);
    // A verified user with a password: a magic link sign-in, then a first password.
    const ada = await signIn(auth, h, "ada@example.com");
    await call(
      auth,
      "POST",
      "/auth/password/change",
      { newPassword: "correct horse battery" },
      { cookie: ada },
    );

    const setup = await call(
      auth,
      "POST",
      "/auth/totp/setup",
      { password: "correct horse battery" },
      { cookie: ada },
    );
    const { secret, uri, backupCodes } = (await setup.json()) as {
      secret: string;
      uri: string;
      backupCodes: string[];
    };
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(new URL(uri).searchParams.get("issuer")).toBe("Example");
    expect(backupCodes.length).toBe(10);
    const key = base32Decode(secret);
    const enable = await call(
      auth,
      "POST",
      "/auth/totp/enable",
      { code: await totpCode(key, new Date()) },
      { cookie: ada },
    );
    expect(((await enable.json()) as { enabled: boolean }).enabled).toBe(true);

    const signInAnswer = await call(auth, "POST", "/auth/password/sign-in", {
      email: "ada@example.com",
      password: "correct horse battery",
    });
    const { twoFactor } = (await signInAnswer.json()) as { twoFactor: { challenge: string } };
    expect(twoFactor.challenge.startsWith("tf_")).toBe(true);
    // A code passes once: the enable spent the code of this step, so use the next step's code.
    const next = await totpCode(key, new Date(Date.now() + 30_000));
    const verify = await call(auth, "POST", "/auth/totp/verify", {
      challenge: twoFactor.challenge,
      code: next,
    });
    expect(((await verify.json()) as { token: string }).token.startsWith("ts_")).toBe(true);
  });
});
