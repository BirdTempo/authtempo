import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { call, harness, sessionCookieOf } from "../support/harness.ts";
import { createOneTapAuth } from "./one-tap.ts";

// A test key set in place of Google's. No test calls Google.
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
const googleKeys: typeof fetch = async (input) =>
  String(input) === "https://www.googleapis.com/oauth2/v3/certs"
    ? Response.json({ keys: [jwk] })
    : new Response("not found", { status: 404 });

/** The ID token that One Tap gives the page, signed by the test key. */
function oneTapToken(nonce: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: "https://accounts.google.com",
    aud: "web-client.apps.googleusercontent.com",
    sub: "google-user-1",
    email: "ada@example.com",
    email_verified: true,
    name: "Ada",
    nonce,
    iat: now,
    exp: now + 3600,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .sign(privateKey);
}

describe("sign in with Google One Tap", () => {
  it("signs in once with the token and the raw nonce", async () => {
    const auth = createOneTapAuth(harness(), googleKeys);
    const res = await call(auth, "POST", "/auth/social/google/id-token/nonce", {});
    const { nonce, providerNonce } = (await res.json()) as {
      nonce: string;
      providerNonce: string;
    };
    // Google gets providerNonce and writes it in the token.
    const idToken = await oneTapToken(providerNonce);
    const signIn = await call(auth, "POST", "/auth/social/google/id-token", { idToken, nonce });
    expect(signIn.status).toBe(200);
    expect(sessionCookieOf(signIn)).not.toBe("");

    // Each token signs in once.
    const again = await call(auth, "POST", "/auth/social/google/id-token", { idToken, nonce });
    expect(await again.json()).toEqual({ error: "invalid_token" });
  });

  it("refuses a token with the raw nonce in it", async () => {
    const auth = createOneTapAuth(harness(), googleKeys);
    const res = await call(auth, "POST", "/auth/social/google/id-token/nonce", {});
    const { nonce } = (await res.json()) as { nonce: string };
    const idToken = await oneTapToken(nonce);
    const signIn = await call(auth, "POST", "/auth/social/google/id-token", { idToken, nonce });
    expect(await signIn.json()).toEqual({ error: "invalid_token" });
  });
});
