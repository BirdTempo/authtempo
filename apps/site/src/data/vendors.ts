import { SITE } from "./site.ts";

/** The reserved names of RFC 2606 and RFC 6761. No party serves them. */
const RESERVED = /(^|\.)example\.(com|net|org)$|\.(example|invalid|localhost|test)$|^localhost$/;

/**
 * A string literal, a template literal, or a regex literal, which the scan
 * keeps, or a comment, which it drops. A slash opens a regex literal only after
 * an operator, an open bracket, a comma, or a keyword. The keywords are return,
 * typeof, case, in, of, throw, yield, await, and void. Two limits remain. A regex literal
 * after a close bracket reads as a division. A backtick inside a placeholder of
 * a template literal ends the literal early. Either one can make a URL look like
 * a comment, so stripComments throws on a comment that starts right after a scheme.
 */
const TOKEN =
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`|(?<=(?:^|[=([,:;!&|?{}+\-*%<>~^]|\b(?:return|typeof|case|in|of|throw|yield|await|void))[ \t]*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuyv]*)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/gm;

/** The scheme of a URL that names a host: http, https, ws, or wss. */
const SCHEME = /\b(?:https?|wss?):\/\//gi;

/** The authority of a URL: everything up to the path, the query, or the end of the literal. */
const AUTHORITY = /^[^\s/"'`?#<>()\\,;]*/;

/** A host name: labels of letters, digits, hyphens, and underscores, with an optional root dot. */
const HOST = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?$/;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** A scheme and its colon at the end of a text, where a line comment cannot start. */
const SCHEME_END = /\b(?:https?|wss?):$/i;

/**
 * Removes the comments of a TypeScript source and keeps its string literals.
 * A line comment right after a scheme is a URL that the tokenizer misread.
 * The scan then fails closed: it throws with the path and the line.
 */
export function stripComments(text: string, path: string): string {
  return text.replace(TOKEN, (all, literal: string | undefined, offset: number) => {
    if (literal !== undefined) return literal;
    if (all.startsWith("//") && SCHEME_END.test(text.slice(Math.max(0, offset - 8), offset)))
      throw new Error(
        `${path}:${text.slice(0, offset).split("\n").length}: the vendor scan cannot read this line; a URL reads as a comment`,
      );
    return all.startsWith("/*") ? " " : "";
  });
}

/**
 * The host of one URL authority, or null when it names no vendor. These name
 * no vendor: an empty authority, an IP literal, and a text that is not a host
 * name. A userinfo part
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

/** A host that core names only in a documentation link, with the reason it is not a vendor. */
export interface DocumentationHost {
  host: string;
  reason: string;
}

/**
 * The hosts that core names in a documentation link only. No request of a
 * deployment goes to them, so they are not vendors in the path. Each entry
 * states its reason. Plan 11g adds spec.openapis.org, the first entry.
 * Plan 12e adds schemas.openid.net: a URL that is the name of a claim, not
 * a place that core calls.
 * unusedDocumentationHosts fails an entry that no core file names.
 */
export const DOCUMENTATION_HOSTS: readonly DocumentationHost[] = [
  {
    host: "spec.openapis.org",
    reason:
      "a link to the OpenAPI 3.1 specification inside the text of the generated document (packages/core/src/openapi/responses.ts); no request goes to that host",
  },
  {
    host: "schemas.openid.net",
    reason:
      "the name of the back-channel logout event: a key of the events claim of a logout token (OIDC Back-Channel Logout 1.0 section 2.4, in packages/core/src/engine/oauth-logout.ts). No request goes to that host",
  },
];

/**
 * One core file that names a host as a name, not as a place that core calls.
 * The scan drops each host of `hosts` in this file only. The same host in
 * another file counts, and another host in this file counts.
 */
export interface FileHostException {
  /** The path of the file from the repository root. */
  path: string;
  hosts: readonly string[];
  reason: string;
}

/**
 * The exceptions of the scan: one entry for each file (plan 12d, ruling 22).
 * A folder skip hides each later host in that folder, so an entry names one
 * file and its hosts. unusedFileHostExceptions fails an entry whose file does
 * not name its host.
 */
export const FILE_HOST_EXCEPTIONS: readonly FileHostException[] = [
  {
    path: "packages/core/src/saml/xml.ts",
    hosts: ["www.w3.org"],
    reason:
      "the namespace names of the xml and xmlns prefixes (Namespaces in XML 1.0 section 3). A namespace name is a name, and the parser never fetches it",
  },
  {
    path: "packages/core/src/saml/dsig.ts",
    hosts: ["www.w3.org"],
    reason:
      "the XML Signature namespace name and the algorithm identifiers of the profile (XML Signature 1.1 section 6.1). The check compares each one as a name, and core never fetches it",
  },
];

/** True when `path` is the file of `exception`, also with a prefix before the repository path. */
function isExceptionFile(path: string, exception: FileHostException): boolean {
  return path === exception.path || path.endsWith(`/${exception.path}`);
}

/** The site's own host. A URL on our own domain names no other party. */
const OWN_HOST = new URL(SITE.origin).hostname;

/** True when the host is our own domain or a subdomain of it. */
function ownHost(host: string): boolean {
  return host === OWN_HOST || host.endsWith(`.${OWN_HOST}`);
}

/**
 * The hosts that the URLs in the code of one file name, before any list
 * applies. A file that the scan skips names no host.
 */
function fileUrlHosts(path: string, text: string): string[] {
  if (!path.includes("packages/core/src/") || !path.endsWith(".ts")) return [];
  if (
    path.includes("/src/social/") ||
    path.includes("/src/testing/") ||
    path.endsWith("/src/storage/conformance.ts") ||
    path.endsWith(".test.ts")
  )
    return [];
  const hosts: string[] = [];
  const code = stripComments(text, path);
  for (const m of code.matchAll(SCHEME)) {
    const rest = code.slice((m.index ?? 0) + m[0].length);
    const host = urlHost(AUTHORITY.exec(rest)?.[0] ?? "", path);
    if (host && !RESERVED.test(host) && !ownHost(host)) hosts.push(host);
  }
  return hosts;
}

/**
 * Every host that the URLs in core's code name, before the documentation
 * list applies. A host counts when an http, https, ws, or wss URL in the code
 * of a .ts file under packages/core/src/ names it. These do not count:
 * - a URL in a comment.
 * - src/social/: the provider presets. An app turns each one on in its own
 *   config, and the sign-in goes to the provider that the app chose.
 * - src/testing/, src/storage/conformance.ts, and .test.ts files: test
 *   helpers that no deployment runs.
 * - the reserved names of RESERVED, and an IP literal.
 * - the host of SITE.origin and its subdomains: our own domain.
 * - a host of an entry of FILE_HOST_EXCEPTIONS, in the file of that entry only.
 */
export function coreUrlHosts(
  files: ReadonlyMap<string, string>,
  exceptions: readonly FileHostException[] = FILE_HOST_EXCEPTIONS,
): string[] {
  const hosts = new Set<string>();
  for (const [path, text] of files) {
    const excepted = new Set(
      exceptions.filter((e) => isExceptionFile(path, e)).flatMap((e) => e.hosts),
    );
    for (const host of fileUrlHosts(path, text)) if (!excepted.has(host)) hosts.add(host);
  }
  return [...hosts].sort();
}

/**
 * Each host of an exception that its file does not name, as "path host".
 * Each one is a stale entry. A file that is not in `files` names no host.
 */
export function unusedFileHostExceptions(
  files: ReadonlyMap<string, string>,
  exceptions: readonly FileHostException[] = FILE_HOST_EXCEPTIONS,
): string[] {
  const named = new Set<string>();
  for (const [path, text] of files)
    for (const e of exceptions)
      if (isExceptionFile(path, e))
        for (const host of fileUrlHosts(path, text)) named.add(`${e.path} ${host}`);
  return exceptions.flatMap((e) =>
    e.hosts.map((host) => `${e.path} ${host}`).filter((entry) => !named.has(entry)),
  );
}

/**
 * The hosts of other parties that core's own code names: the "vendors in the
 * path" of brand spec 9 (decision 2 of 2026-10-15). They are the hosts of
 * coreUrlHosts, less the hosts of the documentation list.
 */
export function vendorHosts(
  files: ReadonlyMap<string, string>,
  documentation: readonly DocumentationHost[] = DOCUMENTATION_HOSTS,
  exceptions: readonly FileHostException[] = FILE_HOST_EXCEPTIONS,
): string[] {
  const skip = new Set(documentation.map((d) => d.host));
  return coreUrlHosts(files, exceptions).filter((host) => !skip.has(host));
}

/** The hosts of the documentation list that no core file names. Each one is a stale entry. */
export function unusedDocumentationHosts(
  files: ReadonlyMap<string, string>,
  documentation: readonly DocumentationHost[] = DOCUMENTATION_HOSTS,
): string[] {
  const named = new Set(coreUrlHosts(files));
  return documentation.map((d) => d.host).filter((host) => !named.has(host));
}
