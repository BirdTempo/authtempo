import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "../src/primitives/crypto.js";
import { createSimpleWebAuthnSeam } from "../src/seams/webauthn.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";

const RP = { rpID: "example.com", rpName: "Example", origin: "https://app.example.com" };
const seam = createSimpleWebAuthnSeam();

function challenge(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

describe("simplewebauthn seam", () => {
  it("builds registration options with the challenge, a discoverable credential, and user verification", async () => {
    const c = challenge();
    const options = await seam.registrationOptions({
      rpID: RP.rpID,
      rpName: RP.rpName,
      userID: new TextEncoder().encode("01USER"),
      userName: "ada@example.com",
      userDisplayName: "ada@example.com",
      challenge: c,
      excludeCredentials: [{ id: "AQID", transports: ["internal"] }],
    });
    expect(options.challenge).toBe(toBase64Url(c));
    expect(options.rp).toEqual({ name: RP.rpName, id: RP.rpID });
    expect(options.user.name).toBe("ada@example.com");
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });
    expect(options.excludeCredentials).toEqual([
      { id: "AQID", transports: ["internal"], type: "public-key" },
    ]);
    expect(options.pubKeyCredParams.map((p) => p.alg)).toContain(-7);
  });

  it("verifies a registration from the software authenticator and returns the stored shape", async () => {
    const auth = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origin });
    const c = toBase64Url(challenge());
    const reg = await auth.register(c);
    const result = await seam.verifyRegistration({
      response: reg,
      expectedChallenge: c,
      expectedOrigin: [RP.origin],
      expectedRPID: RP.rpID,
    });
    expect(result.id).toBe(auth.credentialId);
    expect(result.counter).toBe(0);
    expect(result.transports).toEqual(["internal"]);
    expect(result.deviceType).toBe("singleDevice");
    expect(result.backedUp).toBe(false);
    expect(result.publicKey.length).toBeGreaterThan(70);
    const backed = await SoftAuthenticator.create({
      rpID: RP.rpID,
      origin: RP.origin,
      backedUp: true,
    });
    const r2 = await seam.verifyRegistration({
      response: await backed.register(c),
      expectedChallenge: c,
      expectedOrigin: [RP.origin],
      expectedRPID: RP.rpID,
    });
    expect(r2.deviceType).toBe("multiDevice");
    expect(r2.backedUp).toBe(true);
  });

  it("rejects a registration with the wrong challenge, origin, or rpID", async () => {
    const auth = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origin });
    const c = toBase64Url(challenge());
    const reg = await auth.register(c);
    const base = {
      response: reg,
      expectedChallenge: c,
      expectedOrigin: [RP.origin],
      expectedRPID: RP.rpID,
    };
    await expect(
      seam.verifyRegistration({ ...base, expectedChallenge: toBase64Url(challenge()) }),
    ).rejects.toThrow();
    await expect(
      seam.verifyRegistration({ ...base, expectedOrigin: ["https://evil.example"] }),
    ).rejects.toThrow();
    await expect(
      seam.verifyRegistration({ ...base, expectedRPID: "evil.example" }),
    ).rejects.toThrow();
  });

  it("builds authentication options for a discoverable credential", async () => {
    const c = challenge();
    const options = await seam.authenticationOptions({ rpID: RP.rpID, challenge: c });
    expect(options.challenge).toBe(toBase64Url(c));
    expect(options.rpId).toBe(RP.rpID);
    expect(options.userVerification).toBe("required");
    expect(options.allowCredentials ?? []).toEqual([]);
  });

  it("verifies an authentication, returns the new counter, and rejects a counter that does not advance", async () => {
    const auth = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origin });
    const regChallenge = toBase64Url(challenge());
    const stored = await seam.verifyRegistration({
      response: await auth.register(regChallenge),
      expectedChallenge: regChallenge,
      expectedOrigin: [RP.origin],
      expectedRPID: RP.rpID,
    });
    const c = toBase64Url(challenge());
    const credential = {
      id: stored.id,
      publicKey: stored.publicKey,
      counter: stored.counter,
      transports: stored.transports,
    };
    const ok = await seam.verifyAuthentication({
      response: await auth.authenticate(c),
      expectedChallenge: c,
      expectedOrigin: [RP.origin],
      expectedRPID: RP.rpID,
      credential,
    });
    expect(ok.newCounter).toBe(1);
    expect(ok.deviceType).toBe("singleDevice");
    // A cloned authenticator replays counter 1 against a stored counter of 1.
    await expect(
      seam.verifyAuthentication({
        response: await auth.authenticate(c, { counter: 1 }),
        expectedChallenge: c,
        expectedOrigin: [RP.origin],
        expectedRPID: RP.rpID,
        credential: { ...credential, counter: 1 },
      }),
    ).rejects.toThrow(/counter/i);
    // A wrong origin and a signature from another key both fail.
    await expect(
      seam.verifyAuthentication({
        response: await auth.authenticate(c, { origin: "https://evil.example" }),
        expectedChallenge: c,
        expectedOrigin: [RP.origin],
        expectedRPID: RP.rpID,
        credential,
      }),
    ).rejects.toThrow();
    const other = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origin });
    const forged = await other.authenticate(c);
    forged.id = auth.credentialId;
    forged.rawId = auth.credentialId;
    await expect(
      seam.verifyAuthentication({
        response: forged,
        expectedChallenge: c,
        expectedOrigin: [RP.origin],
        expectedRPID: RP.rpID,
        credential: { ...credential, counter: 5 },
      }),
    ).rejects.toThrow();
    expect(fromBase64Url(stored.id)).toHaveLength(16);
  });
});
