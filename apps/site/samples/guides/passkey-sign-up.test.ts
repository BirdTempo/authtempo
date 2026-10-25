import { createMemoryLimiter, systemClock } from "@authtempo/core";
import { SoftAuthenticator } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { call, harness, sessionCookieOf } from "../support/harness.ts";
import { createPasskeySignUpAuth } from "./passkey-sign-up.ts";

/** The bytes of a base64url string. */
const bytesOf = (s: string) => Uint8Array.from(Buffer.from(s, "base64url"));

describe("sign up with a passkey", () => {
  it("makes a user with a passkey, a name, and no address", async () => {
    // A test passes the test value. An app passes the limiter of its adapter.
    const auth = createPasskeySignUpAuth({ ...harness(), limiter: "isolate-for-tests" });
    const res = await call(auth, "POST", "/auth/passkey/sign-up/options", { name: "Ada" });
    expect(res.status).toBe(200);
    const options = (await res.json()) as { challenge: string; user: { id: string; name: string } };
    expect(options.user.name).toBe("Ada");
    // In the browser: navigator.credentials.create. A test uses a software authenticator.
    const device = await SoftAuthenticator.create({
      rpID: "example.com",
      origin: "https://app.example.com",
    });
    const response = await device.register(options.challenge, bytesOf(options.user.id));
    const done = await call(auth, "POST", "/auth/passkey/sign-up/verify", { response });
    expect(done.status).toBe(200);
    const { user } = (await done.json()) as { user: { name: string; email: string | null } };
    expect(user.email).toBeNull();
    expect(user.name).toBe("Ada");
    expect(sessionCookieOf(done)).not.toBe("");
  });

  it("refuses a memory limiter outside tests: the cap is per deployment", () => {
    const limiter = createMemoryLimiter(systemClock);
    expect(() => createPasskeySignUpAuth({ ...harness(), limiter })).toThrow(/shared limiter/);
  });

  it("refuses a call with no limiter, as from plain JavaScript", () => {
    // The type needs a limiter. A call that skips the type check gets the refusal.
    const deps = harness() as never;
    expect(() => createPasskeySignUpAuth(deps)).toThrow(/shared limiter/);
  });
});
