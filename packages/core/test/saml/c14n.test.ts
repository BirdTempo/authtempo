import { describe, expect, it } from "vitest";
import { excC14n } from "../../src/saml/c14n.js";
import { parseXml, type XmlElement } from "../../src/saml/xml.js";
import { referenceExcC14n } from "./c14n-reference.js";
import c32in from "./fixtures/c14n/c14n-3.2.in.xml?raw";
import c32out from "./fixtures/c14n/c14n-3.2.out.xml?raw";
import c34in from "./fixtures/c14n/c14n-3.4-body.in.xml?raw";
import c34out from "./fixtures/c14n/c14n-3.4-body.out.xml?raw";
import e21ain from "./fixtures/c14n/exc-2.1-alone.in.xml?raw";
import e21aout from "./fixtures/c14n/exc-2.1-alone.out.xml?raw";
import e21ein from "./fixtures/c14n/exc-2.1-enveloped.in.xml?raw";
import e21eout from "./fixtures/c14n/exc-2.1-enveloped.out.xml?raw";
import e22ain from "./fixtures/c14n/exc-2.2-first.in.xml?raw";
import e22aout from "./fixtures/c14n/exc-2.2-first.out.xml?raw";
import e22bin from "./fixtures/c14n/exc-2.2-second.in.xml?raw";
import e22bout from "./fixtures/c14n/exc-2.2-second.out.xml?raw";

function parsed(input: string): XmlElement {
  const answer = parseXml(input);
  if (!answer.ok) throw new Error(`refused: ${answer.refusal} at ${answer.at}`);
  return answer.root;
}

/** The first element in document order with this local name. */
function find(el: XmlElement, local: string): XmlElement {
  const stack: XmlElement[] = [el];
  for (let next = stack.pop(); next; next = stack.pop()) {
    if (next.local === local) return next;
    const kids = next.children.filter((c): c is XmlElement => c.kind === "element");
    stack.push(...kids.reverse());
  }
  throw new Error(`no ${local}`);
}

const SAML =
  '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"' +
  ' xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"' +
  ' xmlns:ds="http://www.w3.org/2000/09/xmldsig#"' +
  ' xmlns:xs="http://www.w3.org/2001/XMLSchema" ID="r1">' +
  '<saml:Assertion ID="a1" Version="2.0">' +
  "<saml:Issuer>idp</saml:Issuer>" +
  '<ds:Signature><ds:SignedInfo><ds:Reference URI="#a1"/></ds:SignedInfo></ds:Signature>' +
  "<saml:Subject><saml:NameID>al<!-- x -->ice</saml:NameID></saml:Subject>" +
  "</saml:Assertion>" +
  "</samlp:Response>";

/** A seeded generator, so each run builds the same documents. */
function seeded(seed: number): (n: number) => number {
  let state = seed;
  return (n) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % n;
  };
}

const PREFIXES = ["", "p", "q", "s"];
const URIS = ["u1", "u2", ""];

/** One random element with random declarations, attributes, text, and children. */
function randomElement(rnd: (n: number) => number, depth: number): string {
  const prefix = PREFIXES[rnd(4)] ?? "";
  const name = prefix === "" ? "e" : `${prefix}:e`;
  const parts = [name];
  for (const p of PREFIXES) {
    if (rnd(3) !== 0) continue;
    const uri = URIS[rnd(3)] ?? "";
    if (p === "") parts.push(`xmlns="${uri}"`);
    else if (uri !== "") parts.push(`xmlns:${p}="${uri}"`);
  }
  if (rnd(3) === 0) parts.push(`${PREFIXES[1 + rnd(3)]}:a="1"`);
  const kids = depth < 4 ? Array.from({ length: rnd(3) }, () => randomElement(rnd, depth + 1)) : [];
  return `<${parts.join(" ")}>${rnd(2) === 0 ? "t" : ""}${kids.join("")}</${name}>`;
}

function elementsOf(el: XmlElement): XmlElement[] {
  const all = [el];
  for (const c of el.children) if (c.kind === "element") all.push(...elementsOf(c));
  return all;
}

describe("excC14n", () => {
  it.each([
    ["Canonical XML 1.0 section 3.2", c32in, c32out, "doc"],
    ["Canonical XML 1.0 section 3.4, the body", c34in, c34out, "doc"],
    ["Exclusive C14N section 2.1, alone", e21ain, e21aout, "elem1"],
    ["Exclusive C14N section 2.1, enveloped", e21ein, e21eout, "elem1"],
    ["Exclusive C14N section 2.2, the first document", e22ain, e22aout, "elem2"],
    ["Exclusive C14N section 2.2, the second document", e22bin, e22bout, "elem2"],
  ])("gives the canonical form of each W3C vector: %s", (_name, input, output, apex) => {
    const el = find(parsed(input), apex);
    expect(excC14n(el, { inclusivePrefixes: [] })).toBe(output);
  });

  it("writes only the visibly used namespaces, plus the PrefixList", () => {
    const root = parsed(
      '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"' +
        ' xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"' +
        ' xmlns:ds="http://www.w3.org/2000/09/xmldsig#"' +
        ' xmlns:xs="http://www.w3.org/2001/XMLSchema">' +
        '<saml:Assertion ID="a1"><saml:AttributeValue>xs:string</saml:AttributeValue>' +
        '<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">i</saml:Issuer>' +
        "</saml:Assertion></samlp:Response>",
    );
    const assertion = find(root, "Assertion");
    expect(excC14n(assertion, { inclusivePrefixes: [] })).toBe(
      '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="a1">' +
        "<saml:AttributeValue>xs:string</saml:AttributeValue>" +
        "<saml:Issuer>i</saml:Issuer></saml:Assertion>",
    );
    expect(excC14n(assertion, { inclusivePrefixes: ["xs"] })).toBe(
      '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"' +
        ' xmlns:xs="http://www.w3.org/2001/XMLSchema" ID="a1">' +
        "<saml:AttributeValue>xs:string</saml:AttributeValue>" +
        "<saml:Issuer>i</saml:Issuer></saml:Assertion>",
    );
    const xml = parsed('<r xmlns:xml="http://www.w3.org/XML/1998/namespace" xml:lang="en"/>');
    expect(excC14n(xml, { inclusivePrefixes: ["xml"] })).toBe('<r xml:lang="en"></r>');
    const plain = parsed('<r xmlns="urn:d"><p:s xmlns:p="urn:p"><t xmlns=""/></p:s></r>');
    expect(excC14n(plain, { inclusivePrefixes: [] })).toBe(
      '<r xmlns="urn:d"><p:s xmlns:p="urn:p"><t xmlns=""></t></p:s></r>',
    );
    expect(excC14n(find(plain, "s"), { inclusivePrefixes: ["#default"] })).toBe(
      '<p:s xmlns="urn:d" xmlns:p="urn:p"><t xmlns=""></t></p:s>',
    );
    expect(excC14n(find(plain, "s"), { inclusivePrefixes: [] })).toBe(
      '<p:s xmlns:p="urn:p"><t></t></p:s>',
    );
  });

  it("drops the omitted subtree and the comments", () => {
    const assertion = find(parsed(SAML), "Assertion");
    const signature = find(assertion, "Signature");
    expect(excC14n(assertion, { inclusivePrefixes: [], omit: signature })).toBe(
      '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="a1" Version="2.0">' +
        "<saml:Issuer>idp</saml:Issuer>" +
        "<saml:Subject><saml:NameID>alice</saml:NameID></saml:Subject>" +
        "</saml:Assertion>",
    );
    expect(excC14n(signature, { inclusivePrefixes: [] })).toBe(
      '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo>' +
        '<ds:Reference URI="#a1"></ds:Reference></ds:SignedInfo></ds:Signature>',
    );
  });

  it("escapes text and attribute values", () => {
    const root = parsed(
      '<r b:a="2" t="&#9;&#10;" xmlns:b="urn:b" a="a&lt;b&amp;c>&quot;d&quot;&#13;">' +
        'a&lt;b&amp;c&gt;"d"&#13;</r>',
    );
    expect(excC14n(root, { inclusivePrefixes: [] })).toBe(
      '<r xmlns:b="urn:b" a="a&lt;b&amp;c>&quot;d&quot;&#xD;" t="&#x9;&#xA;" b:a="2">' +
        'a&lt;b&amp;c&gt;"d"&#xD;</r>',
    );
  });

  it("gives the output of the direct reading of section 3 on seeded documents", () => {
    const rnd = seeded(7);
    const differences: string[] = [];
    let compared = 0;
    for (let k = 0; k < 3000; k++) {
      const doc = `<r xmlns:p="u1" xmlns:q="u2" xmlns:s="u1" xmlns="u2">${randomElement(rnd, 0)}</r>`;
      const all = elementsOf(parsed(doc));
      for (const apex of all) {
        const inclusivePrefixes = PREFIXES.filter(() => rnd(2) === 0).map((p) =>
          p === "" ? "#default" : p,
        );
        const below = elementsOf(apex);
        const omit = rnd(4) === 0 ? (below[rnd(below.length)] ?? null) : null;
        const options = { inclusivePrefixes, omit: omit === apex ? null : omit };
        compared++;
        if (excC14n(apex, options) !== referenceExcC14n(apex, options)) {
          differences.push(`${doc} apex ${all.indexOf(apex)} list ${inclusivePrefixes.join(" ")}`);
        }
      }
    }
    expect(compared).toBe(17_946);
    expect(differences.slice(0, 3)).toEqual([]);
  });

  // Review M1 of Task 6: one document inside every bound of spec 30 item 7, with a PrefixList of
  // 30 000 entries. The form that tested each entry at each element took 21 s (load 2.35)
  // and 22 s (load 8.59). This form takes 4 to 18 ms (load 12.54, 2026-10-20). The bound is 1 s.
  it("keeps a long PrefixList on a deep and wide document inside 1 s", () => {
    const list = Array.from({ length: 30_000 }, (_, k) => `n${k.toString(36)}`).join(" ");
    const chain = Array.from({ length: 60 }, (_, d) => `<a xmlns:d${d}="u">`).join("");
    const body = `${chain}${"<e/>".repeat(4900)}${"</a>".repeat(60)}`;
    const doc = `<r><il PrefixList="${list}"/>${body}</r>`;
    expect(new TextEncoder().encode(doc).length).toBe(169_543);
    const root = parsed(doc);
    const inclusivePrefixes = find(root, "il").attrs[0]?.value.split(" ") ?? [];
    expect(inclusivePrefixes).toHaveLength(30_000);
    const start = performance.now();
    const output = excC14n(find(root, "a"), { inclusivePrefixes });
    const elapsed = performance.now() - start;
    expect(output).toBe(`${"<a>".repeat(60)}${"<e></e>".repeat(4900)}${"</a>".repeat(60)}`);
    expect(elapsed).toBeLessThan(1000);
  }, 120_000);
});
