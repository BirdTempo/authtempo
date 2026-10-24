import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createExtensionsAuth } from "./passkey-extensions.ts";
import { VAULT_SALT } from "./passkey-extensions-client.ts";

describe("use the passkey extensions", () => {
  it("passes the PRF salt and a large blob read to the sign-in options", async () => {
    const auth = createExtensionsAuth(harness());
    const res = await call(auth, "POST", "/auth/passkey/authenticate/options", {
      extensions: { prf: { first: VAULT_SALT }, largeBlob: { read: true } },
    });
    expect(res.status).toBe(200);
    const options = (await res.json()) as { extensions: unknown };
    expect(options.extensions).toEqual({
      prf: { eval: { first: VAULT_SALT } },
      largeBlob: { read: true },
    });
  });

  it("refuses a PRF salt that is not 32 bytes", async () => {
    const auth = createExtensionsAuth(harness());
    const res = await call(auth, "POST", "/auth/passkey/authenticate/options", {
      extensions: { prf: { first: VAULT_SALT.slice(0, 42) } },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });
});
