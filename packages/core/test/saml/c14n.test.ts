import { describe, expect, it } from "vitest";
import { excC14n } from "../../src/saml/c14n.js";
import { parseXml, type XmlElement } from "../../src/saml/xml.js";
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
});
