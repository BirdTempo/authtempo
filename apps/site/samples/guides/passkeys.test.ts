import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createPasskeyAuth } from "./passkeys.ts";

describe("sign in with a passkey", () => {
  it("answers request options for a discoverable passkey on the relying party", async () => {
    const auth = createPasskeyAuth(harness());
    const res = await call(auth, "POST", "/auth/passkey/authenticate/options", {});
    expect(res.status).toBe(200);
    const options = (await res.json()) as {
      rpId: string;
      challenge: string;
      userVerification: string;
    };
    expect(options.rpId).toBe("example.com");
    expect(options.userVerification).toBe("required");
    expect(options.challenge.length).toBeGreaterThan(40);
  });

  it("refuses a registration with no session", async () => {
    const res = await call(
      createPasskeyAuth(harness()),
      "POST",
      "/auth/passkey/register/options",
      {},
    );
    expect(res.status).toBe(401);
  });
});
