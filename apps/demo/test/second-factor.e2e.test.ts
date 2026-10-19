import { base32Decode, totpCode } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import {
  call,
  type Jar,
  newSandbox,
  PASSWORD,
  SESSION_COOKIE,
  sameSandbox,
  verifiedUser,
  whoami,
} from "./helpers.js";

const STEP_MS = 30_000;

/**
 * The factor on for a new password user. `next` answers the code of the step
 * after the step that the enable spent, so a step boundary does not move it.
 */
async function enrolled(jar: Jar, email: string) {
  await verifiedUser(jar, email);
  const setup = await call(jar, "POST", "/auth/totp/setup", { password: PASSWORD });
  expect(setup.status).toBe(200);
  const body = (await setup.json()) as { secret: string; backupCodes: string[] };
  const secret = base32Decode(body.secret);
  const at = new Date();
  const enable = await call(jar, "POST", "/auth/totp/enable", { code: await totpCode(secret, at) });
  expect(enable.status).toBe(200);
  const step = Math.floor(at.getTime() / STEP_MS);
  return {
    backupCodes: body.backupCodes,
    next: () => totpCode(secret, new Date((step + 1) * STEP_MS)),
  };
}

/** A password sign-in by a second visitor of the sandbox: it answers the challenge. */
async function challenge(jar: Jar, email: string): Promise<string> {
  const res = await call(jar, "POST", "/auth/password/sign-in", { email, password: PASSWORD });
  expect(res.status).toBe(200);
  expect(jar.cookies.has(SESSION_COOKIE)).toBe(false);
  const { twoFactor } = (await res.json()) as { twoFactor: { challenge: string } };
  return twoFactor.challenge;
}

describe("second factor", () => {
  it("turns on the second factor and signs in with the code of totpCode", async () => {
    const jar = await newSandbox();
    const email = "totp-a@example.com";
    const f = await enrolled(jar, email);
    const other = sameSandbox(jar);
    const id = await challenge(other, email);
    expect(await whoami(other)).toBeNull();
    const verify = await call(other, "POST", "/auth/totp/verify", {
      challenge: id,
      code: await f.next(),
    });
    expect(verify.status).toBe(200);
    expect(await whoami(other)).toMatchObject({ kind: "session", email });
  });

  it("signs in with a backup code", async () => {
    const jar = await newSandbox();
    const email = "totp-b@example.com";
    const f = await enrolled(jar, email);
    expect(f.backupCodes).toHaveLength(10);
    const other = sameSandbox(jar);
    const verify = await call(other, "POST", "/auth/totp/verify", {
      challenge: await challenge(other, email),
      backupCode: f.backupCodes[0],
    });
    expect(verify.status).toBe(200);
    expect(((await verify.json()) as { backupCodesLeft: number }).backupCodesLeft).toBe(9);
    expect(await whoami(other)).toMatchObject({ kind: "session", email });
  });
});
