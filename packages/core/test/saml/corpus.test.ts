import { beforeAll, describe, expect, it } from "vitest";
import { importVerifyKey, readCertificate } from "../../src/saml/der.js";
import { type DsigStep, NS_DSIG, verifyEnveloped } from "../../src/saml/dsig.js";
import { childElements, parseXml, textOf, type XmlElement } from "../../src/saml/xml.js";
import { createTestIdp, elementsIn, type TestIdp } from "../../src/testing/saml-idp.js";
import {
  type CorpusCase,
  commentInDigestValue,
  commentInNameId,
  doctypeEntity,
  duplicateId,
  EVIL_NAME_ID,
  NS_SAML,
  NS_SAMLP,
  secondAssertion,
  unsignedAssertionInSignedResponse,
  validInput,
  xsw1,
  xsw2,
  xsw3,
  xsw4,
  xsw5,
  xsw6,
  xsw7,
  xsw8,
} from "./corpus.js";

type Step = "parse" | "wrapping" | "subject" | DsigStep;

/**
 * The wrapping guards of Task 8 Behavior 3, as this test's own copy until Task 8 moves them
 * into `assertion.ts`: the root is the Response, each `ID` is unique, the document holds one
 * Assertion, it is a child of the root, and no `EncryptedAssertion` exists.
 */
function wrappingGuard(root: XmlElement): { ok: true; assertion: XmlElement } | { ok: false } {
  if (root.ns !== NS_SAMLP || root.local !== "Response") return { ok: false };
  const ids = new Set<string>();
  const assertions: XmlElement[] = [];
  for (const el of elementsIn(root)) {
    for (const a of el.attrs) {
      if (a.ns !== null || a.local !== "ID") continue;
      if (ids.has(a.value)) return { ok: false };
      ids.add(a.value);
    }
    if (el.ns === NS_SAML && el.local === "EncryptedAssertion") return { ok: false };
    if (el.ns === NS_SAML && el.local === "Assertion") assertions.push(el);
  }
  const [assertion] = assertions;
  if (assertions.length !== 1 || assertion === undefined || assertion.parent !== root)
    return { ok: false };
  return { ok: true, assertion };
}

/** The checks that Task 7 owns, in the order of Task 8 Behavior 3. */
async function verifyAssertionOf(
  xml: string,
  keys: readonly CryptoKey[],
): Promise<{ ok: true } | { ok: false; step: Step }> {
  const parsed = parseXml(xml);
  if (!parsed.ok) return { ok: false, step: "parse" };
  const guard = wrappingGuard(parsed.root);
  if (!guard.ok) return { ok: false, step: "wrapping" };
  const assertion = await verifyEnveloped(guard.assertion, keys);
  if (!assertion.ok) return assertion;
  if (childElements(parsed.root, NS_DSIG, "Signature").length > 0) {
    const response = await verifyEnveloped(parsed.root, keys);
    if (!response.ok) return response;
  }
  // Every later value comes from the guard's node, never from a new search of the document.
  const subject = childElements(guard.assertion, NS_SAML, "Subject")[0];
  const nameId = subject === undefined ? undefined : childElements(subject, NS_SAML, "NameID")[0];
  if (nameId === undefined || !textOf(nameId).ok) return { ok: false, step: "subject" };
  return { ok: true };
}

/** The Assertion that holds `EVIL_NAME_ID`: the element that a naive reader would read. */
function evilAssertion(xml: string): XmlElement {
  const parsed = parseXml(xml);
  if (!parsed.ok) throw new Error("the attack text does not parse");
  const found = elementsIn(parsed.root).filter(
    (el) =>
      el.ns === NS_SAML &&
      el.local === "Assertion" &&
      elementsIn(el).some((n) => {
        if (n.local !== "NameID" || n.parent?.parent !== el) return false;
        const text = textOf(n);
        return text.ok && text.value === EVIL_NAME_ID;
      }),
  );
  const [evil] = found;
  if (found.length !== 1 || evil === undefined) throw new Error("no single evil Assertion");
  return evil;
}

let idp: TestIdp;
let key: CryptoKey;
let valid: string;
const now = new Date("2026-10-20T08:00:00Z");

beforeAll(async () => {
  idp = await createTestIdp({ alg: "rsa" });
  const info = readCertificate(idp.certificatePem);
  const imported = info === null ? null : await importVerifyKey(info);
  if (imported === null) throw new Error("the test IdP key does not import");
  key = imported;
  valid = await idp.response(validInput(now));
});

describe("the attack corpus", () => {
  it("accepts the valid Response that each case starts from", async () => {
    expect(await verifyAssertionOf(valid, [key])).toEqual({ ok: true });
  });

  // `chain` is the step of the full check. `alone` is the step of verifyEnveloped on the evil
  // Assertion with no guard before it: the signature check refuses each shape by itself too.
  it.each<[string, CorpusCase, Step, DsigStep]>([
    ["XSW1", xsw1, "wrapping", "reference"],
    ["XSW2", xsw2, "wrapping", "reference"],
    ["XSW3", xsw3, "wrapping", "signature_shape"],
    ["XSW4", xsw4, "wrapping", "signature_shape"],
    ["XSW5", xsw5, "wrapping", "algorithm"],
    ["XSW6", xsw6, "wrapping", "signature_shape"],
    ["XSW7", xsw7, "wrapping", "signature_shape"],
    ["XSW8", xsw8, "wrapping", "algorithm"],
  ])("refuses the wrapping shape %s", async (_name, attack, chain, alone) => {
    const xml = await attack(valid, idp);
    expect(await verifyAssertionOf(xml, [key])).toEqual({ ok: false, step: chain });
    expect(await verifyEnveloped(evilAssertion(xml), [key])).toEqual({ ok: false, step: alone });
  });

  it("refuses a comment inside NameID and inside DigestValue", async () => {
    expect(await verifyAssertionOf(await commentInNameId(valid, idp), [key])).toEqual({
      ok: false,
      step: "subject",
    });
    expect(await verifyAssertionOf(await commentInDigestValue(valid, idp), [key])).toEqual({
      ok: false,
      step: "digest",
    });
  });

  it("refuses a second Assertion, a duplicate ID, and a DOCTYPE", async () => {
    expect(await verifyAssertionOf(await secondAssertion(valid, idp), [key])).toEqual({
      ok: false,
      step: "wrapping",
    });
    expect(await verifyAssertionOf(await duplicateId(valid, idp), [key])).toEqual({
      ok: false,
      step: "wrapping",
    });
    expect(await verifyAssertionOf(await doctypeEntity(valid, idp), [key])).toEqual({
      ok: false,
      step: "parse",
    });
  });

  it("refuses an unsigned Assertion inside a signed Response", async () => {
    const xml = await unsignedAssertionInSignedResponse(valid, idp);
    expect(await verifyAssertionOf(xml, [key])).toEqual({ ok: false, step: "signature_shape" });
  });
});
