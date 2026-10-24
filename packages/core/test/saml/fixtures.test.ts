import { describe, expect, it } from "vitest";
import { checkResponse } from "../../src/saml/assertion.js";
import { importVerifyKey, readCertificate } from "../../src/saml/der.js";
import { NS_DSIG, verifyEnveloped } from "../../src/saml/dsig.js";
import { childElements, parseXml, textOf, type XmlElement } from "../../src/saml/xml.js";
import { elementsIn } from "../../src/testing/saml-idp.js";
import { NS_SAML } from "./corpus.js";
import oneloginMetadata from "./fixtures/real/crewjam-onelogin-idp-metadata.xml?raw";
import onelogin from "./fixtures/real/crewjam-onelogin-response-sha1.base64?raw";
import nodeSamlCert from "./fixtures/real/node-saml-cert.pem?raw";
import signed1 from "./fixtures/real/node-saml-root-signed-assertion-signed-1advice-signed.xml?raw";
import signed2 from "./fixtures/real/node-saml-root-signed-assertion-signed-2advice-signed.xml?raw";
import unsigned1 from "./fixtures/real/node-saml-root-unsigned-assertion-signed-1advice-signed.xml?raw";
import nodeSha1 from "./fixtures/real/node-saml-root-unsigned-assertion-signed-sha1.xml?raw";

/** The vendored fixtures of SOURCE.md. Each certificate is the one its suite configures. */

function root(xml: string): XmlElement {
  const parsed = parseXml(xml);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal} at ${parsed.at}`);
  return parsed.root;
}

/** The Assertion that is a child of the Response: the one that the SAML checks read. */
function assertionOf(response: XmlElement): XmlElement {
  const [assertion] = childElements(response, NS_SAML, "Assertion");
  if (assertion === undefined) throw new Error("no Assertion child");
  return assertion;
}

async function keyOf(pem: string): Promise<CryptoKey> {
  const info = readCertificate(pem);
  const key = info === null ? null : await importVerifyKey(info);
  if (key === null) throw new Error("the certificate does not import");
  return key;
}

/** The signing certificate of an IdP metadata document, as PEM. */
function metadataCertificate(xml: string): string {
  const cert = elementsIn(root(xml)).find((e) => e.ns === NS_DSIG && e.local === "X509Certificate");
  const text = cert === undefined ? null : textOf(cert);
  if (text === null || !text.ok) throw new Error("no certificate");
  return `-----BEGIN CERTIFICATE-----\n${text.value.replace(/\s/g, "")}\n-----END CERTIFICATE-----\n`;
}

function attrOf(el: XmlElement, local: string): string {
  const value = el.attrs.find((a) => a.ns === null && a.local === local)?.value;
  if (value === undefined) throw new Error(`no ${local}`);
  return value;
}

describe("the real SAML fixtures", () => {
  it.each([
    ["node-saml root-signed assertion-signed 1advice-signed", signed1, "2020-09-25T16:30:00Z"],
    ["node-saml root-signed assertion-signed 2advice-signed", signed2, "2020-09-25T16:30:00Z"],
    ["node-saml root-unsigned assertion-signed 1advice-signed", unsigned1, "2020-09-25T16:30:00Z"],
  ])("accepts each real fixture at its clock: %s", async (_name, xml, clock) => {
    const key = await keyOf(nodeSamlCert);
    const response = root(xml);
    const assertion = assertionOf(response);
    // The clock of SOURCE.md lies inside the Conditions of the Assertion.
    const [conditions] = childElements(assertion, NS_SAML, "Conditions");
    if (conditions === undefined) throw new Error("no Conditions");
    const at = Date.parse(clock);
    expect(Date.parse(attrOf(conditions, "NotBefore"))).toBeLessThanOrEqual(at);
    expect(Date.parse(attrOf(conditions, "NotOnOrAfter"))).toBeGreaterThan(at);

    expect(await verifyEnveloped(assertion, [key])).toEqual({ ok: true });
    if (childElements(response, NS_DSIG, "Signature").length > 0) {
      expect(await verifyEnveloped(response, [key])).toEqual({ ok: true });
    }
  });

  // Ruling 22 L4 of plan 12d: each node-saml accept fixture holds an Assertion inside Advice.
  // The ACS reads one Assertion, so the guard refuses the Advice, though both signatures hold.
  it.each([
    ["node-saml root-signed assertion-signed 1advice-signed", signed1],
    ["node-saml root-signed assertion-signed 2advice-signed", signed2],
    ["node-saml root-unsigned assertion-signed 1advice-signed", unsigned1],
  ])(
    "refuses each Advice fixture at the wrapping step of checkResponse: %s",
    async (_name, xml) => {
      const key = await keyOf(nodeSamlCert);
      expect(xml).toContain("Advice>");
      expect(
        await checkResponse(new TextEncoder().encode(xml), {
          acsUrl: "https://sp.example/acs",
          spEntityId: "https://sp.example/metadata",
          idpEntityId: "https://idp.example/metadata",
          requestId: "_request",
          keys: [key],
          now: new Date("2020-09-25T16:30:00Z"),
          skewMs: 120_000,
          subjectAttribute: null,
          attributes: { email: "email", name: null },
        }),
      ).toEqual({ ok: false, step: "wrapping" });
    },
  );

  // The signed element of each: the OneLogin fixture signs the Response only.
  it.each([
    ["node-saml root-unsigned assertion-signed", nodeSha1, nodeSamlCert, "Assertion"],
    [
      "crewjam OneLogin",
      atob(onelogin.replace(/\s/g, "")),
      metadataCertificate(oneloginMetadata),
      "Response",
    ],
  ])("refuses each SHA-1 fixture at algorithm: %s", async (_name, xml, pem, signed) => {
    expect(xml).toContain("http://www.w3.org/2000/09/xmldsig#rsa-sha1");
    const key = await keyOf(pem);
    const response = root(xml);
    const target = signed === "Response" ? response : assertionOf(response);
    expect(await verifyEnveloped(target, [key])).toEqual({
      ok: false,
      step: "algorithm",
    });
  });
});
