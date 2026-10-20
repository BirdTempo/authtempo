import { isIpLiteral } from "../../primitives/host.js";
import { hasControlChar } from "../../primitives/text.js";

/**
 * The email domains that an organization proves by DNS (plan 12d, spec 30
 * items 2 to 4). Task 2a holds the domain form only. The proofs, the
 * recheck, and the routes come with the `ssoDomain` model (Task 2b).
 */

/** The longest DNS name in text form, with no trailing dot (RFC 1035 section 2.3.4). */
const DOMAIN_MAX = 253;
/** The characters that no host name holds, refused before the URL parser sees them. */
const DOMAIN_REFUSED_RE = /[*/:@\s]/;
/** One label of a lowercase host name: letters, digits, and inner hyphens, 1 to 63 characters (RFC 1123 section 2.1). */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Only ASCII: such a label must come out of the URL parser as it went in. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the class is the whole ASCII range.
const ASCII_RE = /^[\u0000-\u007f]*$/;

/**
 * The lowercase A-label form of an email domain, or null (spec 30 item 2).
 * The URL parser maps a Unicode label to its IDNA A-label (`xn--`). It also
 * maps a full-width letter or a soft hyphen to ASCII. A label with such a
 * character must come out as an A-label, or it is refused. So a full-width
 * `xn--` label passes: the answer is the canonical form of the same name.
 * An ideographic dot adds a label, so it is refused too.
 * Refused: a trailing dot, `*`, `/`, `:`, `@`, and white space. Also
 * refused: a control character, an IP literal, a single label, and a label
 * that is not a host name label.
 */
export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > DOMAIN_MAX) return null;
  const value = raw.toLowerCase();
  // A trailing dot names the same host. One stored form keeps one claim per domain.
  if (value.endsWith(".")) return null;
  if (DOMAIN_REFUSED_RE.test(value) || hasControlChar(value)) return null;
  let host: string;
  try {
    // A host after `//` on an https base: the parser reads it as the host of an https URL.
    // The base is a reserved name, so the site's vendor scan reads no tenant host as a vendor.
    host = new URL(`//${value}`, "https://domain.invalid").hostname;
  } catch {
    return null;
  }
  const given = value.split(".");
  const mapped = host.split(".");
  if (mapped.length !== given.length) return null;
  for (let i = 0; i < given.length; i++) {
    const label = given[i] ?? "";
    const out = mapped[i] ?? "";
    // An ASCII label comes out as it went in. A Unicode label comes out as an A-label.
    if (ASCII_RE.test(label) ? out !== label : !out.startsWith("xn--")) return null;
  }
  if (isIpLiteral(host)) return null;
  // A single label is an intranet name, or a top-level domain that no organization proves.
  if (mapped.length < 2) return null;
  // An A-label is longer than its Unicode label, so the mapped host has its own length check.
  if (host.length > DOMAIN_MAX) return null;
  if (!mapped.every((l) => LABEL_RE.test(l))) return null;
  return host;
}
