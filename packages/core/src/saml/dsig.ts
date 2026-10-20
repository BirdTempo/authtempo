/**
 * The enveloped XML signature check of one narrow profile (plan 12d), on Web Crypto only.
 * XML Signature 1.1 section 3.2: reference validation, then signature validation.
 *
 * The check never dereferences the Reference URI. It digests the element that the caller
 * gives, and it requires the URI to name that element's `ID`. So the signed element is the
 * element that the caller reads (XML Signature 1.1 section 8.1.3, "see what is signed").
 * `KeyInfo` is never read: only the configured keys verify.
 */
import { constantTimeEqual } from "../primitives/crypto.js";
import { excC14n } from "./c14n.js";
import { strictBase64 } from "./der.js";
import { childElements, textOf, type XmlElement } from "./xml.js";

export const NS_DSIG = "http://www.w3.org/2000/09/xmldsig#";

/** The algorithm identifiers of the profile (XML Signature 1.1 section 6.1). No other passes. */
export const DSIG_ALGORITHMS = {
  c14n: "http://www.w3.org/2001/10/xml-exc-c14n#",
  enveloped: "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
  sha256: "http://www.w3.org/2001/04/xmlenc#sha256",
  rsaSha256: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  ecdsaSha256: "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256",
} as const;

export type DsigStep = "signature_shape" | "algorithm" | "reference" | "digest" | "signature";

const NS_EXC_C14N = DSIG_ALGORITHMS.c14n;
const XML_SPACE = /[ \t\r\n]/g;
const DIGEST_BYTES = 32;
const ECDSA_P256_BYTES = 64;

/** An NCName of the profile: ASCII letters, digits, `.`, `-`, and `_`, with a letter or `_` first. */
const NCNAME_RE = /^[A-Za-z_][A-Za-z0-9._-]*$/;

/** The most entries of one InclusiveNamespaces PrefixList. A SAML IdP writes a few. */
const PREFIX_LIST_MAX = 64;

class Fail {
  readonly step: DsigStep;
  constructor(step: DsigStep) {
    this.step = step;
  }
}

function elementsOf(el: XmlElement): XmlElement[] {
  return el.children.filter((c): c is XmlElement => c.kind === "element");
}

/** Text between child elements may only be XML white space; else the element is out of the profile. */
function onlySpaceText(el: XmlElement): boolean {
  return el.children.every((c) => c.kind !== "text" || c.value.replace(XML_SPACE, "") === "");
}

function isDsig(el: XmlElement, local: string): boolean {
  return el.ns === NS_DSIG && el.local === local;
}

/** The value of the attribute with no namespace and this local name, or null. */
function attr(el: XmlElement, local: string): string | null {
  for (const a of el.attrs) if (a.ns === null && a.local === local) return a.value;
  return null;
}

/** Each attribute of `el` has no namespace and a local name in `allowed`. */
function attrsWithin(el: XmlElement, allowed: readonly string[]): boolean {
  return el.attrs.every((a) => a.ns === null && allowed.includes(a.local));
}

/**
 * An exclusive C14N method element (the `CanonicalizationMethod` or the second `Transform`):
 * the `Algorithm`, and at most one `InclusiveNamespaces` child with a valid `PrefixList`.
 * Answers the prefix list.
 */
function exclusiveMethod(el: XmlElement): string[] {
  if (!attrsWithin(el, ["Algorithm"]) || attr(el, "Algorithm") !== DSIG_ALGORITHMS.c14n)
    throw new Fail("algorithm");
  if (!onlySpaceText(el)) throw new Fail("algorithm");
  const kids = elementsOf(el);
  if (kids.length === 0) return [];
  const only = kids[0];
  if (kids.length > 1 || only === undefined) throw new Fail("algorithm");
  if (only.ns !== NS_EXC_C14N || only.local !== "InclusiveNamespaces") throw new Fail("algorithm");
  if (!attrsWithin(only, ["PrefixList"]) || only.children.length > 0) throw new Fail("algorithm");
  const list = attr(only, "PrefixList");
  if (list === null) throw new Fail("algorithm");
  const prefixes = list.split(" ").filter((p) => p !== "");
  // Review E5 of Task 6: each prefix costs a lookup at each element, so the list is bounded.
  if (prefixes.length > PREFIX_LIST_MAX) throw new Fail("algorithm");
  for (const p of prefixes) if (p !== "#default" && !NCNAME_RE.test(p)) throw new Fail("algorithm");
  return prefixes;
}

/** An element with the `Algorithm` attribute only, equal to `algorithm`, and no content. */
function plainMethod(el: XmlElement, algorithms: readonly string[]): string {
  const value = attr(el, "Algorithm");
  if (!attrsWithin(el, ["Algorithm"]) || value === null || !algorithms.includes(value))
    throw new Fail("algorithm");
  if (!onlySpaceText(el) || elementsOf(el).length > 0) throw new Fail("algorithm");
  return value;
}

/** Each element in the subtree of `el`, `el` first, in document order. */
function* subtree(el: XmlElement): Generator<XmlElement> {
  const stack: XmlElement[] = [el];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    yield next;
    stack.push(...elementsOf(next).reverse());
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Parsed {
  signature: XmlElement;
  signedInfo: XmlElement;
  signedInfoPrefixes: string[];
  method: string;
  referencePrefixes: string[];
  digest: Uint8Array<ArrayBuffer>;
  signatureValue: Uint8Array<ArrayBuffer>;
}

/** Steps 1 to 3: the shape, the algorithms, and the two values. */
function parseSignature(target: XmlElement): Parsed {
  // Step 1: exactly one Signature child. Ruling 19 of plan 12d: another Signature in the
  // subtree is an inner enveloped signature (an IdP signs both the Response and the
  // Assertion), so it must be the child of an element with its own ID, outside this Signature.
  const signatures = childElements(target, NS_DSIG, "Signature");
  const signature = signatures[0];
  if (signatures.length !== 1 || signature === undefined) throw new Fail("signature_shape");
  for (const el of subtree(signature)) {
    if (el !== signature && isDsig(el, "Signature")) throw new Fail("signature_shape");
  }
  for (const el of subtree(target)) {
    if (el === signature || !isDsig(el, "Signature")) continue;
    const owner = el.parent;
    if (owner === null || owner === target || attr(owner, "ID") === null)
      throw new Fail("signature_shape");
  }
  // XML Signature 1.1 section 4.2: SignedInfo, SignatureValue, KeyInfo?, Object*. The profile
  // refuses each Object: the enveloped transform leaves it out of the digest, so it holds
  // unsigned content inside the signed element. KeyInfo stays, because IdPs send it.
  const parts = elementsOf(signature);
  const [signedInfo, signatureValueEl, keyInfo, ...rest] = parts;
  if (signedInfo === undefined || !isDsig(signedInfo, "SignedInfo"))
    throw new Fail("signature_shape");
  if (signatureValueEl === undefined || !isDsig(signatureValueEl, "SignatureValue"))
    throw new Fail("signature_shape");
  if (keyInfo !== undefined && !isDsig(keyInfo, "KeyInfo")) throw new Fail("signature_shape");
  if (rest.length > 0 || !onlySpaceText(signature)) throw new Fail("signature_shape");

  // Step 2: SignedInfo holds CanonicalizationMethod, SignatureMethod, and one Reference.
  if (!attrsWithin(signedInfo, ["Id"]) || !onlySpaceText(signedInfo)) throw new Fail("algorithm");
  const infoKids = elementsOf(signedInfo);
  const [canon, sigMethod, reference] = infoKids;
  if (
    infoKids.length !== 3 ||
    canon === undefined ||
    sigMethod === undefined ||
    reference === undefined ||
    !isDsig(canon, "CanonicalizationMethod") ||
    !isDsig(sigMethod, "SignatureMethod") ||
    !isDsig(reference, "Reference")
  )
    throw new Fail("algorithm");
  const signedInfoPrefixes = exclusiveMethod(canon);
  const method = plainMethod(sigMethod, [DSIG_ALGORITHMS.rsaSha256, DSIG_ALGORITHMS.ecdsaSha256]);

  // The Reference: URI, then Transforms (enveloped, then exclusive C14N), DigestMethod, DigestValue.
  if (!attrsWithin(reference, ["URI", "Id", "Type"]) || !onlySpaceText(reference))
    throw new Fail("algorithm");
  const uri = attr(reference, "URI");
  if (uri === null || uri === "" || !uri.startsWith("#")) throw new Fail("algorithm");
  const id = attr(target, "ID");
  // The URI names the target and nothing else: the digest below covers the target only.
  if (id === null || id === "" || uri !== `#${id}`) throw new Fail("algorithm");
  const refKids = elementsOf(reference);
  const [transforms, digestMethod, digestValueEl] = refKids;
  if (
    refKids.length !== 3 ||
    transforms === undefined ||
    digestMethod === undefined ||
    digestValueEl === undefined ||
    !isDsig(transforms, "Transforms") ||
    !isDsig(digestMethod, "DigestMethod") ||
    !isDsig(digestValueEl, "DigestValue")
  )
    throw new Fail("algorithm");
  if (transforms.attrs.length > 0 || !onlySpaceText(transforms)) throw new Fail("algorithm");
  const steps = elementsOf(transforms);
  const [enveloped, exclusive] = steps;
  if (
    steps.length !== 2 ||
    enveloped === undefined ||
    exclusive === undefined ||
    !isDsig(enveloped, "Transform") ||
    !isDsig(exclusive, "Transform")
  )
    throw new Fail("algorithm");
  plainMethod(enveloped, [DSIG_ALGORITHMS.enveloped]);
  const referencePrefixes = exclusiveMethod(exclusive);
  plainMethod(digestMethod, [DSIG_ALGORITHMS.sha256]);
  if (digestValueEl.attrs.length > 0) throw new Fail("algorithm");

  // Step 3: each value is one text node (a comment inside is CVE-2025-29775), in strict base64.
  const digestText = textOf(digestValueEl);
  if (!digestText.ok) throw new Fail("digest");
  const digest = strictBase64(digestText.value, XML_SPACE);
  if (digest === null || digest.length !== DIGEST_BYTES) throw new Fail("digest");
  if (!attrsWithin(signatureValueEl, ["Id"])) throw new Fail("signature");
  const valueText = textOf(signatureValueEl);
  if (!valueText.ok) throw new Fail("signature");
  const signatureValue = strictBase64(valueText.value, XML_SPACE);
  if (signatureValue === null || signatureValue.length === 0) throw new Fail("signature");

  return {
    signature,
    signedInfo,
    signedInfoPrefixes,
    method,
    referencePrefixes,
    digest,
    signatureValue,
  };
}

/** The ID values of the whole document that equal `id`, by the attributes `ID`, `Id`, and `id`. */
function idCount(target: XmlElement, id: string): number {
  let root = target;
  while (root.parent !== null) root = root.parent;
  let count = 0;
  for (const el of subtree(root)) {
    for (const a of el.attrs) {
      if (
        a.ns === null &&
        (a.local === "ID" || a.local === "Id" || a.local === "id") &&
        a.value === id
      )
        count++;
    }
  }
  return count;
}

async function verifyOne(
  key: CryptoKey,
  method: string,
  signatureValue: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  try {
    if (method === DSIG_ALGORITHMS.rsaSha256) {
      if (key.algorithm.name !== "RSASSA-PKCS1-v1_5") return false;
      return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signatureValue, data);
    }
    // Web Crypto reads an ECDSA value in the 64-byte r || s form only.
    if (key.algorithm.name !== "ECDSA" || signatureValue.length !== ECDSA_P256_BYTES) return false;
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signatureValue,
      data,
    );
  } catch {
    return false;
  }
}

/**
 * Verifies the enveloped signature of `target` with one of `keys` (one, or two for a
 * rotation). Each failure names its step; no failure says more.
 */
export async function verifyEnveloped(
  target: XmlElement,
  keys: readonly CryptoKey[],
): Promise<{ ok: true } | { ok: false; step: DsigStep }> {
  let parsed: Parsed;
  try {
    parsed = parseSignature(target);
  } catch (err) {
    if (err instanceof Fail) return { ok: false, step: err.step };
    throw err;
  }

  // The SignatureMethod matches the key type: no key of the type answers algorithm.
  const wanted = parsed.method === DSIG_ALGORITHMS.rsaSha256 ? "RSASSA-PKCS1-v1_5" : "ECDSA";
  const usable = keys.filter((k) => k.algorithm.name === wanted);
  if (usable.length === 0) return { ok: false, step: "algorithm" };

  // Step 4: the reference. A second element with the target's ID anywhere is a wrapping shape.
  const id = attr(target, "ID") ?? "";
  if (idCount(target, id) !== 1) return { ok: false, step: "reference" };
  const canonical = excC14n(target, {
    inclusivePrefixes: parsed.referencePrefixes,
    omit: parsed.signature,
  });
  const actual = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
  if (!constantTimeEqual(hex(actual), hex(parsed.digest))) return { ok: false, step: "reference" };

  // Step 5: the signature over the canonical SignedInfo; the first key that verifies passes.
  const signedInfo = new TextEncoder().encode(
    excC14n(parsed.signedInfo, { inclusivePrefixes: parsed.signedInfoPrefixes }),
  );
  for (const key of usable) {
    if (await verifyOne(key, parsed.method, parsed.signatureValue, signedInfo)) return { ok: true };
  }
  return { ok: false, step: "signature" };
}
