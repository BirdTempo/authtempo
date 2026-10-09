import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "../src/primitives/crypto.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";

const RP = { rpID: "example.com", origin: "https://app.example.com" };

function clientData(b64: string): { type: string; challenge: string; origin: string } {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(b64)));
}

describe("SoftAuthenticator", () => {
  it("registers with a none attestation that names the challenge, origin, and rpID", async () => {
    const auth = await SoftAuthenticator.create(RP);
    const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const reg = await auth.register(challenge);
    expect(reg.id).toBe(auth.credentialId);
    expect(reg.rawId).toBe(auth.credentialId);
    expect(reg.type).toBe("public-key");
    expect(clientData(reg.response.clientDataJSON)).toEqual({
      type: "webauthn.create",
      challenge,
      origin: RP.origin,
      crossOrigin: false,
    });
    const att = fromBase64Url(reg.response.attestationObject);
    // CBOR map of three entries, first key "fmt".
    expect(Array.from(att.slice(0, 5))).toEqual([0xa3, 0x63, 0x66, 0x6d, 0x74]);
    const rpIdHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RP.rpID)),
    );
    // authData starts after the "authData" key and its byte-string header; find the rpIdHash in the object.
    const attText = Array.from(att)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const hashText = Array.from(rpIdHash)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(attText).toContain(hashText);
    expect(reg.response.transports).toEqual(["internal"]);
  });

  it("signs an authentication with an advancing counter and a DER ECDSA signature that Web Crypto verifies", async () => {
    const auth = await SoftAuthenticator.create(RP);
    const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const a1 = await auth.authenticate(challenge);
    expect(clientData(a1.response.clientDataJSON).type).toBe("webauthn.get");
    const authData = fromBase64Url(a1.response.authenticatorData);
    expect(authData).toHaveLength(37);
    expect(authData[32]).toBe(0x05); // UP and UV
    expect(authData[36]).toBe(1); // counter 1
    const a2 = await auth.authenticate(challenge);
    expect(fromBase64Url(a2.response.authenticatorData)[36]).toBe(2);
    const fixed = await auth.authenticate(challenge, { counter: 1 });
    expect(fromBase64Url(fixed.response.authenticatorData)[36]).toBe(1);
    // DER -> raw r||s, then verify with the public key.
    const der = fromBase64Url(a1.response.signature);
    expect(der[0]).toBe(0x30);
    const raw = derToRaw(der);
    const key = await crypto.subtle.importKey(
      "jwk",
      await auth.publicKeyJwk(),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const clientDataHash = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        fromBase64Url(a1.response.clientDataJSON) as BufferSource,
      ),
    );
    const signed = new Uint8Array([...authData, ...clientDataHash]);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        raw as BufferSource,
        signed,
      ),
    ).toBe(true);
  });

  it("sets the backup flags when asked", async () => {
    const auth = await SoftAuthenticator.create({ ...RP, backedUp: true });
    const a = await auth.authenticate("Y2hhbGxlbmdl");
    expect(fromBase64Url(a.response.authenticatorData)[32]).toBe(0x1d); // UP UV BE BS
  });
});

/** DER SEQUENCE { INTEGER r, INTEGER s } to raw 64 bytes. */
function derToRaw(der: Uint8Array): Uint8Array {
  let i = 2;
  const out = new Uint8Array(64);
  for (let part = 0; part < 2; part++) {
    if (der[i++] !== 0x02) throw new Error("not an INTEGER");
    const len = der[i++] ?? 0;
    let v = der.slice(i, i + len);
    i += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    out.set(v, part * 32 + (32 - v.length));
  }
  return out;
}
