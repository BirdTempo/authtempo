/** The reserved names of RFC 2606 and RFC 6761. No party serves them. */
const RESERVED = /(^|\.)example\.(com|net|org)$|\.(example|invalid|localhost|test)$|^localhost$/;

/**
 * A string literal, which the scan keeps, or a comment, which it drops. A regex
 * literal that holds a quote or two slashes can hide the rest of its line.
 */
const TOKEN =
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/** The scheme of a URL that names a host: http, https, ws, or wss. */
const SCHEME = /\b(?:https?|wss?):\/\//gi;

/** The authority of a URL: everything up to the path, the query, or the end of the literal. */
const AUTHORITY = /^[^\s/"'`?#<>()\\,;]*/;

/** A host name: labels of letters, digits, hyphens, and underscores, with an optional root dot. */
const HOST = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?$/;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Removes the comments of a TypeScript source and keeps its string literals. */
export function stripComments(text: string): string {
  return text.replace(
    TOKEN,
    (all, literal: string | undefined) => literal ?? (all.startsWith("/*") ? " " : ""),
  );
}

/**
 * The host of one URL authority, or null when it names no vendor: an empty
 * authority, an IP literal, or a text that is not a host name. A userinfo part
 * goes away, and so do a port and a root dot. A template host keeps its literal
 * domain after the last `${…}`; a template host with no literal domain throws.
 */
export function urlHost(authority: string, path: string): string | null {
  let host = authority.slice(authority.lastIndexOf("@") + 1);
  if (host.startsWith("[")) return null;
  host = host.replace(/:(?:\d*|\$\{[^}]*\})$/, "");
  if (host.includes("${")) {
    const literal = host.slice(host.lastIndexOf("}") + 1).replace(/^\./, "");
    if (!/^[a-z0-9_-]+\.[a-z0-9_-]/i.test(literal))
      throw new Error(`${path}: the template URL host "${authority}" names no literal domain`);
    host = literal;
  }
  host = host.toLowerCase();
  if (!HOST.test(host)) return null;
  host = host.replace(/\.$/, "");
  return IPV4.test(host) ? null : host;
}

/**
 * The hosts of other parties that core's own code names: the "vendors in the
 * path" of brand spec 9 (decision 2 of 2026-10-15). A host counts when an
 * http, https, ws, or wss URL in the code of a .ts file under packages/core/src/
 * names it. A URL in a comment does not count. These do not count either:
 * - src/social/: the provider presets. An app turns each one on in its own
 *   config, and the sign-in goes to the provider that the app chose.
 * - src/testing/, src/storage/conformance.ts, and .test.ts files: test
 *   helpers that no deployment runs.
 * - the reserved names of RESERVED, and an IP literal.
 */
export function vendorHosts(files: ReadonlyMap<string, string>): string[] {
  const hosts = new Set<string>();
  for (const [path, text] of files) {
    if (!path.includes("packages/core/src/") || !path.endsWith(".ts")) continue;
    if (
      path.includes("/src/social/") ||
      path.includes("/src/testing/") ||
      path.endsWith("/src/storage/conformance.ts") ||
      path.endsWith(".test.ts")
    )
      continue;
    const code = stripComments(text);
    for (const m of code.matchAll(SCHEME)) {
      const rest = code.slice((m.index ?? 0) + m[0].length);
      const host = urlHost(AUTHORITY.exec(rest)?.[0] ?? "", path);
      if (host && !RESERVED.test(host)) hosts.add(host);
    }
  }
  return [...hosts].sort();
}
