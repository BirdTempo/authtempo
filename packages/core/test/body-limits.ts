import { ROUTE_CONTRACT } from "../src/http/contract/index.js";
import type { RouteContract } from "../src/http/contract/types.js";

/**
 * The derivation of the request body limits (rulings 43 and 46 of the 12j
 * lane). It walks the body schema of each route of `ROUTE_CONTRACT` and
 * computes three numbers of its largest valid body: the bytes, the depth of
 * nesting, and the items (each `[`, `{`, and `,` outside a string, as the
 * scan of `body-cap.ts` counts them). A form route also gets its fields,
 * the most pairs of a valid form (ruling 51).
 */

/** UTF-8 bytes of one UTF-16 unit of a JSON string: 3 for a character that is not a control character. */
export const JSON_UNIT = 3;
/** Bytes of one UTF-16 unit of a form value: `%XX%XX%XX` for a character of 3 UTF-8 bytes. */
export const FORM_UNIT = 9;
/** Digits, sign, point, and exponent of the longest JSON number that `JSON.stringify` writes. */
const NUMBER_MAX = 24;

interface ZodNode {
  readonly _zod: { readonly def: Record<string, unknown> & { type: string } };
}

/** The largest valid value of one schema node. */
export interface Measure {
  bytes: number;
  depth: number;
  items: number;
}

/** The `max_length` or `length_equals` check of a string or an array, or null for none. */
function maxOf(def: ZodNode["_zod"]["def"]): number | null {
  let max: number | null = null;
  for (const check of (def.checks ?? []) as ZodNode[]) {
    const d = check._zod.def as { check?: string; maximum?: number; length?: number };
    if (d.check === "max_length" && d.maximum !== undefined)
      max = Math.min(max ?? d.maximum, d.maximum);
    if (d.check === "length_equals" && d.length !== undefined) max = d.length;
  }
  return max;
}

const scalar = (bytes: number): Measure => ({ bytes, depth: 0, items: 0 });
const most = (all: Measure[]): Measure => ({
  bytes: Math.max(0, ...all.map((m) => m.bytes)),
  depth: Math.max(0, ...all.map((m) => m.depth)),
  items: Math.max(0, ...all.map((m) => m.items)),
});

/**
 * The largest valid value of `node` as compact JSON, with `unit` bytes for
 * each UTF-16 unit of a string. A node that no schema bounds (a string or an
 * array with no max, a record, an unknown, an open object) adds its least
 * size and its path to `open`: the cap is its bound. A zod type with no
 * rule here throws.
 */
export function measure(node: ZodNode, path: string, unit: number, open: string[]): Measure {
  const def = node._zod.def;
  const inner = (key: string) => def[key] as ZodNode;
  switch (def.type) {
    case "object": {
      const fields = Object.entries(def.shape as Record<string, ZodNode>);
      let bytes = 1;
      let depth = 0;
      // The brace, and a comma between two members.
      let items = 1 + Math.max(0, fields.length - 1);
      for (const [key, value] of fields) {
        const m = measure(value, `${path}.${key}`, unit, open);
        bytes += JSON.stringify(key).length + 1 + m.bytes + 1;
        depth = Math.max(depth, m.depth);
        items += m.items;
      }
      const rest = def.catchall as ZodNode | undefined;
      if (rest !== undefined && rest._zod.def.type !== "never") open.push(`${path}.*`);
      return { bytes, depth: depth + 1, items };
    }
    case "string": {
      const max = maxOf(def);
      if (max === null) open.push(path);
      return scalar(2 + (max ?? 0) * unit);
    }
    case "array": {
      const max = maxOf(def);
      const element = measure(inner("element"), `${path}[]`, unit, open);
      if (max === null) {
        open.push(`${path}[]`);
        return { bytes: 2, depth: 1, items: 1 };
      }
      return {
        bytes: 1 + max * (element.bytes + 1),
        depth: element.depth + 1,
        // The bracket, a comma between two elements, and the items of each element.
        items: 1 + Math.max(0, max - 1) + max * element.items,
      };
    }
    case "record":
      open.push(`${path}{}`);
      return { bytes: 2, depth: 1, items: 1 };
    case "unknown":
    case "any":
      open.push(`${path}: ${def.type}`);
      return scalar(0);
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "catch":
    case "nonoptional": {
      const m = measure(inner("innerType"), path, unit, open);
      return def.type === "nullable" ? most([m, scalar(4)]) : m;
    }
    case "pipe":
      return measure(inner("in"), path, unit, open);
    case "union":
      return most((def.options as ZodNode[]).map((o) => measure(o, path, unit, open)));
    case "enum":
      return scalar(
        Math.max(...Object.values(def.entries as object).map((v) => JSON.stringify(v).length)),
      );
    case "literal":
      return scalar(Math.max(...(def.values as unknown[]).map((v) => JSON.stringify(v).length)));
    case "boolean":
      return scalar(5);
    case "null":
      return scalar(4);
    case "number":
    case "int":
      return scalar(NUMBER_MAX);
    default:
      // A new zod type (a tuple, an intersection, a lazy) has no rule here.
      // Counted as 0 it would pass silently, so the derivation stops (ruling 46 Low 2).
      throw new Error(`body-limits: no rule for the zod type ${def.type} at ${path}`);
  }
}

/**
 * The most fields of a form body by its schema: the keys of its object, or
 * of the largest object of a union (ruling 51 of the 12j lane). A form takes
 * one pair for each field. A form schema that takes any key, or a zod type
 * with no rule here, throws: its pairs have no bound.
 */
export function formFields(node: ZodNode, path: string): number {
  const def = node._zod.def;
  switch (def.type) {
    case "object": {
      const rest = def.catchall as ZodNode | undefined;
      if (rest !== undefined && rest._zod.def.type !== "never")
        throw new Error(`body-limits: the form of ${path} takes any key`);
      return Object.keys(def.shape as object).length;
    }
    case "pipe":
      return formFields(def.in as ZodNode, path);
    case "union":
      return Math.max(...(def.options as ZodNode[]).map((o) => formFields(o, path)));
    default:
      throw new Error(`body-limits: no form rule for the zod type ${def.type} at ${path}`);
  }
}

/** The largest valid body of one route. */
export interface RouteBody extends Measure {
  key: string;
  media: string;
  /** The paths of the nodes that no schema bounds. */
  open: string[];
  /** The most pairs of a valid form body: its fields. 0 for a route that takes no form. */
  pairs: number;
}

/** The largest valid body of each route with a body, largest first. */
export function largestBodies(): RouteBody[] {
  const contract: Record<string, RouteContract> = ROUTE_CONTRACT;
  const rows: RouteBody[] = [];
  for (const [key, c] of Object.entries(contract)) {
    if (c.body === undefined) continue;
    const schema = c.body.schema as unknown as ZodNode;
    const open: string[] = [];
    const json = c.body.media.includes("json") ? measure(schema, key, JSON_UNIT, open) : scalar(0);
    // The JSON walk with the form unit: an upper bound of the form, which has no quotes or braces.
    const form = c.body.media.includes("form") ? measure(schema, key, FORM_UNIT, []) : scalar(0);
    rows.push({
      key,
      media: c.body.media.join("+"),
      bytes: Math.max(json.bytes, form.bytes),
      depth: json.depth,
      items: json.items,
      open,
      pairs: c.body.media.includes("form") ? formFields(schema, key) : 0,
    });
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}
