import { describe, expect, it } from "vitest";
import { importVerifyKey, readCertificate } from "../../src/saml/der.js";
import {
  bitString,
  certificateDer,
  concat,
  nullValue,
  OIDS,
  oid,
  pem,
  seq,
  tlv,
  uint,
} from "../../src/testing/der-writer.js";
import { createTestIdp } from "../../src/testing/saml-idp.js";
import nodeSamlCert from "./fixtures/real/node-saml-cert.pem?raw";

const NOT_BEFORE = new Date("2025-01-01T00:00:00Z");
const NOT_AFTER = new Date("2045-01-01T00:00:00Z");

async function rsaPair(bits: number): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: bits,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

async function certificate(spki: Uint8Array, signer: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return certificateDer({
    spki,
    signer,
    commonName: "der test",
    notBefore: NOT_BEFORE,
    notAfter: NOT_AFTER,
  });
}

/** The DER bytes with the one ASCII run `from` written as `to`, of the same length. */
function patchAscii(der: Uint8Array, from: string, to: string): Uint8Array<ArrayBuffer> {
  const text = Array.from(der, (b) => String.fromCharCode(b)).join("");
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0 || from.length !== to.length)
    throw new Error(`not exactly one: ${from}`);
  const out = new Uint8Array(der);
  out.set(new TextEncoder().encode(to), at);
  return out;
}

describe("readCertificate and importVerifyKey", () => {
  it("reads the key and notAfter of an RSA and a P-256 certificate", async () => {
    const rsa = readCertificate((await createTestIdp({ alg: "rsa" })).certificatePem);
    expect(rsa?.key).toBe("rsa");
    expect(rsa?.notAfter.toISOString()).toBe("2045-01-01T00:00:00.000Z");
    expect(rsa === null ? null : await importVerifyKey(rsa)).not.toBeNull();

    const ec = readCertificate((await createTestIdp({ alg: "ec" })).certificatePem);
    expect(ec?.key).toBe("ec-p256");
    expect(ec?.notAfter.toISOString()).toBe("2045-01-01T00:00:00.000Z");
    expect(ec === null ? null : await importVerifyKey(ec)).not.toBeNull();

    // The real fixture certificate of node-saml (SOURCE.md): RSA, past its notAfter.
    const real = readCertificate(nodeSamlCert);
    expect(real?.key).toBe("rsa");
    expect(real?.notAfter.toISOString()).toBe("2015-09-12T01:54:20.000Z");
    expect(real === null ? null : await importVerifyKey(real)).not.toBeNull();
  });

  it("refuses a certificate outside the profile", async () => {
    const small = await rsaPair(1024);
    const smallSpki = new Uint8Array(await crypto.subtle.exportKey("spki", small.publicKey));
    const smallInfo = readCertificate(
      pem("CERTIFICATE", await certificate(smallSpki, small.privateKey)),
    );
    expect(smallInfo?.key).toBe("rsa");
    expect(smallInfo === null ? "no info" : await importVerifyKey(smallInfo)).toBeNull();

    const p384 = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const p384Spki = new Uint8Array(await crypto.subtle.exportKey("spki", p384.publicKey));
    const signer = await rsaPair(2048);
    expect(
      readCertificate(pem("CERTIFICATE", await certificate(p384Spki, signer.privateKey))),
    ).toBeNull();
    const dsaSpki = seq(
      seq(
        oid(OIDS.dsa),
        seq(
          uint(new Uint8Array([0x17])),
          uint(new Uint8Array([0x0b])),
          uint(new Uint8Array([0x02])),
        ),
      ),
      bitString(uint(new Uint8Array([0x05]))),
    );
    expect(
      readCertificate(pem("CERTIFICATE", await certificate(dsaSpki, signer.privateKey))),
    ).toBeNull();

    const goodSpki = new Uint8Array(await crypto.subtle.exportKey("spki", signer.publicKey));
    const good = await certificate(goodSpki, signer.privateKey);
    expect(readCertificate(pem("CERTIFICATE", good))?.key).toBe("rsa");
    expect(readCertificate(pem("CERTIFICATE", good) + pem("CERTIFICATE", good))).toBeNull();
    expect(readCertificate(pem("CERTIFICATE", concat(good, new Uint8Array([0]))))).toBeNull();

    // The outer SEQUENCE again, with its length in five bytes (0x85).
    const header = good[1] === 0x82 ? 4 : 0;
    expect(header).toBe(4);
    const body = good.slice(header);
    const five = concat(
      new Uint8Array([0x30, 0x85, 0, 0, 0, (body.length >> 8) & 0xff, body.length & 0xff]),
      body,
    );
    expect(readCertificate(pem("CERTIFICATE", five))).toBeNull();
  });

  // Review L2 of Task 7: RFC 3279 section 2.3.1 gives an RSA key the parameters NULL.
  it.each([
    ["NULL", "rsa", nullValue()],
    ["an OID", null, oid(OIDS.prime256v1)],
    ["a NULL with one content byte", null, tlv(0x05, new Uint8Array([0]))],
  ])("reads the RSA parameters %s: the key is %s", async (_name, key, params) => {
    const signer = await rsaPair(2048);
    const real = new Uint8Array(await crypto.subtle.exportKey("spki", signer.publicKey));
    // The real SPKI: a SEQUENCE header of 4 bytes, then the algorithm SEQUENCE, then the key.
    expect([real[0], real[1], real[4]]).toEqual([0x30, 0x82, 0x30]);
    const keyBits = real.slice(6 + (real[5] ?? 0));
    expect(keyBits[0]).toBe(0x03);
    const spki = seq(seq(oid(OIDS.rsaEncryption), params), keyBits);
    const info = readCertificate(pem("CERTIFICATE", await certificate(spki, signer.privateKey)));
    expect(info?.key ?? null).toBe(key);
  });

  // The fields of a time in their range (RFC 5280 section 4.1.2.5), in notBefore and notAfter.
  it.each([
    ["no change", "250101000000Z", "250101000000Z", "rsa"],
    ["a notBefore of month 13", "250101000000Z", "251301000000Z", null],
    ["a notBefore of day 32", "250101000000Z", "250132000000Z", null],
    ["a notAfter of second 60", "450101000000Z", "450101000060Z", null],
  ])("reads a certificate with %s", async (_name, from, to, key) => {
    const signer = await rsaPair(2048);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", signer.publicKey));
    const der = patchAscii(await certificate(spki, signer.privateKey), from, to);
    expect(readCertificate(pem("CERTIFICATE", der))?.key ?? null).toBe(key);
  });
});
