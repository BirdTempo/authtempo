/** One Set-Cookie line: its name, and each attribute by its lower-case name. */
export interface Cookie {
  line: string;
  name: string;
  attrs: Map<string, string>;
}

export function parseCookie(line: string): Cookie {
  const [pair = "", ...rest] = line.split(";");
  const attrs = new Map<string, string>();
  for (const part of rest) {
    const at = part.indexOf("=");
    const key = (at < 0 ? part : part.slice(0, at)).trim().toLowerCase();
    attrs.set(key, at < 0 ? "" : part.slice(at + 1).trim());
  }
  return { line, name: pair.slice(0, pair.indexOf("=")).trim(), attrs };
}

/**
 * Each break of the cookie rule of the demo (plan 11b, deviation 3) in the
 * lines, with its reason. A line has no Domain, and it is Secure and HttpOnly.
 * A __Host- cookie has Path=/, and a cookie with another path has no __Host-
 * prefix (RFC 6265bis 4.1.3.2: a browser drops such a cookie).
 */
export function cookieFaults(lines: readonly string[]): string[] {
  const faults: string[] = [];
  for (const c of lines.map(parseCookie)) {
    if (c.attrs.has("domain")) faults.push(`has a Domain: ${c.line}`);
    if (!c.attrs.has("secure") || !c.attrs.has("httponly"))
      faults.push(`is not Secure and HttpOnly: ${c.line}`);
    if (c.name.startsWith("__Host-") && c.attrs.get("path") !== "/")
      faults.push(`is __Host- with another path: ${c.line}`);
  }
  return faults;
}
