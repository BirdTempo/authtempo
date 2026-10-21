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

/** The names of one list parameter, in lower case, or null for a name that `known` lacks. */
function namesOf(text: string, known: ReadonlySet<string>): Set<string> | null {
  const names = new Set<string>();
  for (const part of text.split(",")) {
    const name = asciiLower(part.trim());
    if (!known.has(name)) return null;
    names.add(name);
  }
  return names;
}

/**
 * `attributes` or `excludedAttributes` (RFC 7644 section 3.9), not both.
 * Each is a comma-separated list of the top-level names of the resource's
 * schema, or of the enterprise URN, in any case. `known` holds those names
 * in lower case. An unknown name answers 400 `invalidValue`. `id`,
 * `schemas`, and `meta` are always returned.
 */
export function selectAttributes(
  resource: Record<string, unknown>,
  url: URL,
  known: ReadonlySet<string>,
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
  const names = namesOf(list, known);
  if (names === null) return refuse("the list names an attribute that this resource does not have");
  const value: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(resource)) {
    const name = asciiLower(key);
    const keep = ALWAYS.has(name) || (wanted !== null ? names.has(name) : !names.has(name));
    if (keep) value[key] = v;
  }
  return { ok: true, value };
}
