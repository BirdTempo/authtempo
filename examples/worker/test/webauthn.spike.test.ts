import { createSimpleWebAuthnSeam } from "@tempo-auth/core";
import { SoftAuthenticator } from "@tempo-auth/core/testing";
import { expect, it } from "vitest";

// Spec 13 spike: @simplewebauthn/server declares Node 20 or newer. This
// test runs the four ceremony functions on workerd with no compatibility
// flag. If it fails, the spec's fallback is a vendored copy of the two
// verify functions, and the controller rules.
const RP = { rpID: "example.test", rpName: "tempo-auth example", origin: "https://example.test" };

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

it("runs both WebAuthn ceremonies on the Workers runtime", async () => {
  const seam = createSimpleWebAuthnSeam();
  const auth = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origin });
  const regChallenge = crypto.getRandomValues(new Uint8Array(32));
  const options = await seam.registrationOptions({
    rpID: RP.rpID,
    rpName: RP.rpName,
    userID: new TextEncoder().encode("01USER"),
    userName: "ada@example.com",
    userDisplayName: "ada@example.com",
    challenge: regChallenge,
    excludeCredentials: [],
  });
  expect(options.challenge).toBe(b64url(regChallenge));
  const stored = await seam.verifyRegistration({
    response: await auth.register(options.challenge),
    expectedChallenge: options.challenge,
    expectedOrigin: [RP.origin],
    expectedRPID: RP.rpID,
  });
  expect(stored.id).toBe(auth.credentialId);
  const authChallenge = crypto.getRandomValues(new Uint8Array(32));
  const request = await seam.authenticationOptions({ rpID: RP.rpID, challenge: authChallenge });
  const assertion = await auth.authenticate(request.challenge);
  // The soft authenticator emits userHandle: null, as browsers do. The library
  // type allows only a string or no key, so drop the null here.
  const { userHandle, ...assertionResponse } = assertion.response;
  const result = await seam.verifyAuthentication({
    response: {
      ...assertion,
      response: userHandle === null ? assertionResponse : { ...assertionResponse, userHandle },
    },
    expectedChallenge: request.challenge,
    expectedOrigin: [RP.origin],
    expectedRPID: RP.rpID,
    credential: {
      id: stored.id,
      publicKey: stored.publicKey,
      counter: stored.counter,
      transports: stored.transports,
    },
  });
  expect(result.newCounter).toBe(1);
});
