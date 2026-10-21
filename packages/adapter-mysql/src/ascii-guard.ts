import { type ModelName, StorageError, type Where } from "@authtempo/core";
import { MYSQL_STRINGS } from "@authtempo/core/ddl";

/**
 * The rule of an ascii column on MySQL (plan 12g, Task 5). Read on 8.4.11
 * and 9.7.2 on 2026-10-21:
 *
 * - A parameter that holds a character outside ASCII fails each statement
 *   on an ascii column with error 3988, a read too. Postgres answers no row.
 * - `ascii_bin` is a PAD SPACE collation, and MySQL has no NO PAD ascii
 *   collation. So 'a' equals 'a ', and a unique key refuses both. Postgres
 *   and D1 keep them apart.
 *
 * So an ascii column holds printable ASCII (U+0020 to U+007E) with no
 * trailing space. Every engine value there is such a value: ids, hashes,
 * slugs, role names, and URLs. A write of another value answers
 * invalid_argument before the statement. A where value that breaks the rule
 * cannot equal a stored value, so this module rewrites its clause. The
 * answer is the one that Postgres gives by byte order.
 */

/** The width of each ascii column by `<model>.<field>`. */
const ASCII_LENGTH: ReadonlyMap<string, number> = new Map(
  Object.entries(MYSQL_STRINGS)
    .filter(([, row]) => row.charset === "ascii")
    .map(([key, row]) => [key, row.length]),
);

const FIRST = 0x20;
const LAST = 0x7e;
/** U+007F sorts after every character that an ascii column holds. */
const AFTER_ALL = "\u007f";

/** The index of the first code unit outside U+0020 to U+007E, or -1. */
function firstOutside(value: string): number {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < FIRST || c > LAST) return i;
  }
  return -1;
}

/** True for a value that an ascii column can hold: printable ASCII with no trailing space. */
export function storable(value: string): boolean {
  return firstOutside(value) === -1 && !value.endsWith(" ");
}

function invalid(model: ModelName, field: string): StorageError {
  const e = new StorageError("invalid_argument", model, [field]);
  e.message = `${e.message}: the MySQL column holds printable ASCII with no trailing space`;
  return e;
}

/** Refuses a write of a string to an ascii column that the column cannot hold as Postgres does. */
export function guardData(model: ModelName, data: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(data)) {
    if (typeof value !== "string" || !ASCII_LENGTH.has(`${model}.${field}`)) continue;
    if (!storable(value)) throw invalid(model, field);
  }
}

/**
 * The bound of a range clause whose value `s` breaks the rule. It gives each
 * stored value `v` the answer of the byte order of `v` against `s`.
 *
 * - The first bad character is above U+007E, after the prefix `p`. Then
 *   `v < s` holds when `v < p + U+007F...`. The bound holds one more U+007F
 *   than the column holds characters.
 * - The first bad character is below U+0020, or `s` ends in spaces. Then
 *   `v < s` holds when `v <= q`. `q` is the prefix without its trailing
 *   spaces.
 */
function rangeClause<M extends ModelName>(w: Where<M>, s: string, length: number): Where<M> {
  const at = firstOutside(s);
  const below = w.op === "lt" || w.op === "lte";
  if (at !== -1 && s.charCodeAt(at) > LAST)
    return { ...w, op: below ? "lt" : "gt", value: s.slice(0, at) + AFTER_ALL.repeat(length + 1) };
  const q = (at === -1 ? s : s.slice(0, at)).replace(/ +$/, "");
  return { ...w, op: below ? "lte" : "gt", value: q };
}

/**
 * True for a where value that core refuses with invalid_argument: a NUL in
 * any string, or a lone surrogate in a prefix (core/src/storage/sql.ts).
 */
function coreRefuses(op: Where<ModelName>["op"], v: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => typeof x === "string" && x.includes("\u0000"));
  if (typeof v !== "string") return false;
  return v.includes("\u0000") || (op === "startsWith" && /\p{Cs}/u.test(v));
}

/**
 * The where clauses with each value on an ascii column that breaks the rule
 * rewritten, or null when no row can match. Other clauses pass unchanged,
 * and core checks them. A value that core refuses also passes unchanged. An
 * answer here would give rows where every other store refuses the call.
 */
export function guardWhere<M extends ModelName>(model: M, where: Where<M>[]): Where<M>[] | null {
  const out: Where<M>[] = [];
  for (const w of where) {
    const length = ASCII_LENGTH.get(`${model}.${w.field}`);
    if (length === undefined || coreRefuses(w.op, w.value)) {
      out.push(w);
      continue;
    }
    const v = w.value;
    switch (w.op) {
      case "eq":
        if (typeof v === "string" && !storable(v)) return null;
        out.push(w);
        break;
      case "ne":
        out.push(typeof v === "string" && !storable(v) ? { ...w, value: null } : w);
        break;
      case "in":
        out.push(
          Array.isArray(v)
            ? { ...w, value: v.filter((x) => typeof x !== "string" || storable(x)) }
            : w,
        );
        break;
      case "startsWith":
        if (typeof v !== "string" || storable(v)) out.push(w);
        else if (firstOutside(v) !== -1) return null;
        else {
          // PAD SPACE: substr('ab', 1, 3) equals 'ab ', so the prefix 'ab '
          // would match the value 'ab'. Only that one value matches wrongly.
          out.push(w, { ...w, op: "ne", value: v.replace(/ +$/, "") });
        }
        break;
      case "lt":
      case "lte":
      case "gt":
      case "gte":
        out.push(typeof v === "string" && !storable(v) ? rangeClause(w, v, length) : w);
        break;
    }
  }
  return out;
}
