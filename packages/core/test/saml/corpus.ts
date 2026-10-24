/**
 * The SAML attack corpus (plan 12d Task 7). Each case takes a valid signed Response and the
 * test IdP that signed it. It answers the attack text: one named edit of the valid text.
 * Each case asserts that its output differs from its input, so no case runs unchanged.
 *
 * XSW1 to XSW8 are the shapes of "On Breaking SAML: Be Whoever You Want to Be" (Somorovsky
 * and others, USENIX Security 2012). In each shape, the evil Assertion holds the NameID
 * `EVIL_NAME_ID`, so a test can find the element that a naive reader would read.
 */
import { NS_SAML, NS_SAMLP } from "../../src/saml/assertion.js";
import { excC14n } from "../../src/saml/c14n.js";
import { DSIG_ALGORITHMS, NS_DSIG } from "../../src/saml/dsig.js";
import type { XmlElement, XmlNode } from "../../src/saml/xml.js";
import {
  attrOf,
  createTestIdp,
  elementsIn,
  parseOrThrow,
  serializeXml,
  type TestIdp,
  type TestResponseInput,
} from "../../src/testing/saml-idp.js";

export { NS_SAML, NS_SAMLP } from "../../src/saml/assertion.js";
export const EVIL_NAME_ID = "evil@attacker.example";
const SHA1_DIGEST = "http://www.w3.org/2000/09/xmldsig#sha1";

export type CorpusCase = (xml: string, idp: TestIdp) => Promise<string>;

/** A Response input of the tests, valid at `now`. */
export function validInput(now: Date, extra: Partial<TestResponseInput> = {}): TestResponseInput {
  return {
    audience: "https://sp.example/auth/sso/conn_1/metadata",
    recipient: "https://sp.example/auth/sso/conn_1/acs",
    inResponseTo: "_request1",
    nameId: "user-123",
    attributes: { email: ["alice@acme.example"] },
    notBefore: new Date(now.getTime() - 60_000),
    notOnOrAfter: new Date(now.getTime() + 5 * 60_000),
    now,
    ...extra,
  };
}

/** The elements of the subtree of `el` with this namespace and local name, in document order. */
export function find(el: XmlElement, ns: string, local: string): XmlElement[] {
  return elementsIn(el).filter((e) => e.ns === ns && e.local === local);
}

function one(el: XmlElement, ns: string, local: string): XmlElement {
  const found = find(el, ns, local)[0];
  if (found === undefined) throw new Error(`corpus: no ${local}`);
  return found;
}

function kids(el: XmlElement): XmlElement[] {
  return el.children.filter((c): c is XmlElement => c.kind === "element");
}

/** A deep copy of `el` under `parent`. */
function clone(el: XmlElement, parent: XmlElement | null): XmlElement {
  const copy: XmlElement = {
    kind: "element",
    prefix: el.prefix,
    local: el.local,
    ns: el.ns,
    attrs: el.attrs.map((a) => ({ ...a })),
    nsDecls: el.nsDecls.map((d) => ({ ...d })),
    children: [],
    parent,
  };
  copy.children = el.children.map(
    (c): XmlNode => (c.kind === "element" ? clone(c, copy) : { ...c }),
  );
  return copy;
}

function element(prefix: string | null, local: string, ns: string, parent: XmlElement): XmlElement {
  return { kind: "element", prefix, local, ns, attrs: [], nsDecls: [], children: [], parent };
}

function setId(el: XmlElement, id: string): void {
  const a = el.attrs.find((x) => x.ns === null && x.local === "ID");
  if (a === undefined) throw new Error("corpus: no ID");
  a.value = id;
}

function setNameId(assertion: XmlElement, value: string): void {
  one(assertion, NS_SAML, "NameID").children = [{ kind: "text", value }];
}

/** The direct Signature child of `el`, or undefined. */
function signatureOf(el: XmlElement): XmlElement | undefined {
  return kids(el).find((k) => k.ns === NS_DSIG && k.local === "Signature");
}

function removeSignature(el: XmlElement): void {
  el.children = el.children.filter((c) => !(c.kind === "element" && c === signatureOf(el)));
}

function detach(el: XmlElement): void {
  const parent = el.parent;
  if (parent === null) throw new Error("corpus: no parent");
  parent.children = parent.children.filter((c) => c !== el);
}

function insertBefore(el: XmlElement, before: XmlElement): void {
  const parent = before.parent;
  if (parent === null) throw new Error("corpus: no parent");
  el.parent = parent;
  parent.children.splice(parent.children.indexOf(before), 0, el);
}

function append(el: XmlElement, parent: XmlElement): void {
  el.parent = parent;
  parent.children.push(el);
}

function replace(old: XmlElement, next: XmlElement): void {
  insertBefore(next, old);
  detach(old);
}

/** The Response, and its one Assertion. */
function open(xml: string): { root: XmlElement; assertion: XmlElement } {
  const root = parseOrThrow(xml);
  const assertion = kids(root).find((k) => k.ns === NS_SAML && k.local === "Assertion");
  if (assertion === undefined) throw new Error("corpus: no Assertion child");
  return { root, assertion };
}

/** An evil copy of the Assertion: a new ID and `EVIL_NAME_ID`; its signature stays when `keep`. */
function evilCopy(assertion: XmlElement, keep: boolean): XmlElement {
  const evil = clone(assertion, null);
  setId(evil, "_evil_assertion");
  setNameId(evil, EVIL_NAME_ID);
  if (!keep) removeSignature(evil);
  return evil;
}

function changed(input: string, output: string): string {
  if (output === input) throw new Error("corpus: the case did not change its input");
  return output;
}

/** The Response with its own signature: the case signs it when the input has none. */
async function withSignedResponse(xml: string, idp: TestIdp): Promise<string> {
  const root = parseOrThrow(xml);
  if (signatureOf(root) !== undefined) return xml;
  const id = attrOf(root, "ID");
  if (id === null) throw new Error("corpus: no Response ID");
  return idp.sign(xml, id);
}

/** XSW1: a copy of the signed Response goes inside its Signature; the outer one is evil. */
export const xsw1: CorpusCase = async (xml, idp) => {
  const { root, assertion } = open(await withSignedResponse(xml, idp));
  const original = clone(root, null);
  removeSignature(original);
  setId(root, "_evil_response");
  setNameId(assertion, EVIL_NAME_ID);
  const signature = signatureOf(root);
  if (signature === undefined) throw new Error("corpus: no Response signature");
  append(original, signature);
  return changed(xml, serializeXml(root));
};

/** XSW2: a copy of the signed Response goes beside its Signature; the outer one is evil. */
export const xsw2: CorpusCase = async (xml, idp) => {
  const { root, assertion } = open(await withSignedResponse(xml, idp));
  const original = clone(root, null);
  removeSignature(original);
  setId(root, "_evil_response");
  setNameId(assertion, EVIL_NAME_ID);
  const signature = signatureOf(root);
  if (signature === undefined) throw new Error("corpus: no Response signature");
  insertBefore(original, signature);
  return changed(xml, serializeXml(root));
};

/** XSW3: an evil Assertion with no signature goes before the signed one. */
export const xsw3: CorpusCase = async (xml) => {
  const { root, assertion } = open(xml);
  insertBefore(evilCopy(assertion, false), assertion);
  return changed(xml, serializeXml(root));
};

/** XSW4: an evil Assertion with no signature holds the signed one as its child. */
export const xsw4: CorpusCase = async (xml) => {
  const { root, assertion } = open(xml);
  const evil = evilCopy(assertion, false);
  replace(assertion, evil);
  append(assertion, evil);
  return changed(xml, serializeXml(root));
};

/** XSW5: the signature moves onto an evil Assertion; the original, unsigned, goes last. */
export const xsw5: CorpusCase = async (xml) => {
  const { root, assertion } = open(xml);
  const evil = evilCopy(assertion, true);
  replace(assertion, evil);
  removeSignature(assertion);
  append(assertion, root);
  return changed(xml, serializeXml(root));
};

/** XSW6: the signature moves onto an evil Assertion; the original, unsigned, goes inside it. */
export const xsw6: CorpusCase = async (xml) => {
  const { root, assertion } = open(xml);
  const evil = evilCopy(assertion, true);
  replace(assertion, evil);
  removeSignature(assertion);
  const signature = signatureOf(evil);
  if (signature === undefined) throw new Error("corpus: no signature");
  append(assertion, signature);
  return changed(xml, serializeXml(root));
};

/** XSW7: an evil Assertion with no signature goes inside an Extensions element. */
export const xsw7: CorpusCase = async (xml) => {
  const { root, assertion } = open(xml);
  const status = one(root, NS_SAMLP, "Status");
  const extensions = element(status.prefix, "Extensions", NS_SAMLP, root);
  append(evilCopy(assertion, false), extensions);
  insertBefore(extensions, status);
  return changed(xml, serializeXml(root));
};

/** XSW8: the signature moves onto an evil Assertion; the original, unsigned, goes in its Object. */
export const xsw8: CorpusCase = async (xml) => {
  const { root, assertion } = open(xml);
  const evil = evilCopy(assertion, true);
  replace(assertion, evil);
  removeSignature(assertion);
  const signature = signatureOf(evil);
  if (signature === undefined) throw new Error("corpus: no signature");
  const object = element(signature.prefix, "Object", NS_DSIG, signature);
  append(assertion, object);
  append(object, signature);
  return changed(xml, serializeXml(root));
};

/** A comment splits the NameID (CVE-2017-11427). C14N drops the comment: the signature holds. */
export const commentInNameId: CorpusCase = async (xml) => {
  const { root, assertion } = open(xml);
  const nameId = one(assertion, NS_SAML, "NameID");
  const [text] = nameId.children;
  if (text?.kind !== "text" || text.value.length < 2) throw new Error("corpus: NameID text");
  nameId.children = [
    { kind: "text", value: text.value.slice(0, 1) },
    { kind: "comment", value: "" },
    { kind: "text", value: text.value.slice(1) },
  ];
  return changed(xml, serializeXml(root));
};

function base64(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * CVE-2025-29775: the NameID changes, and the DigestValue holds the evil digest in a comment
 * before the original digest. C14N drops the comment, so SignedInfo still verifies.
 */
export const commentInDigestValue: CorpusCase = async (xml) => {
  const { root, assertion } = open(xml);
  setNameId(assertion, EVIL_NAME_ID);
  const signature = signatureOf(assertion);
  if (signature === undefined) throw new Error("corpus: no signature");
  const digestValue = one(signature, NS_DSIG, "DigestValue");
  const original = digestValue.children[0];
  if (original?.kind !== "text") throw new Error("corpus: DigestValue text");
  const canonical = excC14n(assertion, { inclusivePrefixes: [], omit: signature });
  const evil = base64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  digestValue.children = [{ kind: "comment", value: evil }, original];
  return changed(xml, serializeXml(root));
};

/** A second, unsigned Assertion after the signed one. */
export const secondAssertion: CorpusCase = async (xml) => {
  const { root, assertion } = open(xml);
  append(evilCopy(assertion, false), root);
  return changed(xml, serializeXml(root));
};

/** The Response takes the ID of the Assertion. */
export const duplicateId: CorpusCase = async (xml) => {
  const { root, assertion } = open(xml);
  const id = attrOf(assertion, "ID");
  if (id === null) throw new Error("corpus: no Assertion ID");
  setId(root, id);
  return changed(xml, serializeXml(root));
};

/** A DOCTYPE with an internal entity that the NameID uses. */
export const doctypeEntity: CorpusCase = async (xml) => {
  const { root, assertion } = open(xml);
  setNameId(assertion, "ENTITY_PLACE");
  const text = serializeXml(root).replace("ENTITY_PLACE", "&e;");
  const doctype = `<!DOCTYPE samlp:Response [<!ENTITY e "${EVIL_NAME_ID}">]>`;
  return changed(xml, `<?xml version="1.0"?>\n${doctype}\n${text}`);
};

/** The IdP signs the Response only: the Assertion has no signature. */
export const unsignedAssertionInSignedResponse: CorpusCase = async (xml, idp) => {
  const { root, assertion } = open(xml);
  removeSignature(assertion);
  removeSignature(root);
  const id = attrOf(root, "ID");
  if (id === null) throw new Error("corpus: no Response ID");
  return changed(xml, await idp.sign(serializeXml(root), id));
};

/** Imports the IdP's PKCS #8 key for `sign`, of the type of its SignatureMethod. */
async function idpSigningKey(idp: TestIdp, rsa: boolean): Promise<CryptoKey> {
  const body = idp.privateKeyPem
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return rsa
    ? crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
        "sign",
      ])
    : crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
      ]);
}

/** A valid signature by the IdP's own key, with a SHA-1 digest of the Assertion. */
export const sha1Digest: CorpusCase = async (xml, idp) => {
  const { root, assertion } = open(xml);
  const signature = signatureOf(assertion);
  if (signature === undefined) throw new Error("corpus: no signature");
  const digestMethod = one(signature, NS_DSIG, "DigestMethod");
  const algorithm = digestMethod.attrs.find((a) => a.local === "Algorithm");
  if (algorithm === undefined) throw new Error("corpus: no DigestMethod Algorithm");
  algorithm.value = SHA1_DIGEST;
  const canonical = excC14n(assertion, { inclusivePrefixes: [], omit: signature });
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(canonical));
  one(signature, NS_DSIG, "DigestValue").children = [{ kind: "text", value: base64(digest) }];
  const method = attrOf(one(signature, NS_DSIG, "SignatureMethod"), "Algorithm");
  const rsa = method === DSIG_ALGORITHMS.rsaSha256;
  const key = await idpSigningKey(idp, rsa);
  const info = new TextEncoder().encode(
    excC14n(one(signature, NS_DSIG, "SignedInfo"), { inclusivePrefixes: [] }),
  );
  const value = rsa
    ? await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, info)
    : await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, info);
  one(signature, NS_DSIG, "SignatureValue").children = [{ kind: "text", value: base64(value) }];
  return changed(xml, serializeXml(root));
};

/** The attacker changes the NameID and signs with its own key, with its certificate in KeyInfo. */
export const attackerKeyInfo: CorpusCase = async (xml) => {
  const { root, assertion } = open(xml);
  setNameId(assertion, EVIL_NAME_ID);
  const id = attrOf(assertion, "ID");
  if (id === null) throw new Error("corpus: no Assertion ID");
  const attacker = await createTestIdp({ alg: "rsa", entityId: "https://idp.example/metadata" });
  return changed(xml, await attacker.sign(serializeXml(root), id));
};
