/**
 * A slow, direct reading of Exclusive XML Canonicalization 1.0 section 3 (plan 12d, ruling 16).
 * It copies the namespace scope at each element and tests each PrefixList entry at each element.
 * `c14n.test.ts` compares `excC14n` with it over seeded documents. Its cost is
 * elements x entries, so only small documents may use it.
 */
import type { XmlElement } from "../../src/saml/xml.js";

function compareCodePoints(a: string, b: string): number {
  const x = [...a].map((c) => c.codePointAt(0) ?? 0);
  const y = [...b].map((c) => c.codePointAt(0) ?? 0);
  for (let k = 0; k < Math.min(x.length, y.length); k++) {
    const d = (x[k] ?? 0) - (y[k] ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

const escapeText = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#xD;");

const escapeAttr = (v: string): string =>
  v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;")
    .replace(/\r/g, "&#xD;");

/** The namespaces in scope at `el` (`""` is the default namespace), as one new map. */
function scopeOf(el: XmlElement | null): Map<string, string> {
  const chain: XmlElement[] = [];
  for (let e = el; e !== null; e = e.parent) chain.unshift(e);
  const scope = new Map<string, string>();
  for (const e of chain) for (const d of e.nsDecls) scope.set(d.prefix ?? "", d.uri);
  return scope;
}

export function referenceExcC14n(
  el: XmlElement,
  options: { inclusivePrefixes: readonly string[]; omit?: XmlElement | null },
): string {
  const inclusive = options.inclusivePrefixes.map((p) => (p === "#default" ? "" : p));
  const omit = options.omit ?? null;
  const out: string[] = [];

  // `rendered` maps each prefix to the URI in effect from the output ancestors.
  const walk = (e: XmlElement, rendered: Map<string, string>) => {
    if (e === omit) return;
    const scope = scopeOf(e);
    const used = new Set<string>([e.prefix ?? ""]);
    for (const a of e.attrs) if (a.prefix !== null) used.add(a.prefix);
    // Canonical XML renders each namespace node of the PrefixList that the output parent does not.
    for (const p of inclusive) if (p === "" || scope.has(p)) used.add(p);
    used.delete("xml");

    const next = new Map(rendered);
    const decls: [string, string][] = [];
    for (const p of used) {
      const uri = scope.get(p) ?? "";
      if (uri === (rendered.get(p) ?? "")) continue;
      decls.push([p, uri]);
      next.set(p, uri);
    }
    decls.sort((x, y) => compareCodePoints(x[0], y[0]));
    const attrs = [...e.attrs].sort(
      (x, y) => compareCodePoints(x.ns ?? "", y.ns ?? "") || compareCodePoints(x.local, y.local),
    );

    const name = e.prefix === null ? e.local : `${e.prefix}:${e.local}`;
    out.push(`<${name}`);
    for (const [p, uri] of decls)
      out.push(`${p === "" ? " xmlns" : ` xmlns:${p}`}="${escapeAttr(uri)}"`);
    for (const a of attrs) {
      out.push(
        ` ${a.prefix === null ? a.local : `${a.prefix}:${a.local}`}="${escapeAttr(a.value)}"`,
      );
    }
    out.push(">");
    for (const c of e.children) {
      if (c.kind === "text") out.push(escapeText(c.value));
      else if (c.kind === "element") walk(c, next);
    }
    out.push(`</${name}>`);
  };

  walk(el, new Map());
  return out.join("");
}
