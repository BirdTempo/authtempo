import { beforeAll, describe, expect, it } from "vitest";
import { excC14n } from "../../src/saml/c14n.js";
import { importVerifyKey, readCertificate } from "../../src/saml/der.js";
import { DSIG_ALGORITHMS, NS_DSIG, verifyEnveloped } from "../../src/saml/dsig.js";
import { parseXml, type XmlElement } from "../../src/saml/xml.js";
import { createTestIdp, type TestIdp } from "../../src/testing/saml-idp.js";
import { attackerKeyInfo, find, NS_SAML, sha1Digest, validInput } from "./corpus.js";

const now = new Date("2026-10-20T08:00:00Z");

async function keyOf(idp: TestIdp): Promise<CryptoKey> {
  const info = readCertificate(idp.certificatePem);
  const key = info === null ? null : await importVerifyKey(info);
  if (key === null) throw new Error("the key does not import");
  return key;
}

function assertionOf(xml: string): XmlElement {
  const parsed = parseXml(xml);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal}`);
  const [assertion] = find(parsed.root, NS_SAML, "Assertion");
  if (assertion === undefined) throw new Error("no Assertion");
  return assertion;
}

/** Replaces exactly one occurrence of `from`, so an edit cannot miss in silence. */
function edit(xml: string, from: string, to: string): string {
  const at = xml.indexOf(from);
  if (at < 0 || xml.indexOf(from, at + 1) >= 0) throw new Error(`not exactly one: ${from}`);
  return xml.slice(0, at) + to + xml.slice(at + from.length);
}

/**
 * The text with a new SignatureValue: the canonical SignedInfo of the Assertion, signed by
 * `signer` with `params`. The IdP writes no PrefixList, so the list is empty.
 */
async function resigned(
  xml: string,
  signer: CryptoKey,
  params: AlgorithmIdentifier | EcdsaParams,
): Promise<string> {
  const [signedInfo] = find(assertionOf(xml), NS_DSIG, "SignedInfo");
  if (signedInfo === undefined) throw new Error("no SignedInfo");
  const bytes = new TextEncoder().encode(excC14n(signedInfo, { inclusivePrefixes: [] }));
  const value = new Uint8Array(await crypto.subtle.sign(params, signer, bytes));
  let bin = "";
  for (const b of value) bin += String.fromCharCode(b);
  const from = /<ds:SignatureValue>[^<]+<\/ds:SignatureValue>/;
  if (!from.test(xml)) throw new Error("no SignatureValue");
  return xml.replace(from, `<ds:SignatureValue>${btoa(bin)}</ds:SignatureValue>`);
}

function rsaPair(bits: number, hash: string): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: bits,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash,
    },
    false,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
}

function ecPair(namedCurve: string): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve }, false, [
    "sign",
    "verify",
  ]) as Promise<CryptoKeyPair>;
}

let rsa: TestIdp;
let ec: TestIdp;
let rsaKey: CryptoKey;
let ecKey: CryptoKey;
let signed: string;

beforeAll(async () => {
  rsa = await createTestIdp({ alg: "rsa" });
  ec = await createTestIdp({ alg: "ec" });
  rsaKey = await keyOf(rsa);
  ecKey = await keyOf(ec);
  signed = await rsa.response(validInput(now));
});

describe("verifyEnveloped", () => {
  it("accepts the Assertion that the test IdP signed, with RSA and with ECDSA", async () => {
    expect(await verifyEnveloped(assertionOf(signed), [rsaKey])).toEqual({ ok: true });
    const byEc = await ec.response(validInput(now));
    expect(byEc).toContain(DSIG_ALGORITHMS.ecdsaSha256);
    expect(await verifyEnveloped(assertionOf(byEc), [ecKey])).toEqual({ ok: true });
  });

  it("accepts a signature by the second certificate of a rotation", async () => {
    const next = await createTestIdp({ alg: "rsa" });
    const nextKey = await keyOf(next);
    const xml = await next.response(validInput(now));
    expect(await verifyEnveloped(assertionOf(xml), [rsaKey, nextKey])).toEqual({ ok: true });
    expect(await verifyEnveloped(assertionOf(xml), [rsaKey])).toEqual({
      ok: false,
      step: "signature",
    });
  });

  it("refuses a key whose type differs from the SignatureMethod", async () => {
    expect(await verifyEnveloped(assertionOf(signed), [ecKey])).toEqual({
      ok: false,
      step: "algorithm",
    });
  });

  // Review L1 of Task 7: the check holds the key profile itself, not only importVerifyKey.
  // In RSASSA-PKCS1-v1_5 the key carries the hash, so a SHA-1 key verifies a SHA-1 value.
  it.each<["rsa" | "ec", string, "ok" | "algorithm", () => Promise<CryptoKeyPair>]>([
    ["rsa", "an RSA key of 2048 bits with SHA-256", "ok", () => rsaPair(2048, "SHA-256")],
    ["rsa", "an RSA key with SHA-1", "algorithm", () => rsaPair(2048, "SHA-1")],
    ["rsa", "an RSA key of 1024 bits", "algorithm", () => rsaPair(1024, "SHA-256")],
    ["ec", "an ECDSA key on P-256", "ok", () => ecPair("P-256")],
    ["ec", "an ECDSA key on P-384", "algorithm", () => ecPair("P-384")],
  ])("checks the %s key profile: %s answers %s", async (alg, _name, answer, pair) => {
    const keys = await pair();
    const base = alg === "rsa" ? signed : await ec.response(validInput(now));
    const params =
      alg === "rsa" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
    const xml = await resigned(base, keys.privateKey, params);
    expect(xml).not.toBe(base);
    expect(await verifyEnveloped(assertionOf(xml), [keys.publicKey])).toEqual(
      answer === "ok" ? { ok: true } : { ok: false, step: answer },
    );
  });

  it("accepts a Response and an Assertion each signed", async () => {
    const xml = await rsa.response(validInput(now, { signResponse: true }));
    const parsed = parseXml(xml);
    if (!parsed.ok) throw new Error("refused");
    expect(await verifyEnveloped(parsed.root, [rsaKey])).toEqual({ ok: true });
    expect(await verifyEnveloped(assertionOf(xml), [rsaKey])).toEqual({ ok: true });
  });

  // Ruling 19: an inner Signature is the child of an element with its own ID, and lies
  // outside the target's own Signature. Each other place answers signature_shape.
  it.each<[string, (copy: string) => [string, string]]>([
    ["under an element with no ID", (copy) => ["<saml:Subject>", `<saml:Subject>${copy}`]],
    ["as a second child of the target", (copy) => ["<saml:Subject>", `${copy}<saml:Subject>`]],
    [
      "inside the target's Signature, under an element with an ID",
      (copy) => ["</ds:KeyInfo>", `<saml:Advice ID="_inner">${copy}</saml:Advice></ds:KeyInfo>`],
    ],
  ])("refuses a Signature at any other place: %s", async (_name, place) => {
    const start = signed.indexOf("<ds:Signature ");
    const end = signed.indexOf("</ds:Signature>") + "</ds:Signature>".length;
    const [from, to] = place(signed.slice(start, end));
    const xml = edit(signed, from, to);
    expect(await verifyEnveloped(assertionOf(xml), [rsaKey])).toEqual({
      ok: false,
      step: "signature_shape",
    });
  });

  // Review m1 of Task 7: the enveloped transform leaves the Signature out of the digest, so an
  // Object holds unsigned content inside the signed element. KeyInfo is never read.
  it.each([
    [
      "with an unsigned AttributeStatement",
      '<ds:Object><saml:AttributeStatement><saml:Attribute Name="role"><saml:AttributeValue>admin</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></ds:Object>',
    ],
    ["with no content", "<ds:Object/>"],
  ])("refuses an Object in the Signature: %s", async (_name, object) => {
    const xml = edit(signed, "</ds:KeyInfo>", `</ds:KeyInfo>${object}`);
    expect(await verifyEnveloped(assertionOf(xml), [rsaKey])).toEqual({
      ok: false,
      step: "signature_shape",
    });
  });

  it("refuses an Object in the place of KeyInfo", async () => {
    const xml = signed.replace(/<ds:KeyInfo>[\s\S]*?<\/ds:KeyInfo>/, "<ds:Object/>");
    expect(xml).not.toBe(signed);
    expect(await verifyEnveloped(assertionOf(xml), [rsaKey])).toEqual({
      ok: false,
      step: "signature_shape",
    });
  });

  it("accepts a KeyInfo with any child, because the check never reads it", async () => {
    const xml = signed.replace(
      /<ds:KeyInfo>[\s\S]*?<\/ds:KeyInfo>/,
      "<ds:KeyInfo><saml:NameID>evil</saml:NameID></ds:KeyInfo>",
    );
    expect(xml).not.toBe(signed);
    expect(await verifyEnveloped(assertionOf(xml), [rsaKey])).toEqual({ ok: true });
  });

  it.each([
    [64, "signature"],
    [65, "algorithm"],
  ])("bounds the PrefixList: %i entries answer %s", async (count, step) => {
    const list = Array.from({ length: count }, (_, i) => `p${i}`).join(" ");
    const xml = edit(
      signed,
      `<ds:Transform Algorithm="${DSIG_ALGORITHMS.c14n}"/>`,
      `<ds:Transform Algorithm="${DSIG_ALGORITHMS.c14n}"><ec:InclusiveNamespaces xmlns:ec="${DSIG_ALGORITHMS.c14n}" PrefixList="${list}"/></ds:Transform>`,
    );
    expect(await verifyEnveloped(assertionOf(xml), [rsaKey])).toEqual({ ok: false, step });
  });

  it.each(["ID", "Id", "id"])(
    "refuses a target ID that a second element also holds, in the attribute %s",
    async (name) => {
      const id = /<saml:Assertion ID="([^"]+)"/.exec(signed)?.[1];
      if (id === undefined) throw new Error("no Assertion ID");
      const xml = edit(
        signed,
        "<samlp:Status>",
        `<samlp:Extensions><x ${name}="${id}"/></samlp:Extensions><samlp:Status>`,
      );
      expect(await verifyEnveloped(assertionOf(xml), [rsaKey])).toEqual({
        ok: false,
        step: "reference",
      });
    },
  );

  it.each<[string, (xml: string) => string, string]>([
    [
      "a DigestValue outside strict base64",
      (xml) => xml.replace(/<ds:DigestValue>/, "<ds:DigestValue>*"),
      "digest",
    ],
    [
      "a DigestValue of 20 bytes",
      (xml) =>
        xml.replace(/<ds:DigestValue>[^<]+</, "<ds:DigestValue>AAAAAAAAAAAAAAAAAAAAAAAAAAA=<"),
      "digest",
    ],
    [
      "a SignatureValue outside strict base64",
      (xml) => xml.replace(/<ds:SignatureValue>/, "<ds:SignatureValue>*"),
      "signature",
    ],
    [
      "a comment inside SignatureValue",
      (xml) => xml.replace(/<ds:SignatureValue>(....)/, "<ds:SignatureValue>$1<!---->"),
      "signature",
    ],
    [
      "a changed signed text",
      (xml) => edit(xml, "<saml:NameID", '<saml:NameID SPProvidedID="x"'),
      "reference",
    ],
  ])("refuses %s", async (_name, change, step) => {
    const xml = change(signed);
    expect(xml).not.toBe(signed);
    expect(await verifyEnveloped(assertionOf(xml), [rsaKey])).toEqual({ ok: false, step });
  });

  it("ignores KeyInfo", async () => {
    const xml = await attackerKeyInfo(signed, rsa);
    expect(xml).toContain("X509Certificate");
    expect(await verifyEnveloped(assertionOf(xml), [rsaKey])).toEqual({
      ok: false,
      step: "signature",
    });
  });

  it.each<[string, (xml: string) => Promise<string>]>([
    ["a SHA-1 digest", (xml) => sha1Digest(xml, rsa)],
    [
      "an rsa-sha1 method",
      async (xml) =>
        edit(xml, DSIG_ALGORITHMS.rsaSha256, "http://www.w3.org/2000/09/xmldsig#rsa-sha1"),
    ],
    [
      "an inclusive C14N method",
      async (xml) =>
        edit(
          xml,
          `<ds:CanonicalizationMethod Algorithm="${DSIG_ALGORITHMS.c14n}"/>`,
          '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>',
        ),
    ],
    [
      "an XPath transform",
      async (xml) =>
        edit(
          xml,
          `<ds:Transform Algorithm="${DSIG_ALGORITHMS.enveloped}"/>`,
          '<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">' +
            "<ds:XPath>not(ancestor-or-self::ds:Signature)</ds:XPath></ds:Transform>",
        ),
    ],
    [
      "a second Reference",
      async (xml) => {
        const start = xml.indexOf("<ds:Reference ");
        const end = xml.indexOf("</ds:Reference>") + "</ds:Reference>".length;
        const reference = xml.slice(start, end);
        return edit(xml, reference, reference + reference);
      },
    ],
    [
      "an empty URI",
      async (xml) => xml.replace(/<ds:Reference URI="#[^"]+"/, '<ds:Reference URI=""'),
    ],
    [
      "an attribute on DigestValue",
      async (xml) => edit(xml, "<ds:DigestValue>", '<ds:DigestValue Id="d">'),
    ],
  ])("refuses each algorithm outside the list: %s", async (_name, change) => {
    const xml = await change(signed);
    expect(xml).not.toBe(signed);
    expect(await verifyEnveloped(assertionOf(xml), [rsaKey])).toEqual({
      ok: false,
      step: "algorithm",
    });
  });
});
