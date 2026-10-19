/**
 * A small XML reader of our own for check-feed (plan 11b Task 7). It reads
 * elements, attributes, text, the five named entities, character references,
 * comments, and one XML declaration. It throws on each other construct and on
 * each fault of form, so a feed that it cannot read fails the check.
 */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** The text directly in the element, with the entities decoded. */
  text: string;
}

const NAME = /[A-Za-z_][\w.:-]*/y;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** True for a code point of the Char production of XML 1.0. */
export function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/** The text with each entity and character reference decoded. It throws on a bare `&`. */
function decode(raw: string, at: number): string {
  return raw.replace(/&([^;&\s]*);?/g, (whole, ref: string, off: number) => {
    if (!whole.endsWith(";")) throw new Error(`a bare & at offset ${at + off}`);
    const named = ENTITIES[ref];
    if (named !== undefined) return named;
    const num = /^#(?:x([0-9A-Fa-f]+)|([0-9]+))$/.exec(ref);
    const cp =
      num === null ? Number.NaN : Number.parseInt(num[1] ?? num[2] ?? "", num[1] ? 16 : 10);
    if (!isXmlChar(cp)) throw new Error(`the reference &${ref}; at offset ${at + off}`);
    return String.fromCodePoint(cp);
  });
}

/** The root element of an XML text. It throws with the fault and its offset. */
export function parseXml(text: string): XmlElement {
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i) ?? 0;
    if (!isXmlChar(cp))
      throw new Error(`U+${cp.toString(16).toUpperCase().padStart(4, "0")} at offset ${i}`);
    if (cp > 0xffff) i++;
  }
  let pos = 0;
  const skipSpace = () => {
    while (pos < text.length && /\s/.test(text[pos] ?? "")) pos++;
  };
  const skipComments = () => {
    for (;;) {
      skipSpace();
      if (!text.startsWith("<!--", pos)) return;
      const end = text.indexOf("-->", pos + 4);
      if (end < 0) throw new Error(`a comment does not close at offset ${pos}`);
      pos = end + 3;
    }
  };
  const name = (): string => {
    NAME.lastIndex = pos;
    const m = NAME.exec(text);
    if (m === null) throw new Error(`no name at offset ${pos}`);
    pos += m[0].length;
    return m[0];
  };

  const element = (): XmlElement => {
    const start = pos;
    pos++; // <
    const el: XmlElement = { name: name(), attrs: {}, children: [], text: "" };
    for (;;) {
      skipSpace();
      if (text.startsWith("/>", pos)) {
        pos += 2;
        return el;
      }
      if (text[pos] === ">") {
        pos++;
        break;
      }
      const attr = name();
      skipSpace();
      if (text[pos] !== "=") throw new Error(`the attribute ${attr} has no value at offset ${pos}`);
      pos++;
      skipSpace();
      const quote = text[pos];
      if (quote !== '"' && quote !== "'")
        throw new Error(`the attribute ${attr} has no quote at offset ${pos}`);
      const end = text.indexOf(quote, pos + 1);
      if (end < 0) throw new Error(`the attribute ${attr} does not close at offset ${pos}`);
      const raw = text.slice(pos + 1, end);
      if (raw.includes("<")) throw new Error(`a < in the attribute ${attr} at offset ${pos}`);
      if (attr in el.attrs) throw new Error(`the attribute ${attr} twice at offset ${pos}`);
      el.attrs[attr] = decode(raw, pos + 1);
      pos = end + 1;
    }
    for (;;) {
      const lt = text.indexOf("<", pos);
      if (lt < 0) throw new Error(`<${el.name}> at offset ${start} does not close`);
      const raw = text.slice(pos, lt);
      if (raw.includes("]]>")) throw new Error(`]]> in text at offset ${pos}`);
      el.text += decode(raw, pos);
      pos = lt;
      if (text.startsWith("<!--", pos)) {
        skipComments();
        continue;
      }
      if (text.startsWith("</", pos)) {
        const at = pos;
        pos += 2;
        const close = name();
        skipSpace();
        if (close !== el.name || text[pos] !== ">")
          throw new Error(`<${el.name}> closes with </${close}> at offset ${at}`);
        pos++;
        return el;
      }
      if (text.startsWith("<!", pos) || text.startsWith("<?", pos))
        throw new Error(`an unsupported construct at offset ${pos}`);
      el.children.push(element());
    }
  };

  if (text.startsWith("<?xml")) {
    const end = text.indexOf("?>");
    if (end < 0) throw new Error("the XML declaration does not close");
    pos = end + 2;
  }
  skipComments();
  if (text[pos] !== "<" || text.startsWith("<!", pos) || text.startsWith("<?", pos))
    throw new Error(`no root element at offset ${pos}`);
  const root = element();
  skipComments();
  if (pos !== text.length) throw new Error(`text after the root element at offset ${pos}`);
  return root;
}
