/**
 * A SAML 2.0 identity provider for tests (plan 12d), on Web Crypto only. It makes a key pair,
 * a self-signed certificate, and Responses signed by the owned canonicalizer. It is a test
 * tool. It never ships in an app.
 */
import { excC14n } from "../saml/c14n.js";
import { DSIG_ALGORITHMS, NS_DSIG } from "../saml/dsig.js";
import { parseXml, type XmlElement, type XmlNode } from "../saml/xml.js";
import { certificateDer, pem } from "./der-writer.js";

export interface TestResponseInput {
  audience: string;
  recipient: string;
  /** The Response `Destination`. Undefined writes `recipient`; null writes no attribute. */
  destination?: string | null;
  inResponseTo: string;
  nameId: string;
  nameIdFormat?: string;
  attributes?: Record<string, string[]>;
  notBefore: Date;
  notOnOrAfter: Date;
  authnContext?: string;
  sessionNotOnOrAfter?: Date;
  /** Signs the Response too. Default false. */
  signResponse?: boolean;
  /** Signs the Assertion. Default true. */
  signAssertion?: boolean;
  /** The Assertion `Issuer`. Default the entity id. The Response `Issuer` stays the entity id. */
  issuer?: string;
  now: Date;
}

export interface TestIdp {
  entityId: string;
  certificatePem: string;
  /** The PKCS #8 private key, so a second, independent signer can sign with the same key. */
  privateKeyPem: string;
  response(input: TestResponseInput): Promise<string>;
  /** Signs the element whose `ID` is `targetId` (an old signature of it is replaced). */
  sign(xml: string, targetId: string): Promise<string>;
}

const NS_SAML = "urn:oasis:names:tc:SAML:2.0:assertion";
const NS_SAMLP = "urn:oasis:names:tc:SAML:2.0:protocol";
const PERSISTENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
const PASSWORD_TRANSPORT = "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport";

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#xD;");
}

function escapeAttr(value: string): string {
  return escapeText(value)
    .replaceAll('"', "&quot;")
    .replaceAll("\t", "&#x9;")
    .replaceAll("\n", "&#xA;");
}

/** Writes a parsed tree back as text, with each declaration and attribute where it was. */
export function serializeXml(el: XmlElement): string {
  const out: string[] = [];
  const write = (node: XmlNode): void => {
    if (node.kind === "text") {
      out.push(escapeText(node.value));
      return;
    }
    if (node.kind === "comment") {
      out.push(`<!--${node.value}-->`);
      return;
    }
    const tag = node.prefix === null ? node.local : `${node.prefix}:${node.local}`;
    out.push("<", tag);
    for (const d of node.nsDecls) {
      out.push(d.prefix === null ? " xmlns" : ` xmlns:${d.prefix}`, '="', escapeAttr(d.uri), '"');
    }
    for (const a of node.attrs) {
      const attrName = a.prefix === null ? a.local : `${a.prefix}:${a.local}`;
      out.push(" ", attrName, '="', escapeAttr(a.value), '"');
    }
    if (node.children.length === 0) {
      out.push("/>");
      return;
    }
    out.push(">");
    for (const child of node.children) write(child);
    out.push("</", tag, ">");
  };
  write(el);
  return out.join("");
}

/** Parses a document of the profile, or throws with the refusal. */
export function parseOrThrow(xml: string): XmlElement {
  const parsed = parseXml(xml);
  if (!parsed.ok) throw new Error(`test IdP: parse refused at ${parsed.at}: ${parsed.refusal}`);
  return parsed.root;
}

/** Each element in the subtree of `el`, `el` first, in document order. */
export function elementsIn(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  const stack: XmlElement[] = [el];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    out.push(next);
    const kids = next.children.filter((c): c is XmlElement => c.kind === "element");
    stack.push(...kids.reverse());
  }
  return out;
}

/** The value of the attribute with no namespace and this local name, or null. */
export function attrOf(el: XmlElement, local: string): string | null {
  for (const a of el.attrs) if (a.ns === null && a.local === local) return a.value;
  return null;
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return `_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** An `xs:dateTime` in UTC with a `Z` and whole seconds. */
function instant(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function certificateBase64(certificatePem: string): string {
  return certificatePem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s/g, "");
}

/**
 * Puts an enveloped signature on `target`, after its `Issuer` child when it has one (the
 * schema place in SAML). An old signature of `target` goes first.
 */
async function signElement(
  target: XmlElement,
  key: CryptoKey,
  certificatePem: string,
): Promise<void> {
  target.children = target.children.filter(
    (c) => !(c.kind === "element" && c.ns === NS_DSIG && c.local === "Signature"),
  );
  const id = attrOf(target, "ID");
  if (id === null) throw new Error("test IdP: the target has no ID");
  const rsa = key.algorithm.name === "RSASSA-PKCS1-v1_5";
  const method = rsa ? DSIG_ALGORITHMS.rsaSha256 : DSIG_ALGORITHMS.ecdsaSha256;
  const signature = parseOrThrow(
    `<ds:Signature xmlns:ds="${NS_DSIG}"><ds:SignedInfo>` +
      `<ds:CanonicalizationMethod Algorithm="${DSIG_ALGORITHMS.c14n}"/>` +
      `<ds:SignatureMethod Algorithm="${method}"/>` +
      `<ds:Reference URI="#${escapeAttr(id)}"><ds:Transforms>` +
      `<ds:Transform Algorithm="${DSIG_ALGORITHMS.enveloped}"/>` +
      `<ds:Transform Algorithm="${DSIG_ALGORITHMS.c14n}"/>` +
      `</ds:Transforms><ds:DigestMethod Algorithm="${DSIG_ALGORITHMS.sha256}"/>` +
      "<ds:DigestValue></ds:DigestValue></ds:Reference></ds:SignedInfo>" +
      "<ds:SignatureValue></ds:SignatureValue><ds:KeyInfo><ds:X509Data><ds:X509Certificate>" +
      certificateBase64(certificatePem) +
      "</ds:X509Certificate></ds:X509Data></ds:KeyInfo></ds:Signature>",
  );
  signature.parent = target;
  const first = target.children.findIndex((c) => c.kind === "element");
  const firstEl = target.children[first];
  const after = firstEl?.kind === "element" && firstEl.local === "Issuer" ? first + 1 : 0;
  target.children.splice(after, 0, signature);

  const [signedInfo, signatureValue] = signature.children.filter(
    (c): c is XmlElement => c.kind === "element",
  );
  const digestValue = elementsIn(signature).find((e) => e.local === "DigestValue");
  if (signedInfo === undefined || signatureValue === undefined || digestValue === undefined)
    throw new Error("test IdP: the signature template is wrong");

  const canonical = excC14n(target, { inclusivePrefixes: [], omit: signature });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  digestValue.children = [{ kind: "text", value: base64(new Uint8Array(digest)) }];

  const info = new TextEncoder().encode(excC14n(signedInfo, { inclusivePrefixes: [] }));
  const value = rsa
    ? await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, info)
    : await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, info);
  signatureValue.children = [{ kind: "text", value: base64(new Uint8Array(value)) }];
}

/** Makes a test IdP with an RSA 2048 or a P-256 key pair and a self-signed certificate. */
export async function createTestIdp(options: {
  alg: "rsa" | "ec";
  entityId?: string;
}): Promise<TestIdp> {
  const pair = (
    options.alg === "rsa"
      ? await crypto.subtle.generateKey(
          {
            name: "RSASSA-PKCS1-v1_5",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256",
          },
          true,
          ["sign", "verify"],
        )
      : await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
          "sign",
          "verify",
        ])
  ) as CryptoKeyPair;
  const entityId = options.entityId ?? "https://idp.example/metadata";
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const der = await certificateDer({
    spki,
    signer: pair.privateKey,
    commonName: "authtempo test idp",
    notBefore: new Date(Date.UTC(2025, 0, 1)),
    notAfter: new Date(Date.UTC(2045, 0, 1)),
  });
  const certificatePem = pem("CERTIFICATE", der);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const privateKeyPem = pem("PRIVATE KEY", pkcs8);

  const sign = async (xml: string, targetId: string): Promise<string> => {
    const root = parseOrThrow(xml);
    const targets = elementsIn(root).filter((e) => attrOf(e, "ID") === targetId);
    const target = targets[0];
    if (targets.length !== 1 || target === undefined)
      throw new Error("test IdP: the ID must name exactly one element");
    await signElement(target, pair.privateKey, certificatePem);
    return serializeXml(root);
  };

  const response = async (input: TestResponseInput): Promise<string> => {
    const responseId = randomId();
    const assertionId = randomId();
    const at = escapeAttr;
    const destination = input.destination === undefined ? input.recipient : input.destination;
    const attributes = Object.entries(input.attributes ?? {});
    const session =
      input.sessionNotOnOrAfter === undefined
        ? ""
        : ` SessionNotOnOrAfter="${instant(input.sessionNotOnOrAfter)}"`;
    const xml =
      `<samlp:Response xmlns:samlp="${NS_SAMLP}" xmlns:saml="${NS_SAML}" ID="${responseId}"` +
      ` Version="2.0" IssueInstant="${instant(input.now)}"` +
      (destination === null ? "" : ` Destination="${at(destination)}"`) +
      ` InResponseTo="${at(input.inResponseTo)}">` +
      `<saml:Issuer>${escapeText(entityId)}</saml:Issuer>` +
      '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>' +
      `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${instant(input.now)}">` +
      `<saml:Issuer>${escapeText(input.issuer ?? entityId)}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="${at(input.nameIdFormat ?? PERSISTENT)}">` +
      `${escapeText(input.nameId)}</saml:NameID>` +
      '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">' +
      `<saml:SubjectConfirmationData InResponseTo="${at(input.inResponseTo)}"` +
      ` NotOnOrAfter="${instant(input.notOnOrAfter)}" Recipient="${at(input.recipient)}"/>` +
      "</saml:SubjectConfirmation></saml:Subject>" +
      `<saml:Conditions NotBefore="${instant(input.notBefore)}" NotOnOrAfter="${instant(input.notOnOrAfter)}">` +
      `<saml:AudienceRestriction><saml:Audience>${escapeText(input.audience)}</saml:Audience>` +
      "</saml:AudienceRestriction></saml:Conditions>" +
      `<saml:AuthnStatement AuthnInstant="${instant(input.now)}" SessionIndex="${assertionId}"${session}>` +
      `<saml:AuthnContext><saml:AuthnContextClassRef>${escapeText(input.authnContext ?? PASSWORD_TRANSPORT)}` +
      "</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>" +
      (attributes.length === 0
        ? ""
        : `<saml:AttributeStatement>${attributes
            .map(
              ([key, values]) =>
                `<saml:Attribute Name="${at(key)}">${values
                  .map((v) => `<saml:AttributeValue>${escapeText(v)}</saml:AttributeValue>`)
                  .join("")}</saml:Attribute>`,
            )
            .join("")}</saml:AttributeStatement>`) +
      "</saml:Assertion></samlp:Response>";
    let signed = xml;
    if (input.signAssertion ?? true) signed = await sign(signed, assertionId);
    if (input.signResponse ?? false) signed = await sign(signed, responseId);
    return signed;
  };

  return { entityId, certificatePem, privateKeyPem, response, sign };
}
