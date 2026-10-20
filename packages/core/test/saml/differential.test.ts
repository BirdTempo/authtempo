/**
 * The differential test of plan 12d: the owned canonicalizer and signature check against
 * `xml-crypto` 6.3.3, a dev dependency of core only. A difference is a finding: the test
 * prints the seed and the document of the first one.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { ExclusiveCanonicalization, findAncestorNs, SignedXml } from "xml-crypto";
import { excC14n } from "../../src/saml/c14n.js";
import { importVerifyKey, readCertificate } from "../../src/saml/der.js";
import { DSIG_ALGORITHMS, NS_DSIG, verifyEnveloped } from "../../src/saml/dsig.js";
import { childElements, parseXml, type XmlElement } from "../../src/saml/xml.js";
import { createTestIdp, type TestIdp } from "../../src/testing/saml-idp.js";
import { commentInDigestValue, find, NS_SAML, NS_SAMLP, validInput } from "./corpus.js";

/** The parts of the `@xmldom/xmldom` DOM that this test reads. */
interface DomElement {
  namespaceURI: string | null;
  localName: string;
  childNodes: { length: number; [i: number]: DomElement };
  removeChild(child: DomElement): void;
  getElementsByTagNameNS(ns: string, local: string): { length: number; [i: number]: DomElement };
}
interface DomDocument {
  getElementsByTagNameNS(ns: string, local: string): { length: number; [i: number]: DomElement };
}

interface Xmldom {
  DOMParser: new () => { parseFromString(xml: string, type: string): DomDocument };
}
interface NodeModule {
  createRequire(from: string): { (id: string): unknown; resolve(id: string): string };
}
/**
 * Core's typecheck has no Node types, because core runs on Workers; vitest runs in Node. A
 * specifier in a constant keeps the import out of the typecheck.
 */
const MODULE_MODULE = "node:module";
let xmldom: Xmldom;

const NS_XS = "http://www.w3.org/2001/XMLSchema";
const NS_XSI = "http://www.w3.org/2001/XMLSchema-instance";
const NS_EXT = "urn:example:ext";

/** mulberry32: a small seeded generator, so each document can be made again from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Node {
  ns: string;
  local: string;
  attrs: { ns: string | null; local: string; value: string }[];
  children: (Node | string)[];
}

type Place = "root" | "assertion" | "each";

/**
 * One generated Response: the text, and the PrefixList of its reference. Every prefix is
 * lower case, and no two attribute namespaces have one URI as the start of the other: on
 * those two inputs xml-crypto 6.3.3 leaves the W3C sort order, and two rows of this
 * file pin the W3C form of each.
 */
function generate(seed: number): { xml: string; prefixes: string[] } {
  const r = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(r() * items.length)] as T;
  const chance = (p: number): boolean => r() < p;

  // The prefix of each namespace; at most one of SAML and SAML protocol takes the default.
  const defaultFor = pick(["none", "saml", "samlp", "ds"] as const);
  const prefixOf = new Map<string, string | null>([
    [NS_SAMLP, defaultFor === "samlp" ? null : pick(["samlp", "p", "sp", "protocol"])],
    [NS_SAML, defaultFor === "saml" ? null : pick(["saml", "a", "s", "assertion"])],
    [NS_DSIG, defaultFor === "ds" ? null : pick(["ds", "dsig", "sig"])],
    [NS_XS, pick(["xs", "xsd"])],
    [NS_XSI, pick(["xsi", "i"])],
    [NS_EXT, pick(["ext", "e", "z"])],
  ]);
  const place = new Map<string, Place>();
  for (const ns of prefixOf.keys()) place.set(ns, pick(["root", "assertion", "each"] as const));
  // A default namespace other than the root's is declared where it is used.
  if (defaultFor === "ds" || defaultFor === "saml")
    place.set(defaultFor === "ds" ? NS_DSIG : NS_SAML, "each");

  const texts = [
    "plain",
    "a & b",
    "x < y > z",
    "quote \" and ' apostrophe",
    "tab\tand\nline",
    "café 日本 😀",
    "carriage\rreturn",
    "  spaced  ",
  ];
  const text = (): string => pick(texts);
  const el = (
    ns: string,
    local: string,
    attrs: Node["attrs"] = [],
    children: Node["children"] = [],
  ): Node => {
    const extra = chance(0.2) ? [{ ns: NS_EXT, local: "tag", value: text() }] : [];
    return { ns, local, attrs: [...attrs, ...extra], children };
  };
  const a = (local: string, value: string) => ({ ns: null, local, value });
  const spaces = () => (chance(0.3) ? [pick(["\n", "\n  ", " "])] : []);

  const signature = el(
    NS_DSIG,
    "Signature",
    [],
    [
      el(
        NS_DSIG,
        "SignedInfo",
        [],
        [
          el(NS_DSIG, "CanonicalizationMethod", [a("Algorithm", DSIG_ALGORITHMS.c14n)]),
          el(NS_DSIG, "SignatureMethod", [a("Algorithm", DSIG_ALGORITHMS.rsaSha256)]),
        ],
      ),
      el(NS_DSIG, "SignatureValue", [], ["AAAA"]),
    ],
  );
  const attributes = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) =>
    el(
      NS_SAML,
      "Attribute",
      [a("Name", `attr${i}`), a("NameFormat", "urn:oasis:names:tc:SAML:2.0:attrname-format:basic")],
      [
        el(
          NS_SAML,
          "AttributeValue",
          chance(0.6)
            ? [{ ns: NS_XSI, local: "type", value: `${prefixOf.get(NS_XS)}:string` }]
            : [],
          [text()],
        ),
      ],
    ),
  );
  const assertion = el(
    NS_SAML,
    "Assertion",
    [a("ID", "_a1"), a("Version", "2.0"), a("IssueInstant", "2026-10-20T08:00:00Z")],
    [
      ...spaces(),
      el(NS_SAML, "Issuer", [], [text()]),
      ...spaces(),
      signature,
      el(
        NS_SAML,
        "Subject",
        [],
        [
          el(
            NS_SAML,
            "NameID",
            [
              a("Format", "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"),
              a("SPNameQualifier", text()),
            ],
            [text()],
          ),
          el(
            NS_SAML,
            "SubjectConfirmation",
            [a("Method", "urn:oasis:names:tc:SAML:2.0:cm:bearer")],
            [
              el(NS_SAML, "SubjectConfirmationData", [
                a("Recipient", "https://sp.example/acs?a=1&b=2"),
                a("NotOnOrAfter", "2026-10-20T08:05:00Z"),
                a("InResponseTo", "_r"),
              ]),
            ],
          ),
        ],
      ),
      ...spaces(),
      el(
        NS_SAML,
        "Conditions",
        [a("NotBefore", "2026-10-20T07:59:00Z"), a("NotOnOrAfter", "2026-10-20T08:05:00Z")],
        [el(NS_SAML, "AudienceRestriction", [], [el(NS_SAML, "Audience", [], [text()])])],
      ),
      el(NS_SAML, "AttributeStatement", [], attributes),
      ...spaces(),
    ],
  );
  const root = el(
    NS_SAMLP,
    "Response",
    [a("ID", "_r1"), a("Version", "2.0"), a("Destination", text())],
    [
      el(NS_SAML, "Issuer", [], [text()]),
      el(
        NS_SAMLP,
        "Status",
        [],
        [el(NS_SAMLP, "StatusCode", [a("Value", "urn:oasis:names:tc:SAML:2.0:status:Success")])],
      ),
      assertion,
    ],
  );

  // The escapes: each special character takes one of its legal forms at random.
  const escText = (s: string): string =>
    [...s]
      .map((c) => {
        if (c === "&") return pick(["&amp;", "&#38;", "&#x26;"]);
        if (c === "<") return pick(["&lt;", "&#60;"]);
        if (c === ">") return pick([">", "&gt;", "&#62;"]);
        if (c === "\r") return pick(["&#13;", "&#xD;"]);
        if (c === "\t") return pick(["\t", "&#9;"]);
        if (c === "é") return pick(["é", "&#233;", "&#xE9;"]);
        return c;
      })
      .join("");
  const escAttr = (s: string, quote: string): string =>
    [...s]
      .map((c) => {
        if (c === "&") return pick(["&amp;", "&#38;"]);
        if (c === "<") return pick(["&lt;", "&#60;"]);
        if (c === '"') return quote === '"' ? pick(["&quot;", "&#34;"]) : c;
        if (c === "'") return quote === "'" ? pick(["&apos;", "&#39;"]) : c;
        if (c === "\t") return "&#9;";
        if (c === "\n") return "&#10;";
        if (c === "\r") return "&#13;";
        return c;
      })
      .join("");

  const out: string[] = [];
  const write = (node: Node, scope: Map<string, string>, isRoot: boolean): void => {
    const own = new Map<string, string>();
    const declare = (ns: string): void => {
      const prefix = prefixOf.get(ns) ?? null;
      own.set(prefix ?? "", ns);
    };
    for (const [ns, where] of place) {
      if ((where === "root" && isRoot) || (where === "assertion" && node === assertion))
        declare(ns);
    }
    const used = [node.ns, ...node.attrs.flatMap((x) => (x.ns === null ? [] : [x.ns]))];
    for (const ns of used) {
      const prefix = prefixOf.get(ns) ?? null;
      if (place.get(ns) === "each" || (own.get(prefix ?? "") ?? scope.get(prefix ?? "")) !== ns)
        declare(ns);
    }
    // A prefixed attribute namespace never takes the default.
    for (const x of node.attrs)
      if (x.ns !== null && prefixOf.get(x.ns) === null) throw new Error("bad generator");
    const inner = new Map([...scope, ...own]);
    const prefix = prefixOf.get(node.ns) ?? null;
    const tag = prefix === null ? node.local : `${prefix}:${node.local}`;
    const items: string[] = [];
    for (const [p, ns] of own) items.push(p === "" ? ` xmlns="${ns}"` : ` xmlns:${p}="${ns}"`);
    for (const x of node.attrs) {
      const q = pick(['"', "'"]);
      const name = x.ns === null ? x.local : `${prefixOf.get(x.ns)}:${x.local}`;
      items.push(` ${name}=${q}${escAttr(x.value, q)}${q}`);
    }
    // The order of attributes and declarations on the tag is random.
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [items[i], items[j]] = [items[j] as string, items[i] as string];
    }
    out.push(`<${tag}${items.join("")}`);
    if (node.children.length === 0 && chance(0.5)) {
      out.push(pick(["/>", " />"]));
      return;
    }
    out.push(">");
    for (const child of node.children) {
      if (typeof child === "string") out.push(escText(child));
      else write(child, inner, false);
    }
    out.push(`</${tag}>`);
  };
  write(root, new Map(), true);

  const candidates = [...prefixOf.entries()].map(([, p]) => p ?? "#default");
  const prefixes = candidates.filter(() => chance(0.3));
  if (chance(0.2)) prefixes.push("unused");
  return { xml: out.join(""), prefixes };
}

function ours(xml: string, prefixes: string[]): string {
  const parsed = parseXml(xml);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal} at ${parsed.at}`);
  const [assertion] = find(parsed.root, NS_SAML, "Assertion");
  if (assertion === undefined) throw new Error("no Assertion");
  const [signature] = childElements(assertion, NS_DSIG, "Signature");
  return excC14n(assertion, { inclusivePrefixes: prefixes, omit: signature ?? null });
}

function theirs(xml: string, prefixes: string[]): string {
  const doc = new xmldom.DOMParser().parseFromString(xml, "text/xml");
  const assertion = doc.getElementsByTagNameNS(NS_SAML, "Assertion")[0];
  if (assertion === undefined) throw new Error("no Assertion");
  for (let i = 0; i < assertion.childNodes.length; i++) {
    const child = assertion.childNodes[i];
    if (child?.namespaceURI === NS_DSIG && child.localName === "Signature") {
      assertion.removeChild(child);
      break;
    }
  }
  const ancestorNamespaces = findAncestorNs(doc as never, "//*[local-name(.)='Assertion']");
  return new ExclusiveCanonicalization().process(assertion as never, {
    inclusiveNamespacesPrefixList: prefixes,
    ancestorNamespaces,
  });
}

function xmlCryptoAccepts(xml: string, idp: TestIdp): boolean {
  const doc = new xmldom.DOMParser().parseFromString(xml, "text/xml");
  const assertion = doc.getElementsByTagNameNS(NS_SAML, "Assertion")[0];
  const signature = assertion?.getElementsByTagNameNS(NS_DSIG, "Signature")[0];
  if (signature === undefined) return false;
  const check = new SignedXml({ publicCert: idp.certificatePem });
  try {
    check.loadSignature(signature as never);
    return check.checkSignature(xml);
  } catch {
    return false;
  }
}

function assertionOf(xml: string): XmlElement {
  const parsed = parseXml(xml);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal}`);
  const [assertion] = find(parsed.root, NS_SAML, "Assertion");
  if (assertion === undefined) throw new Error("no Assertion");
  return assertion;
}

const now = new Date("2026-10-20T08:00:00Z");
let idp: TestIdp;
let key: CryptoKey;

beforeAll(async () => {
  // xmldom is a dependency of xml-crypto, not of core: resolve it from xml-crypto's place.
  const { createRequire }: NodeModule = await import(/* @vite-ignore */ MODULE_MODULE);
  const xmlCrypto = createRequire(import.meta.url).resolve("xml-crypto");
  xmldom = createRequire(xmlCrypto)("@xmldom/xmldom") as Xmldom;
  idp = await createTestIdp({ alg: "rsa" });
  const info = readCertificate(idp.certificatePem);
  const imported = info === null ? null : await importVerifyKey(info);
  if (imported === null) throw new Error("the key does not import");
  key = imported;
});

describe("the differential test against xml-crypto 6.3.3", () => {
  it.each([{ seed: 20261014, count: 200 }])(
    "gives the same canonical bytes as xml-crypto on $count generated Responses (seed $seed)",
    ({ seed, count }) => {
      const prefixLists = new Set<string>();
      for (let i = 0; i < count; i++) {
        const { xml, prefixes } = generate(seed + i);
        prefixLists.add(prefixes.join(" "));
        const mine = ours(xml, prefixes);
        const other = theirs(xml, prefixes);
        if (mine !== other) {
          throw new Error(
            `seed ${seed + i} (PrefixList "${prefixes.join(" ")}") differs\n${xml}\nours:   ${mine}\ntheirs: ${other}`,
          );
        }
      }
      // The generator varies the PrefixList: a constant list would test one case 200 times.
      expect(prefixLists.size).toBeGreaterThan(20);
    },
  );

  it("accepts a Response that xml-crypto signed, and xml-crypto accepts one that the test IdP signed", async () => {
    const unsigned = await idp.response(validInput(now, { signAssertion: false }));
    const id = attrId(assertionOf(unsigned));
    const signer = new SignedXml({
      privateKey: idp.privateKeyPem,
      canonicalizationAlgorithm: DSIG_ALGORITHMS.c14n,
      signatureAlgorithm: DSIG_ALGORITHMS.rsaSha256,
    });
    signer.addReference({
      xpath: `//*[@ID='${id}']`,
      transforms: [DSIG_ALGORITHMS.enveloped, DSIG_ALGORITHMS.c14n],
      digestAlgorithm: DSIG_ALGORITHMS.sha256,
    });
    signer.computeSignature(unsigned, {
      location: { reference: `//*[@ID='${id}']/*[local-name(.)='Issuer']`, action: "after" },
    });
    const byXmlCrypto = signer.getSignedXml();
    expect(byXmlCrypto).toContain(`URI="#${id}"`);
    expect(await verifyEnveloped(assertionOf(byXmlCrypto), [key])).toEqual({ ok: true });

    const byIdp = await idp.response(validInput(now));
    expect(xmlCryptoAccepts(byIdp, idp)).toBe(true);
  });

  // Two findings of 2026-10-20 (test/saml/fixtures/real/FINDINGS.md): xml-crypto 6.3.3
  // sorts namespace declarations by `String.prototype.localeCompare` (case-insensitive
  // first), and attributes by the joined text of namespace URI and local name. Canonical XML
  // 1.0 section 2.3 sorts prefixes by code point, and attributes by namespace URI first, then
  // by local name. Ruling 18: these rows pin the W3C form only, because a test must not
  // depend on a supplier defect.
  it.each([
    [
      "a prefix in upper case",
      '<r xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><saml:Assertion ID="_a1" xmlns:Z="urn:z" xmlns:a="urn:a" Z:x="1" a:y="2"/></r>',
      '<saml:Assertion xmlns:Z="urn:z" xmlns:a="urn:a" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" a:y="2" Z:x="1"></saml:Assertion>',
    ],
    [
      "two attribute namespaces where one URI starts the other",
      '<r xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><saml:Assertion ID="_a1" xsi:type="t" xs:foo="f"/></r>',
      '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ID="_a1" xs:foo="f" xsi:type="t"></saml:Assertion>',
    ],
  ])("keeps the W3C sort order where xml-crypto differs: %s", (_name, xml, w3c) => {
    expect(ours(xml, [])).toBe(w3c);
  });

  it("agrees with xml-crypto on each corpus case that changes signed bytes", async () => {
    const valid = await idp.response(validInput(now));
    const audience = "https://sp.example/auth/sso/conn_1/metadata</";
    const at = valid.indexOf(audience);
    expect(at).toBeGreaterThan(0);
    const oneByte = `${valid.slice(0, at)}https://sp.example/auth/sso/conn_1/metadatb</${valid.slice(at + audience.length)}`;
    const cases = [
      ["commentInDigestValue", await commentInDigestValue(valid, idp)],
      ["a one-byte change of a signed text", oneByte],
    ] as const;
    for (const [name, xml] of cases) {
      expect({ name, ours: (await verifyEnveloped(assertionOf(xml), [key])).ok }).toEqual({
        name,
        ours: false,
      });
      expect({ name, theirs: xmlCryptoAccepts(xml, idp) }).toEqual({ name, theirs: false });
    }
    // The control: both accept the valid text, so each refusal above is about the change.
    expect((await verifyEnveloped(assertionOf(valid), [key])).ok).toBe(true);
    expect(xmlCryptoAccepts(valid, idp)).toBe(true);
  });
});

function attrId(el: XmlElement): string {
  const id = el.attrs.find((x) => x.ns === null && x.local === "ID")?.value;
  if (id === undefined) throw new Error("no ID");
  return id;
}
