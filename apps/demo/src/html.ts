/**
 * The HTML of the demo pages (plan 11b Task 10). Every value goes through
 * `html`, which escapes it. So a name, an address, or a mail body that a
 * visitor sets is text and never markup. No other function makes `Html`.
 */
export interface Html {
  readonly __html: string;
}

/** The text of `s` for an element body or a quoted attribute value. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Each object that `html` made. An object from elsewhere with a `__html` key is not markup. */
const MADE = new WeakSet<object>();

function isHtml(value: unknown): value is Html {
  return typeof value === "object" && value !== null && MADE.has(value);
}

function part(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (isHtml(value)) return value.__html;
  if (Array.isArray(value)) return value.map(part).join("");
  return escapeHtml(String(value));
}

/**
 * A tagged template. Each value is escaped, except a value that is itself
 * `Html`. An array joins its parts. null, undefined, and false give no text.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  values.forEach((value, i) => {
    out += part(value) + (strings[i + 1] ?? "");
  });
  const made = Object.freeze({ __html: out });
  MADE.add(made);
  return made;
}

/**
 * The CSP of each answer of the Worker script. Every load comes from the
 * demo origin, and no inline script or style runs. public/_headers holds
 * the same text for the asset files, and a test ties the two.
 */
export const PAGE_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'";

/**
 * The headers of each answer of the Worker script. The Worker sets each one
 * only when the answer has no such header, so a page of core keeps its own
 * policy. Core sets strict-origin on its form pages: a form post under
 * no-referrer sends "Origin: null", which core refuses. The demo pages call
 * core through fetch, which sends the real origin (headless Chrome 155,
 * 2026-10-20).
 */
export const PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy": PAGE_POLICY,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
});
