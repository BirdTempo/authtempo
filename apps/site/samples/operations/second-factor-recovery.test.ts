import { base32Decode, totpCode } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { createSecondFactorAuth } from "../guides/second-factor.ts";
import { call, harness, signIn } from "../support/harness.ts";
import { recoverSecondFactor } from "./second-factor-recovery.ts";

const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery";

describe("second factor recovery", () => {
  it("turns the factor off, and the next sign-in opens a session with the password alone", async () => {
    const h = harness();
    const auth = createSecondFactorAuth(h);
    const ada = await signIn(auth, h, EMAIL);
    await call(auth, "POST", "/auth/password/change", { newPassword: PASSWORD }, { cookie: ada });
    const setup = await call(
      auth,
      "POST",
      "/auth/totp/setup",
      { password: PASSWORD },
      { cookie: ada },
    );
    const { secret } = (await setup.json()) as { secret: string };
    await call(
      auth,
      "POST",
      "/auth/totp/enable",
      { code: await totpCode(base32Decode(secret), new Date()) },
      { cookie: ada },
    );
    const gated = await call(auth, "POST", "/auth/password/sign-in", {
      email: EMAIL,
      password: PASSWORD,
    });
    expect("twoFactor" in ((await gated.json()) as object)).toBe(true);

    // The operator types the address as the person gives it: case and spaces do not matter.
    expect(await recoverSecondFactor(auth, h.storage, " ADA@example.com ")).toBe("off");
    const open = await call(auth, "POST", "/auth/password/sign-in", {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(((await open.json()) as { token?: string }).token?.startsWith("ts_")).toBe(true);
    expect(await recoverSecondFactor(auth, h.storage, EMAIL)).toBe("was_off");
    expect(await recoverSecondFactor(auth, h.storage, "bob@example.com")).toBe("no_user");
  });
});
