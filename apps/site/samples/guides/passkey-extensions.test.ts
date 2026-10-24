import { type BrowserWebAuthn, createClient } from "@authtempo/client";
import type { PublicKeyCredentialRequestOptionsJSON } from "@authtempo/core";
import { SoftAuthenticator } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { API, APP, call, harness, signIn } from "../support/harness.ts";
import { createExtensionsAuth } from "./passkey-extensions.ts";
import { VAULT_SALT, writingBlob } from "./passkey-extensions-client.ts";

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

  it("writes a blob through exactly one allowed credential, and the sign-in still verifies", async () => {
    const h = harness();
    const auth = createExtensionsAuth(h);
    const cookie = await signIn(auth, h, "ada@example.com");
    const soft = await SoftAuthenticator.create({ rpID: "example.com", origin: APP });
    const reg = await call(auth, "POST", "/auth/passkey/register/options", {}, { cookie });
    const { challenge } = (await reg.json()) as { challenge: string };
    const response = await soft.register(challenge);
    const added = await call(
      auth,
      "POST",
      "/auth/passkey/register/verify",
      { response },
      { cookie },
    );
    expect(added.status).toBe(200);
    // The soft seam records the options that the browser would get.
    const seen: PublicKeyCredentialRequestOptionsJSON[] = [];
    const recorder: BrowserWebAuthn = {
      create: () => Promise.reject(new Error("no create")),
      get: async (options) => {
        seen.push(options);
        return soft.authenticate(options.challenge);
      },
    };
    const client = createClient({
      baseURL: API,
      credentials: "omit",
      broadcast: false,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        auth.handle(new Request(input, init))) as typeof fetch,
      webauthn: writingBlob("YmxvYg", soft.credentialId, recorder),
    });
    const r = await client.passkey.signIn({
      extensions: { prf: { first: VAULT_SALT }, largeBlob: { read: true } },
    });
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
    // WebAuthn Level 3, 10.1.5: a write needs exactly one credential, and no read.
    expect(seen[0]?.allowCredentials).toEqual([{ type: "public-key", id: soft.credentialId }]);
    expect(seen[0]?.extensions).toEqual({
      prf: { eval: { first: VAULT_SALT } },
      largeBlob: { write: "YmxvYg" },
    });
  });
});
