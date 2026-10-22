/**
 * The SCIM filter subset (plan 12d Task 9 Behavior 6, RFC 7644 section
 * 3.4.2.2). Filtering is OPTIONAL in RFC 7644, and core serves one `eq`
 * clause, plus the one member check that Entra ID sends. The text comes from
 * a directory, so the reader bounds its length, scans it once, and builds no
 * regular expression and no query from it. Every other text answers null, and
 * the route answers 400 `invalidFilter`.
 */

import { hasControlChar } from "../../primitives/text.js";

type FilterAttr = "userName" | "externalId" | "emails.value" | "id" | "displayName";

export type ScimFilter =
  | { attr: FilterAttr; value: string }
  | { attr: "id"; value: string; member: string };

/**
 * The key form of a text that SCIM compares with no case: NFKC, then lower
 * case. RFC 7643 sections 4.1.1 and 4.2 make `userName` and `displayName`
 * case-insensitive.
 */
export function scimKey(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** The longest filter text that core reads. An address is at most 254 characters, so 1024 leaves room for an external id. */
export const SCIM_FILTER_MAX = 1024;

// A Map, not an object: a name such as `__proto__` or `constructor` finds nothing.
const USER_ATTRS: ReadonlyMap<string, FilterAttr> = new Map([
  ["username", "userName"],
  ["externalid", "externalId"],
  ["emails.value", "emails.value"],
  ["id", "id"],
]);

const GROUP_ATTRS: ReadonlyMap<string, FilterAttr> = new Map([
  ["displayname", "displayName"],
  ["externalid", "externalId"],
  ["id", "id"],
]);

// A lone surrogate is not text (the rule of engine/users.ts). The u flag
// reads a pair as one code point, so only a lone half matches. The core lib is
// ES2023, which does not type String.prototype.isWellFormed.
const LONE_SURROGATE_RE = /\p{Cs}/u;

const MEMBER_ATTRS: ReadonlyMap<string, "value"> = new Map([["value", "value"]]);

// The text between the group clause and the member clause, in lowercase.
const MEMBER_JOIN = " and members[";

/**
 * Lowercases the ASCII letters only. `toLowerCase` maps some other signs to
 * ASCII letters (U+212A KELVIN SIGN to `k`), and a name must not match by them.
 */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * Reads the JSON string literal that starts at `at`. The scan finds the first
 * quote that no backslash escapes, and `JSON.parse` of the literal reads the
 * escapes and refuses a raw control character. An escape can still give a C0
 * control character, DEL, or a lone surrogate, so the value is checked after
 * the parse. Postgres text refuses a NUL. Answers null for any other form.
 */
export function readJsonString(text: string, at: number): { value: string; end: number } | null {
  if (text[at] !== '"') return null;
  let i = at + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  if (i >= text.length) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(at, i + 1));
  } catch {
    return null;
  }
  if (typeof value !== "string" || hasControlChar(value) || LONE_SURROGATE_RE.test(value))
    return null;
  return { value, end: i + 1 };
}

/**
 * Reads `<attr> eq <JSON string>` at `at`, with one space on each side of
 * `eq`. RFC 7644 section 3.4.2.2 makes attribute names and operators case
 * insensitive, so both match in any case.
 */
function readEq<A extends string>(
  text: string,
  at: number,
  attrs: ReadonlyMap<string, A>,
): { attr: A; value: string; end: number } | null {
  const space = text.indexOf(" ", at);
  if (space < 0) return null;
  const attr = attrs.get(asciiLower(text.slice(at, space)));
  if (attr === undefined) return null;
  const operator = asciiLower(text.slice(space, space + 4));
  if (operator !== " eq ") return null;
  const literal = readJsonString(text, space + 4);
  if (literal === null) return null;
  return { attr, value: literal.value, end: literal.end };
}

/**
 * Reads a filter of the subset, or answers null. The value is the literal as
 * sent: the caller compares `userName`, `emails.value`, and `displayName` by
 * the key form, and `externalId` and `id` exactly.
 */
export function parseScimFilter(text: string, resource: "User" | "Group"): ScimFilter | null {
  if (text.length === 0 || text.length > SCIM_FILTER_MAX) return null;
  const first = readEq(text, 0, resource === "User" ? USER_ATTRS : GROUP_ATTRS);
  if (first === null) return null;
  if (first.end === text.length) return { attr: first.attr, value: first.value };
  // Entra ID checks one member of a group with this one form.
  if (resource !== "Group" || first.attr !== "id") return null;
  if (asciiLower(text.slice(first.end, first.end + MEMBER_JOIN.length)) !== MEMBER_JOIN)
    return null;
  const member = readEq(text, first.end + MEMBER_JOIN.length, MEMBER_ATTRS);
  if (member === null || text.slice(member.end) !== "]") return null;
  return { attr: "id", value: first.value, member: member.value };
}
