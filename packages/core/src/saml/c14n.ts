/**
 * Exclusive XML Canonicalization 1.0 (https://www.w3.org/TR/xml-exc-c14n/), plan 12d.
 * It writes the subtree of one element of the strict parser of `xml.ts`, with no comments.
 * The serialization rules (escapes, sort orders, start and end tags) are those of
 * Canonical XML 1.0 (https://www.w3.org/TR/2001/REC-xml-c14n-20010315), section 2.3.
 */
import type { XmlElement } from "./xml.js";

/** Compares two strings by Unicode code point, as Canonical XML 1.0 sorts names and URIs. */
function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) ?? 0;
    const y = b.codePointAt(j) ?? 0;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}

/** Text nodes escape `&`, `<`, `>`, and carriage return. */
function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#xD;");
}

/** Attribute and namespace values escape `&`, `<`, `"`, tab, line feed, and carriage return. */
function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\t", "&#x9;")
    .replaceAll("\n", "&#xA;")
    .replaceAll("\r", "&#xD;");
}

/**
 * One element's own bindings, linked to the frame above it. A lookup walks at most the
 * depth of the tree, so no element copies the map of its parent.
 */
interface Frame {
  readonly map: ReadonlyMap<string, string>;
  readonly up: Frame | null;
}

/** The URI that the nearest frame binds to `prefix` (`""` is the default namespace). */
function lookup(frame: Frame | null, prefix: string): string | undefined {
  for (let f = frame; f !== null; f = f.up) {
    const uri = f.map.get(prefix);
    if (uri !== undefined) return uri;
  }
  return undefined;
}

/** The frame of the declarations of `el` (with `nsDecls`), above the frame of its parent. */
function declare(el: XmlElement, up: Frame | null): Frame | null {
  if (el.nsDecls.length === 0) return up;
  return { map: new Map(el.nsDecls.map((d) => [d.prefix ?? "", d.uri])), up };
}

/** The namespaces in scope at `el`, as a chain of frames from the root. */
function scopeAt(el: XmlElement | null): Frame | null {
  const chain: XmlElement[] = [];
  for (let e = el; e !== null; e = e.parent) chain.push(e);
  let frame: Frame | null = null;
  for (const e of chain.reverse()) frame = declare(e, frame);
  return frame;
}

/** Exclusive XML Canonicalization 1.0 without comments of the subtree at `el`, with `omit` removed (the enveloped transform). */
export function excC14n(
  el: XmlElement,
  options: { inclusivePrefixes: readonly string[]; omit?: XmlElement | null },
): string {
  // The InclusiveNamespaces PrefixList: `#default` names the default namespace.
  const inclusive = options.inclusivePrefixes.map((p) => (p === "#default" ? "" : p));
  const inclusiveSet = new Set(inclusive);
  const omit = options.omit ?? null;
  const out: string[] = [];

  // `rendered` gives, for each prefix, the URI that the nearest output ancestor wrote.
  const walk = (e: XmlElement, parentScope: Frame | null, rendered: Frame | null) => {
    if (e === omit) return;
    const scope = declare(e, parentScope);

    // Exclusive C14N section 3: a prefix is visibly used by the element name or an attribute name.
    // Each prefix of the PrefixList follows Canonical XML: the apex writes each one in scope.
    // Below the apex, a list prefix that the element does not declare keeps the URI in effect
    // from its output parent, so only the element's own declarations need the test (review M1).
    // This keeps the cost at one pass of the list, not elements x entries x frames.
    const used = new Set<string>([e.prefix ?? ""]);
    for (const a of e.attrs) if (a.prefix !== null) used.add(a.prefix);
    if (e === el) {
      for (const p of inclusive) if (p === "" || lookup(scope, p) !== undefined) used.add(p);
    } else {
      for (const d of e.nsDecls) if (inclusiveSet.has(d.prefix ?? "")) used.add(d.prefix ?? "");
    }
    used.delete("xml");

    const decls: [string, string][] = [];
    const wrote = new Map<string, string>();
    for (const prefix of used) {
      const uri = lookup(scope, prefix) ?? "";
      // An empty default is written only when an output ancestor wrote a non-empty one.
      if (uri === (lookup(rendered, prefix) ?? "")) continue;
      decls.push([prefix, uri]);
      wrote.set(prefix, uri);
    }
    const next = wrote.size > 0 ? { map: wrote, up: rendered } : rendered;
    decls.sort((x, y) => compareCodePoints(x[0], y[0]));

    const attrs = [...e.attrs].sort(
      (x, y) => compareCodePoints(x.ns ?? "", y.ns ?? "") || compareCodePoints(x.local, y.local),
    );

    const name = e.prefix === null ? e.local : `${e.prefix}:${e.local}`;
    out.push("<", name);
    for (const [prefix, uri] of decls) {
      out.push(prefix === "" ? " xmlns" : ` xmlns:${prefix}`, '="', escapeAttr(uri), '"');
    }
    for (const a of attrs) {
      const attrName = a.prefix === null ? a.local : `${a.prefix}:${a.local}`;
      out.push(" ", attrName, '="', escapeAttr(a.value), '"');
    }
    out.push(">");
    for (const child of e.children) {
      if (child.kind === "text") out.push(escapeText(child.value));
      else if (child.kind === "element") walk(child, scope, next);
    }
    out.push("</", name, ">");
  };

  walk(el, scopeAt(el.parent), null);
  return out.join("");
}
