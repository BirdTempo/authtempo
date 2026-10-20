import { describe, expect, it } from "vitest";
import {
  childElements,
  parseXml,
  textOf,
  type XmlElement,
  type XmlRefusal,
} from "../../src/saml/xml.js";
import w3c31 from "./fixtures/c14n/c14n-3.1.in.xml?raw";
import w3c33 from "./fixtures/c14n/c14n-3.3.in.xml?raw";
import w3c34 from "./fixtures/c14n/c14n-3.4.in.xml?raw";
import w3c35 from "./fixtures/c14n/c14n-3.5.in.xml?raw";
import w3c36 from "./fixtures/c14n/c14n-3.6.in.xml?raw";
import w3c37 from "./fixtures/c14n/c14n-3.7.in.xml?raw";

const nested = (n: number): string => "<a>".repeat(n) + "</a>".repeat(n);
const many = (n: number): string => `<r>${"<a/>".repeat(n - 1)}</r>`;
const attrs = (n: number): string =>
  `<r ${Array.from({ length: n }, (_, i) => `a${i}="v"`).join(" ")}/>`;
// A document of exactly n bytes: `<r>` + text + `</r>` is n bytes.
const sized = (n: number): string => `<r>${"x".repeat(n - 7)}</r>`;

function parsed(input: string | Uint8Array): XmlElement {
  const answer = parseXml(input);
  if (!answer.ok) throw new Error(`refused: ${answer.refusal} at ${answer.at}`);
  return answer.root;
}

describe("parseXml", () => {
  it.each<[string, string | Uint8Array, XmlRefusal]>([
    ["a DOCTYPE with an entity", '<!DOCTYPE r [<!ENTITY e "x">]><r>&e;</r>', "doctype"],
    ["a DOCTYPE after the root", "<r/><!DOCTYPE r>", "doctype"],
    ["a DOCTYPE inside the root", "<r><!DOCTYPE r></r>", "doctype"],
    ["a processing instruction", "<r><?pi x?></r>", "processing_instruction"],
    [
      "a processing instruction before the root",
      '<?xml-stylesheet href="a"?><r/>',
      "processing_instruction",
    ],
    ["a declaration after offset 0", ' <?xml version="1.0"?><r/>', "processing_instruction"],
    ["a CDATA section", "<r><![CDATA[x]]></r>", "cdata"],
    ["a named entity", "<r>&nbsp;</r>", "entity"],
    ["a reference to the character 0", "<r>&#0;</r>", "entity"],
    ["a reference to U+FFFE", "<r>&#xFFFE;</r>", "entity"],
    ["an uppercase X in a reference", "<r>&#X41;</r>", "entity"],
    ["a named entity in a value", '<r a="&e;"/>', "entity"],
    ["a bare ampersand", "<r>a & b</r>", "entity"],
    ["65 nested elements", nested(65), "depth"],
    ["5001 elements", many(5001), "elements"],
    ["65 attributes on one element", attrs(65), "attributes"],
    ["one attribute twice", '<r a="1" a="2"/>', "duplicate_attribute"],
    [
      "one expanded name twice",
      '<r xmlns:p="urn:a" xmlns:q="urn:a" p:x="1" q:x="2"/>',
      "duplicate_attribute",
    ],
    ["one prefix declared twice", '<r xmlns:p="urn:a" xmlns:p="urn:b"/>', "duplicate_attribute"],
    ["an unbound element prefix", "<p:r/>", "namespace"],
    ["an unbound attribute prefix", '<r p:a="1"/>', "namespace"],
    ["xml bound to another URI", '<r xmlns:xml="urn:x"/>', "namespace"],
    ["a declaration of xmlns", '<r xmlns:xmlns="urn:x"/>', "namespace"],
    ["an empty URI for a prefix", '<r xmlns:p=""/>', "namespace"],
    [
      "another prefix bound to the xml URI",
      '<r xmlns:p="http://www.w3.org/XML/1998/namespace"/>',
      "namespace",
    ],
    ["a name with a digit first", "<1r/>", "name"],
    ["a name with two colons", "<a:b:c/>", "name"],
    ["a name with a letter outside ASCII", "<ré/>", "name"],
    ["a < in a value", '<r a="<"/>', "syntax"],
    ["an end tag of another name", "<r></s>", "syntax"],
    ["an element with no end", "<r>", "syntax"],
    ["two roots", "<r/><s/>", "syntax"],
    ["a ]]> in text", "<r>]]></r>", "syntax"],
    ["a -- in a comment", "<r><!-- a -- b --></r>", "syntax"],
    ["a control character", "<r>\u0001</r>", "syntax"],
    ["version 1.1", '<?xml version="1.1"?><r/>', "syntax"],
    ["a 262 145-byte document", sized(262_145), "size"],
    ["a 262 147-byte document of two-byte letters", `<r>${"\u00e9".repeat(131_070)}</r>`, "size"],
    ["262 145 bytes", new Uint8Array(262_145).fill(0x20), "size"],
    [
      "an invalid UTF-8 byte",
      new Uint8Array([0x3c, 0x72, 0x3e, 0xff, 0x3c, 0x2f, 0x72, 0x3e]),
      "encoding",
    ],
    ["a lone surrogate in a string", "<r>\ud800</r>", "encoding"],
    ["an encoding other than UTF-8", '<?xml version="1.0" encoding="ISO-8859-1"?><r/>', "encoding"],
    ["the W3C vector C14N 3.1", w3c31, "processing_instruction"],
    ["the W3C vector C14N 3.3", w3c33, "doctype"],
    ["the W3C vector C14N 3.4", w3c34, "doctype"],
    ["the W3C vector C14N 3.5", w3c35, "doctype"],
    ["the W3C vector C14N 3.6", w3c36, "encoding"],
    ["the W3C vector C14N 3.7", w3c37, "doctype"],
  ])("refuses each construct outside the profile: %s", (_name, input, refusal) => {
    const answer = parseXml(input);
    expect(answer.ok ? "ok" : answer.refusal).toBe(refusal);
  });

  it.each<[string, string | Uint8Array]>([
    ["64 nested elements", nested(64)],
    ["5000 elements", many(5000)],
    ["64 attributes on one element", attrs(64)],
    ["a 262 144-byte document", sized(262_144)],
    ["a declaration with UTF-8", '<?xml version="1.0" encoding="utf-8"?><r/>'],
    ["a declaration with no encoding", "<?xml version='1.0'?>\n<r/>"],
    ["a byte order mark", new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x72, 0x2f, 0x3e])],
    ["a byte order mark in a string", "\ufeff<r/>"],
    ["comments outside the root", "<!-- a --><r/><!-- b -->"],
  ])("accepts each bound at its limit: %s", (_name, input) => {
    const answer = parseXml(input);
    expect(answer.ok ? "ok" : answer.refusal).toBe("ok");
  });

  it("keeps comments as nodes, and textOf refuses a split text", () => {
    const split = parsed("<NameID>a<!---->b</NameID>");
    expect(split.children.map((c) => c.kind)).toEqual(["text", "comment", "text"]);
    expect(textOf(split)).toEqual({ ok: false });
    expect(textOf(parsed("<NameID>ab</NameID>"))).toEqual({ ok: true, value: "ab" });
    expect(textOf(parsed("<NameID>a&amp;b&#x41;</NameID>"))).toEqual({ ok: true, value: "a&bA" });
    expect(textOf(parsed("<NameID/>"))).toEqual({ ok: true, value: "" });
    expect(textOf(parsed("<NameID><!----></NameID>"))).toEqual({ ok: false });
    expect(textOf(parsed("<NameID>a<b/></NameID>"))).toEqual({ ok: false });
  });

  it("normalizes line ends and attribute whitespace", () => {
    const root = parsed('<r a="x\ty" b="1\r\n2" c="&#9;">1\r\n2\r3</r>');
    expect(root.attrs.map((a) => a.value)).toEqual(["x y", "1 2", "\t"]);
    expect(root.children).toEqual([{ kind: "text", value: "1\n2\n3" }]);
    expect(parsed("<r>&#13;</r>").children).toEqual([{ kind: "text", value: "\r" }]);
  });

  it("resolves each namespace in scope", () => {
    const root = parsed(
      [
        '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="r1">',
        '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="a1">',
        '<saml:Subject><NameID xmlns="urn:d" xml:lang="en" saml:x="1">n</NameID></saml:Subject>',
        "<saml:Issuer>i</saml:Issuer>",
        "</saml:Assertion>",
        "</samlp:Response>",
      ].join(""),
    );
    expect([root.prefix, root.local, root.ns]).toEqual([
      "samlp",
      "Response",
      "urn:oasis:names:tc:SAML:2.0:protocol",
    ]);
    expect(root.nsDecls).toEqual([
      { prefix: "samlp", uri: "urn:oasis:names:tc:SAML:2.0:protocol" },
    ]);
    expect(root.attrs).toEqual([{ prefix: null, local: "ID", ns: null, value: "r1" }]);
    const [assertion] = childElements(root, "urn:oasis:names:tc:SAML:2.0:assertion", "Assertion");
    if (!assertion) throw new Error("no Assertion");
    expect(assertion.parent).toBe(root);
    expect(childElements(root, "urn:oasis:names:tc:SAML:2.0:protocol", "Assertion")).toEqual([]);
    const [subject] = childElements(assertion, "urn:oasis:names:tc:SAML:2.0:assertion", "Subject");
    if (!subject) throw new Error("no Subject");
    const [nameId] = childElements(subject, "urn:d", "NameID");
    if (!nameId) throw new Error("no NameID");
    expect([nameId.prefix, nameId.ns]).toEqual([null, "urn:d"]);
    expect(nameId.attrs).toEqual([
      { prefix: "xml", local: "lang", ns: "http://www.w3.org/XML/1998/namespace", value: "en" },
      { prefix: "saml", local: "x", ns: "urn:oasis:names:tc:SAML:2.0:assertion", value: "1" },
    ]);
    expect(
      childElements(assertion, "urn:oasis:names:tc:SAML:2.0:assertion", "Issuer"),
    ).toHaveLength(1);
    const plain = parsed('<r xmlns="urn:d"><s xmlns=""/></r>');
    expect(plain.children[0]).toMatchObject({ kind: "element", local: "s", ns: null });
  });
});
