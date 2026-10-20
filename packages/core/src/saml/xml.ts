/**
 * A parser for one narrow profile of SAML 2.0 (plan 12d). It refuses every construct
 * that the profile does not need. The Workers runtime has no DOMParser.
 *
 * The parser is one forward scan with an index, so its time is linear in the input.
 * No regular expression runs over the whole document. Each refusal returns at once,
 * and no construct is ever skipped. A DOCTYPE, an entity, a processing instruction,
 * and a CDATA section are refusals, so no XXE and no entity expansion can occur.
 */

/** The bounds of one document (spec 30 item 7). */
export const XML_LIMITS = {
  bytes: 262_144,
  depth: 64,
  elements: 5000,
  attributesPerElement: 64,
} as const;

/** A caller may pass a smaller or larger bound for each key of `XML_LIMITS`. */
export type XmlLimits = { readonly [K in keyof typeof XML_LIMITS]: number };

export interface XmlAttr {
  prefix: string | null;
  local: string;
  ns: string | null;
  value: string;
}
export interface XmlElement {
  kind: "element";
  prefix: string | null;
  local: string;
  ns: string | null;
  attrs: XmlAttr[];
  nsDecls: { prefix: string | null; uri: string }[];
  children: XmlNode[];
  parent: XmlElement | null;
}
export interface XmlText {
  kind: "text";
  value: string;
}
export interface XmlComment {
  kind: "comment";
  value: string;
}
export type XmlNode = XmlElement | XmlText | XmlComment;
export type XmlRefusal =
  | "size"
  | "encoding"
  | "doctype"
  | "processing_instruction"
  | "cdata"
  | "entity"
  | "depth"
  | "elements"
  | "attributes"
  | "duplicate_attribute"
  | "namespace"
  | "name"
  | "syntax";

const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

/** A refusal in flight. Only `parseXml` catches it. */
class Refused {
  readonly refusal: XmlRefusal;
  readonly index: number;
  constructor(refusal: XmlRefusal, index: number) {
    this.refusal = refusal;
    this.index = index;
  }
}

const LT = 0x3c;
const GT = 0x3e;
const AMP = 0x26;
const QUOT = 0x22;
const APOS = 0x27;
const SLASH = 0x2f;
const EQ = 0x3d;

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/** A UTF-16 code unit that may stand in XML 1.0 text (section 2.2). A surrogate pair passes as two units. */
function isCharUnit(c: number): boolean {
  if (c < 0x20) return c === 0x09 || c === 0x0a || c === 0x0d;
  return c !== 0xfffe && c !== 0xffff;
}

/** A code point of the XML 1.0 production Char (section 2.2). */
function isCharPoint(cp: number): boolean {
  return (
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/** An NCName of the profile: ASCII letters, digits, `.`, `-`, and `_`, with a letter or `_` first. */
function isNcName(s: string): boolean {
  if (s.length === 0) return false;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    const letter = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
    if (letter) continue;
    if (k > 0 && ((c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x2d)) continue;
    return false;
  }
  return true;
}

/**
 * The UTF-8 length of `s` up to `end`, or -1 when it holds a lone surrogate.
 * The count stops once it passes `cap`, so a huge string costs no more than the bound.
 */
function utf8Length(s: string, end: number, cap: number): number {
  let bytes = 0;
  for (let k = 0; k < end && bytes <= cap; k++) {
    const c = s.charCodeAt(k);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(k + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return -1;
      bytes += 4;
      k++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return -1;
    else bytes += 3;
  }
  return bytes;
}

/** XML 1.0 section 2.11: each `\r\n` and each lone `\r` becomes `\n`. */
function normalizeLineEnds(s: string): string {
  if (s.indexOf("\r") < 0) return s;
  const parts: string[] = [];
  let from = 0;
  for (let k = 0; k < s.length; k++) {
    if (s.charCodeAt(k) !== 0x0d) continue;
    parts.push(s.slice(from, k), "\n");
    from = s.charCodeAt(k + 1) === 0x0a ? k + 2 : k + 1;
  }
  parts.push(s.slice(from));
  return parts.join("");
}

/** Behavior 1: the bound, the strict UTF-8 decode, and the line-end rule. */
function decode(input: Uint8Array | string, maxBytes: number): string {
  let text: string;
  if (typeof input === "string") {
    const bytes = utf8Length(input, input.length, maxBytes);
    if (bytes < 0) throw new Refused("encoding", 0);
    if (bytes > maxBytes) throw new Refused("size", 0);
    text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  } else {
    if (input.byteLength > maxBytes) throw new Refused("size", 0);
    try {
      // The decoder drops a byte order mark by default (ignoreBOM is false).
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      throw new Refused("encoding", 0);
    }
  }
  return normalizeLineEnds(text);
}

/**
 * The declarations of one element, linked to the frame of its parent. A lookup walks at
 * most `depth` frames, so no element copies the scope of its parent.
 */
interface Frame {
  readonly decls: ReadonlyMap<string, string>;
  readonly up: Frame | null;
}

/** The URI bound to `prefix` in scope (`""` names the default namespace), or undefined. */
function lookup(frame: Frame | null, prefix: string): string | undefined {
  for (let f = frame; f !== null; f = f.up) {
    const uri = f.decls.get(prefix);
    if (uri !== undefined) return uri;
  }
  return undefined;
}

interface RawAttr {
  prefix: string | null;
  local: string;
  value: string;
  at: number;
}

function parseDocument(s: string, limits: XmlLimits): XmlElement {
  const n = s.length;
  let i = 0;
  let elements = 0;

  const startsWith = (lit: string): boolean => s.startsWith(lit, i);

  const skipSpace = (): boolean => {
    const from = i;
    while (i < n && isSpace(s.charCodeAt(i))) i++;
    return i > from;
  };

  /** A name token ends at a space, `/`, `>`, `=`, `<`, a quote, `&`, or the end. */
  const readToken = (): string => {
    const from = i;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (isSpace(c) || c === SLASH || c === GT || c === EQ || c === LT || c === QUOT || c === APOS)
        break;
      if (c === AMP) break;
      i++;
    }
    return s.slice(from, i);
  };

  const qname = (token: string, at: number): { prefix: string | null; local: string } => {
    if (token.length === 0) throw new Refused("syntax", at);
    const colon = token.indexOf(":");
    if (colon < 0) {
      if (!isNcName(token)) throw new Refused("name", at);
      return { prefix: null, local: token };
    }
    const prefix = token.slice(0, colon);
    const local = token.slice(colon + 1);
    if (!isNcName(prefix) || !isNcName(local)) throw new Refused("name", at);
    return { prefix, local };
  };

  /** A reference at `i` (`&`): one of the five predefined entities or a character reference. */
  const reference = (): string => {
    const at = i;
    // The longest legal reference is `&#x10FFFF;` or `&#1114111;` (10 code units).
    // A longer body fails the checks below too; this bound only keeps the slice short.
    const semi = s.indexOf(";", i + 1);
    if (semi < 0 || semi - at > 10) throw new Refused("entity", at);
    const body = s.slice(at + 1, semi);
    i = semi + 1;
    switch (body) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "apos":
        return "'";
      case "quot":
        return '"';
    }
    let cp = -1;
    if (body.startsWith("#x")) {
      const hex = body.slice(2);
      if (
        hex.length > 0 &&
        hex.length <= 6 &&
        [...hex].every((h) => "0123456789abcdefABCDEF".includes(h))
      )
        cp = Number.parseInt(hex, 16);
    } else if (body.startsWith("#")) {
      const dec = body.slice(1);
      if (dec.length > 0 && dec.length <= 7 && [...dec].every((d) => d >= "0" && d <= "9"))
        cp = Number.parseInt(dec, 10);
    }
    if (!isCharPoint(cp)) throw new Refused("entity", at);
    return String.fromCodePoint(cp);
  };

  /** A comment at `i` (`<!--`). XML 1.0 section 2.5: no `--` inside, and no `-` before the end. */
  const comment = (): string => {
    const at = i;
    const close = s.indexOf("--", i + 4);
    if (close < 0 || s.charCodeAt(close + 2) !== GT) throw new Refused("syntax", at);
    const value = s.slice(i + 4, close);
    for (let k = 0; k < value.length; k++) {
      if (!isCharUnit(value.charCodeAt(k))) throw new Refused("syntax", i + 4 + k);
    }
    i = close + 3;
    return value;
  };

  /** Each markup that opens with `<!` or `<?` and that the profile refuses. */
  const refuseMarkup = (): never => {
    if (startsWith("<![CDATA[")) throw new Refused("cdata", i);
    if (s.slice(i + 2, i + 9).toUpperCase() === "DOCTYPE" && startsWith("<!"))
      throw new Refused("doctype", i);
    if (startsWith("<?")) throw new Refused("processing_instruction", i);
    throw new Refused("syntax", i);
  };

  /** An attribute value at `i` (the quote). XML 1.0 section 3.3.3 for CDATA attributes. */
  const attrValue = (): string => {
    const quote = s.charCodeAt(i);
    i++;
    const parts: string[] = [];
    let from = i;
    for (;;) {
      if (i >= n) throw new Refused("syntax", i);
      const c = s.charCodeAt(i);
      if (c === quote) {
        parts.push(s.slice(from, i));
        i++;
        return parts.join("");
      }
      if (c === LT) throw new Refused("syntax", i);
      if (c === AMP) {
        parts.push(s.slice(from, i));
        parts.push(reference());
        from = i;
        continue;
      }
      if (c === 0x09 || c === 0x0a || c === 0x0d) {
        parts.push(s.slice(from, i), " ");
        i++;
        from = i;
        continue;
      }
      if (!isCharUnit(c)) throw new Refused("syntax", i);
      i++;
    }
  };

  /** Character data at `i` up to the next `<`, with each reference replaced. */
  const text = (): string => {
    const parts: string[] = [];
    let from = i;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === LT) break;
      if (c === AMP) {
        parts.push(s.slice(from, i));
        parts.push(reference());
        from = i;
        continue;
      }
      if (c === 0x5d && startsWith("]]>")) throw new Refused("syntax", i);
      if (!isCharUnit(c)) throw new Refused("syntax", i);
      i++;
    }
    parts.push(s.slice(from, i));
    return parts.join("");
  };

  const frames: (Frame | null)[] = [];

  /** A start tag at `i` (`<`). The answer says whether the tag was empty (`/>`). */
  const startTag = (
    parent: XmlElement | null,
    depth: number,
  ): { el: XmlElement; empty: boolean } => {
    const at = i;
    i++;
    const name = qname(readToken(), at);
    if (depth > limits.depth) throw new Refused("depth", at);
    elements++;
    if (elements > limits.elements) throw new Refused("elements", at);
    const raw: RawAttr[] = [];
    const seen = new Set<string>();
    let empty = false;
    for (;;) {
      const spaced = skipSpace();
      if (i >= n) throw new Refused("syntax", i);
      if (s.charCodeAt(i) === GT) {
        i++;
        break;
      }
      if (startsWith("/>")) {
        i += 2;
        empty = true;
        break;
      }
      if (!spaced) throw new Refused("syntax", i);
      const attrAt = i;
      const token = readToken();
      const attrName = qname(token, attrAt);
      skipSpace();
      if (s.charCodeAt(i) !== EQ) throw new Refused("syntax", i);
      i++;
      skipSpace();
      const q = s.charCodeAt(i);
      if (q !== QUOT && q !== APOS) throw new Refused("syntax", i);
      const value = attrValue();
      if (raw.length + 1 > limits.attributesPerElement) throw new Refused("attributes", attrAt);
      if (seen.has(token)) throw new Refused("duplicate_attribute", attrAt);
      seen.add(token);
      raw.push({ ...attrName, value, at: attrAt });
    }

    // Namespaces in XML 1.0 section 3: the declarations of this element.
    const nsDecls: { prefix: string | null; uri: string }[] = [];
    const own = new Map<string, string>();
    for (const a of raw) {
      const isDefault = a.prefix === null && a.local === "xmlns";
      if (!isDefault && a.prefix !== "xmlns") continue;
      const prefix = isDefault ? null : a.local;
      if (prefix === "xmlns") throw new Refused("namespace", a.at);
      if (prefix === "xml") {
        if (a.value !== XML_NS) throw new Refused("namespace", a.at);
      } else {
        if (a.value === XML_NS || a.value === XMLNS_NS) throw new Refused("namespace", a.at);
        if (prefix !== null && a.value === "") throw new Refused("namespace", a.at);
      }
      own.set(prefix ?? "", a.value);
      nsDecls.push({ prefix, uri: a.value });
    }

    const parentFrame = frames[frames.length - 1] ?? null;
    const frame = own.size > 0 ? { decls: own, up: parentFrame } : parentFrame;

    const resolve = (prefix: string, at: number): string => {
      if (prefix === "xml") return XML_NS;
      const uri = prefix === "xmlns" ? undefined : lookup(frame, prefix);
      if (uri === undefined) throw new Refused("namespace", at);
      return uri;
    };

    const attrs: XmlAttr[] = [];
    const expanded = new Set<string>();
    for (const a of raw) {
      if ((a.prefix === null && a.local === "xmlns") || a.prefix === "xmlns") continue;
      const ns = a.prefix === null ? null : resolve(a.prefix, a.at);
      const key = `${ns ?? ""} ${a.local}`;
      if (expanded.has(key)) throw new Refused("duplicate_attribute", a.at);
      expanded.add(key);
      attrs.push({ prefix: a.prefix, local: a.local, ns, value: a.value });
    }

    const defaultNs = lookup(frame, "") ?? "";
    const ns =
      name.prefix === null ? (defaultNs === "" ? null : defaultNs) : resolve(name.prefix, at);
    const el: XmlElement = {
      kind: "element",
      prefix: name.prefix,
      local: name.local,
      ns,
      attrs,
      nsDecls,
      children: [],
      parent,
    };
    if (!empty) frames.push(frame);
    return { el, empty };
  };

  /** An end tag at `i` (`</`): the name must be the name of the open element. */
  const endTag = (open: XmlElement): void => {
    const at = i;
    i += 2;
    const token = readToken();
    const expected = open.prefix === null ? open.local : `${open.prefix}:${open.local}`;
    if (token !== expected) throw new Refused("syntax", at);
    skipSpace();
    if (s.charCodeAt(i) !== GT) throw new Refused("syntax", i);
    i++;
    frames.pop();
  };

  /** The prolog or the epilog: spaces and comments only. */
  const misc = (): void => {
    for (;;) {
      skipSpace();
      if (i >= n || s.charCodeAt(i) !== LT) return;
      if (startsWith("<!--")) {
        comment();
        continue;
      }
      if (startsWith("<!") || startsWith("<?")) refuseMarkup();
      return;
    }
  };

  /** The XML declaration (XML 1.0 section 2.8): version 1.0, then UTF-8 or no encoding. */
  const declaration = (): void => {
    const at = i;
    i += 5;
    const seen: string[] = [];
    for (;;) {
      const spaced = skipSpace();
      if (startsWith("?>")) {
        i += 2;
        break;
      }
      if (!spaced || i >= n) throw new Refused("syntax", i);
      const key = readToken();
      skipSpace();
      if (s.charCodeAt(i) !== EQ) throw new Refused("syntax", i);
      i++;
      skipSpace();
      const q = s.charCodeAt(i);
      if (q !== QUOT && q !== APOS) throw new Refused("syntax", i);
      const close = s.indexOf(String.fromCharCode(q), i + 1);
      if (close < 0 || close - i > 41) throw new Refused("syntax", i);
      const value = s.slice(i + 1, close);
      i = close + 1;
      if (key === "version" && seen.length === 0) {
        if (value !== "1.0") throw new Refused("syntax", at);
      } else if (key === "encoding" && seen.length === 1 && seen[0] === "version") {
        if (value.toLowerCase() !== "utf-8") throw new Refused("encoding", at);
      } else if (key === "standalone" && seen.length >= 1 && !seen.includes("standalone")) {
        if (value !== "yes" && value !== "no") throw new Refused("syntax", at);
      } else {
        throw new Refused("syntax", at);
      }
      seen.push(key);
    }
    if (seen.length === 0) throw new Refused("syntax", at);
  };

  // The XML declaration, at offset 0 only (XML 1.0 section 2.8).
  if (startsWith("<?xml") && isSpace(s.charCodeAt(5))) declaration();

  misc();
  if (i >= n || s.charCodeAt(i) !== LT) throw new Refused("syntax", i);
  const first = startTag(null, 1);
  const root = first.el;
  const stack: XmlElement[] = first.empty ? [] : [root];
  while (stack.length > 0) {
    const open = stack[stack.length - 1];
    if (open === undefined) break;
    if (i >= n) throw new Refused("syntax", i);
    if (s.charCodeAt(i) !== LT) {
      open.children.push({ kind: "text", value: text() });
      continue;
    }
    if (startsWith("</")) {
      endTag(open);
      stack.pop();
      continue;
    }
    if (startsWith("<!--")) {
      open.children.push({ kind: "comment", value: comment() });
      continue;
    }
    if (startsWith("<!") || startsWith("<?")) refuseMarkup();
    const child = startTag(open, stack.length + 1);
    open.children.push(child.el);
    if (!child.empty) stack.push(child.el);
  }
  misc();
  if (i < n) throw new Refused("syntax", i);
  return root;
}

/**
 * Parses one document of the profile. A refusal names its kind and the byte offset of
 * the construct in the text after the line-end rule. The offset is for the log line only.
 */
export function parseXml(
  input: Uint8Array | string,
  limits?: Partial<XmlLimits>,
): { ok: true; root: XmlElement } | { ok: false; refusal: XmlRefusal; at: number } {
  const bounds: XmlLimits = { ...XML_LIMITS, ...limits };
  let text = "";
  try {
    text = decode(input, bounds.bytes);
    return { ok: true, root: parseDocument(text, bounds) };
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    const at = Math.max(
      0,
      utf8Length(text, Math.min(err.index, text.length), Number.POSITIVE_INFINITY),
    );
    return { ok: false, refusal: err.refusal, at };
  }
}

/** The child elements of `el` with this namespace and local name, in document order. */
export function childElements(el: XmlElement, ns: string, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of el.children) {
    if (child.kind === "element" && child.ns === ns && child.local === local) out.push(child);
  }
  return out;
}

/**
 * The text of an element with no child element, no comment, and at most one text node.
 * A comment that splits a value (the class of CVE-2017-11427) makes the answer not ok.
 */
export function textOf(el: XmlElement): { ok: true; value: string } | { ok: false } {
  let value = "";
  let texts = 0;
  for (const child of el.children) {
    if (child.kind === "element") return { ok: false };
    if (child.kind === "comment") return { ok: false };
    texts++;
    value = child.value;
  }
  // The parser joins adjacent text, so only a comment splits a value. This count is a second guard.
  if (texts > 1) return { ok: false };
  return { ok: true, value };
}
