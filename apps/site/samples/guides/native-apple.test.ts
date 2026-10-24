import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createNativeAppleAuth } from "./native-apple.ts";

// A test key set in place of Apple's. No test calls Apple.
const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256", use: "sig" };
const appleKeys: typeof fetch = async (input) =>
  String(input) === "https://appleid.apple.com/auth/keys"
    ? Response.json({ keys: [jwk] })
    : new Response("not found", { status: 404 });

/** The ID token of the native sheet, signed by the test key. */
function sheetToken(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: "https://appleid.apple.com",
    aud: "com.example.ios",
    sub: "apple-user-1",
    email: "ada@privaterelay.appleid.com",
    email_verified: true,
    nonce_supported: true,
    iat: now,
    exp: now + 600,
    ...claims,
  })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .sign(privateKey);
}

async function nonceOf(auth: ReturnType<typeof createNativeAppleAuth>) {
  const res = await call(auth, "POST", "/auth/social/apple/id-token/nonce", {});
  return (await res.json()) as { nonce: string; providerNonce: string };
}

describe("sign in with the native Apple sheet", () => {
  it("signs in, and the name of the sheet fills the new user", async () => {
    const auth = createNativeAppleAuth(harness(), appleKeys);
    const { nonce, providerNonce } = await nonceOf(auth);
    // The app sets request.nonce = providerNonce on the ASAuthorizationAppleIDRequest.
    const idToken = await sheetToken({ nonce: providerNonce });
    const res = await call(auth, "POST", "/auth/social/apple/id-token", {
      idToken,
      nonce,
      name: "Ada Lovelace",
    });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { name: string } };
    expect(user.name).toBe("Ada Lovelace");
  });

  it("refuses a token posted with no nonce", async () => {
    const auth = createNativeAppleAuth(harness(), appleKeys);
    // requireNonce is on by default, so even a token without nonce_supported needs the nonce.
    const idToken = await sheetToken({ nonce_supported: false });
    const res = await call(auth, "POST", "/auth/social/apple/id-token", { idToken });
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });
});
