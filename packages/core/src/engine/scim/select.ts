/**
 * The query parameters of a SCIM list and read (plan 12d Task 9 Behaviors
 * 7 and 8). They are the paging of RFC 7644 section 3.4.2.4 and the
 * attribute selection of section 3.9. A parameter that core does not serve answers
 * 400 `invalidValue`, never a silent default.
 */

import { scimError } from "./answer.js";
import { asciiLower } from "./filter.js";

/** The most resources of one page. The ServiceProviderConfig gives it as `filter.maxResults`. */
export const SCIM_PAGE_MAX = 100;

/** A base-10 integer with an optional sign, as a query parameter carries it. */
const INTEGER_RE = /^[+-]?\d{1,15}$/;

/** The one value of a parameter, null when absent, or undefined when the query repeats it. */
function single(url: URL, name: string): string | null | undefined {
  const all = url.searchParams.getAll(name);
  if (all.length > 1) return undefined;
  return all[0] ?? null;
}

/**
 * `startIndex` and `count` (RFC 7644 section 3.4.2.4). Each is an integer.
 * A `startIndex` below 1 reads as 1. A negative `count` reads as 0, and a
 * `count` above 100 reads as 100; the default is 100. A list sorts by `id`,
 * and core serves no sort. So `sortBy` and `sortOrder` answer 400
 * `invalidValue`, as does a value that does not fit another parameter.
 */
export function pageParams(
  url: URL,
): { ok: true; startIndex: number; count: number } | { ok: false; response: Response } {
  const refuse = (detail: string) => ({
    ok: false as const,
    response: scimError(400, detail, "invalidValue"),
  });
  if (url.searchParams.has("sortBy") || url.searchParams.has("sortOrder"))
    return refuse("this server does not sort; a list comes in the order of its id");
  const start = single(url, "startIndex");
  const count = single(url, "count");
  if (start === undefined || (start !== null && !INTEGER_RE.test(start)))
    return refuse("startIndex must be one integer");
  if (count === undefined || (count !== null && !INTEGER_RE.test(count)))
    return refuse("count must be one integer");
  return {
    ok: true,
    startIndex: start === null ? 1 : Math.max(1, Number(start)),
    count: count === null ? SCIM_PAGE_MAX : Math.min(SCIM_PAGE_MAX, Math.max(0, Number(count))),
  };
}

/** The attributes that every answer holds (RFC 7643 section 7, `returned: always`). */
const ALWAYS: ReadonlySet<string> = new Set(["id", "schemas", "meta"]);

/**
 * The sub-attributes and the schema URN that an attribute name of a
 * resource may carry (RFC 7644 section 3.10). `subs` maps a top-level name,
 * in lower case, to the names of its sub-attributes. `core` is the URN of
 * the resource's core schema, in lower case. A top-level name of `known`
 * that starts with `urn:` is an extension, and its sub-attributes are its
 * attributes.
 */
export interface AttributeNotation {
  readonly subs: ReadonlyMap<string, ReadonlySet<string>>;
  readonly core: string;
}

/** One name of a list: a top-level name, and a sub-attribute or null. */
type Name = { top: string; sub: string | null };

/**
 * One name in the standard notation of RFC 7644 section 3.10, or null: `attr`,
 * `attr.sub`, either one after the core URN and a colon, an extension URN,
 * or `<extension URN>:attr`. Each part is read in lower case.
 */
function nameOf(
  part: string,
  known: ReadonlySet<string>,
  notation: AttributeNotation | null,
): Name | null {
  let text = asciiLower(part.trim());
  if (notation !== null && text.startsWith(`${notation.core}:`))
    text = text.slice(notation.core.length + 1);
  let name: Name;
  const extension =
    notation === null
      ? undefined
      : [...known].find((k) => k.startsWith("urn:") && (text === k || text.startsWith(`${k}:`)));
  if (extension !== undefined)
    name = {
      top: extension,
      sub: text === extension ? null : text.slice(extension.length + 1),
    };
  else {
    const dot = text.indexOf(".");
    name =
      dot < 0 ? { top: text, sub: null } : { top: text.slice(0, dot), sub: text.slice(dot + 1) };
  }
  if (!known.has(name.top)) return null;
  if (name.sub !== null && notation?.subs.get(name.top)?.has(name.sub) !== true) return null;
  return name;
}

/** The names of one list parameter, or null for a name that `known` lacks. */
function namesOf(
  text: string,
  known: ReadonlySet<string>,
  notation: AttributeNotation | null,
): Name[] | null {
  const names: Name[] = [];
  for (const part of text.split(",")) {
    const name = nameOf(part, known, notation);
    if (name === null) return null;
    names.push(name);
  }
  return names;
}

/** The value with only the sub-attributes of `subs` (`keep`) or without them. A list maps each item. */
function pickSubs(value: unknown, subs: ReadonlySet<string>, keep: boolean): unknown {
  const one = (item: unknown): unknown => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) if (subs.has(asciiLower(k)) === keep) out[k] = v;
    return out;
  };
  return Array.isArray(value) ? value.map(one) : one(value);
}

/**
 * `attributes` or `excludedAttributes` (RFC 7644 section 3.9), not both.
 * Each is a comma-separated list of names of the resource's schema, in any
 * case. `known` holds the top-level names in lower case, an extension URN
 * among them. With `notation`, a name may also take the standard notation
 * of section 3.10: a sub-attribute (`name.givenName`), the core URN before
 * it, or an extension URN before an attribute of the extension. Then only
 * that sub-attribute is returned, or left out. An unknown name answers 400
 * `invalidValue`. `id`, `schemas`, and `meta` are always returned.
 */
export function selectAttributes(
  resource: Record<string, unknown>,
  url: URL,
  known: ReadonlySet<string>,
  notation: AttributeNotation | null = null,
): { ok: true; value: Record<string, unknown> } | { ok: false; response: Response } {
  const refuse = (detail: string) => ({
    ok: false as const,
    response: scimError(400, detail, "invalidValue"),
  });
  const wanted = single(url, "attributes");
  const excluded = single(url, "excludedAttributes");
  if (wanted === undefined || excluded === undefined)
    return refuse("attributes and excludedAttributes each come at most once");
  if (wanted !== null && excluded !== null)
    return refuse("send attributes or excludedAttributes, not both");
  const list = wanted ?? excluded;
  if (list === null) return { ok: true, value: resource };
  const names = namesOf(list, known, notation);
  if (names === null) return refuse("the list names an attribute that this resource does not have");
  const whole = new Set(names.filter((n) => n.sub === null).map((n) => n.top));
  const parts = new Map<string, Set<string>>();
  for (const n of names)
    if (n.sub !== null && !whole.has(n.top))
      parts.set(n.top, (parts.get(n.top) ?? new Set()).add(n.sub));
  const value: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(resource)) {
    const name = asciiLower(key);
    const subs = parts.get(name);
    if (ALWAYS.has(name)) value[key] = v;
    else if (wanted !== null) {
      if (whole.has(name)) value[key] = v;
      else if (subs) value[key] = pickSubs(v, subs, true);
    } else if (!whole.has(name)) value[key] = subs ? pickSubs(v, subs, false) : v;
  }
  return { ok: true, value };
}
