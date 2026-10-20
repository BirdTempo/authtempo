import { z } from "zod";

/**
 * The shape of a JSON answer against its schema (plan 11g Task 5, rulings
 * 8 and 9). `shapePaths` lists each optional key as `<path> absent` and each
 * nullable key as `<path> null`, as the generator writes the schema. The
 * walk goes through nested objects, array items (`tokens[].hint`), and each
 * branch of a union. A path of two branches is one path. `shapeOf` reads one
 * body and answers the paths it leaves out and the paths it sets null. The
 * recorder writes the second; the check holds the first to it. A body that
 * fits two branches of a union is a failure, because the walk can read it
 * under the wrong branch.
 */

/** A JSON schema node, as `z.toJSONSchema` writes it: the parts this file reads. */
interface Node {
  type?: unknown;
  properties?: Record<string, Node>;
  required?: string[];
  items?: Node;
  anyOf?: Node[];
  additionalProperties?: boolean | Node;
  [keyword: string]: unknown;
}

export interface Shape {
  absent: string[];
  nulls: string[];
}

/** The shape of one body, and each union at which the body fits two branches. */
export interface BodyShape extends Shape {
  twoBranches: string[];
}

/** The paths of a schema, and each node that the walk cannot enter. */
export interface Paths {
  paths: string[];
  blocked: string[];
}

/**
 * The keywords that the walk enters or that hold no key. Any other keyword
 * (`oneOf`, `allOf`, `$ref`, `not`, `if`, `prefixItems`) is a node the walk
 * cannot enter. The check fails on it by name, so a new kind cannot hide keys.
 * `answer-shape.test.ts` pins both lists.
 */
export const ENTERED: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "items",
  "anyOf",
  "additionalProperties",
]);
export const NO_KEYS: ReadonlySet<string> = new Set([
  "$schema",
  "const",
  "enum",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "propertyNames",
  "contentEncoding",
  "description",
  "title",
  "default",
  "examples",
]);

const SCHEMAS = new WeakMap<z.ZodType, Node>();

/** The JSON schema of `schema`, as the generator writes it; cached per schema. */
function nodeOf(schema: z.ZodType): Node {
  const known = SCHEMAS.get(schema);
  if (known) return known;
  const node = z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }) as Node;
  SCHEMAS.set(schema, node);
  return node;
}

/**
 * The branches of a node that are not null, and whether null is one of
 * them. A node with no `anyOf` is its own one branch. A type list with
 * "null" is nullable too.
 */
function branchesOf(node: Node): { branches: Node[]; nullable: boolean } {
  const typeNull = Array.isArray(node.type) && node.type.includes("null");
  if (!node.anyOf) return { branches: [node], nullable: typeNull };
  const branches = node.anyOf.filter((b) => b.type !== "null");
  return { branches, nullable: typeNull || branches.length < node.anyOf.length };
}

const SCALARS: ReadonlySet<unknown> = new Set(["string", "number", "integer", "boolean", "null"]);

/** True when `node` holds a scalar type, or a list of them, and only keywords of `NO_KEYS` beside it. */
function scalar(node: Node): boolean {
  const types = Array.isArray(node.type) ? node.type : [node.type];
  return (
    node.type !== undefined &&
    types.every((t) => SCALARS.has(t)) &&
    Object.keys(node).every((k) => k === "type" || NO_KEYS.has(k))
  );
}

/**
 * True when the value node of a record holds no key: a free value (`{}`), a
 * scalar, or a list of scalars (a statement set, plan 12k). The walk does not
 * enter this node, so it never reads its keywords. Any other value can hide an
 * optional key: `oneOf`, `prefixItems`, or a list of objects (review 12k Task 3, M3).
 */
function flatValue(node: Node): boolean {
  if (Object.keys(node).every((k) => NO_KEYS.has(k)) || scalar(node)) return true;
  return (
    node.type === "array" &&
    typeof node.items === "object" &&
    scalar(node.items) &&
    Object.keys(node).every((k) => k === "type" || k === "items" || NO_KEYS.has(k))
  );
}

function walkPaths(node: Node, prefix: string, out: Paths): void {
  const where = prefix || "the answer";
  for (const keyword of Object.keys(node))
    if (!ENTERED.has(keyword) && !NO_KEYS.has(keyword))
      out.blocked.push(`the walk cannot enter ${keyword} at ${where}`);
  const { branches } = branchesOf(node);
  if (node.anyOf) {
    for (const branch of branches) walkPaths(branch, prefix, out);
    return;
  }
  const record = node.additionalProperties;
  // A record (`extensions`, `metadata`) has free keys: no key of it is optional or nullable.
  if (typeof record === "object" && !flatValue(record))
    out.blocked.push(`the walk cannot enter a record of shaped values at ${where}`);
  if (node.properties) {
    const required = new Set(node.required ?? []);
    for (const [key, child] of Object.entries(node.properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!required.has(key)) out.paths.push(`${path} absent`);
      if (branchesOf(child).nullable) out.paths.push(`${path} null`);
      walkPaths(child, path, out);
    }
  }
  if (node.items) walkPaths(node.items, `${prefix}[]`, out);
}

/**
 * Every optional and nullable path of `schema` (`"<path> absent"` and
 * `"<path> null"`), each once, and each node the walk cannot enter.
 */
export function shapePaths(schema: z.ZodType): Paths {
  const out: Paths = { paths: [], blocked: [] };
  walkPaths(nodeOf(schema), "", out);
  return { paths: [...new Set(out.paths)], blocked: [...new Set(out.blocked)] };
}

/** The JSON type names that `value` has. An integer is a number too. */
function typesOf(value: unknown): string[] {
  if (value === null) return ["null"];
  if (Array.isArray(value)) return ["array"];
  if (typeof value === "number")
    return Number.isInteger(value) ? ["number", "integer"] : ["number"];
  return [typeof value];
}

/**
 * True when `body` has the form of `node`. The body has the node's type,
 * `const`, `enum`, `pattern`, and required keys. It has no key that a closed
 * object does not name, and each value has the form of its node. The fit does
 * not read `format`, so a body can fit two branches. `walkBody` reports each
 * such union, and the recorder fails the answer.
 */
function fits(node: Node, body: unknown): boolean {
  const { branches, nullable } = branchesOf(node);
  if (body === null && nullable) return true;
  if (node.anyOf) return branches.some((b) => fits(b, body));
  if (node.const !== undefined && node.const !== body) return false;
  if (Array.isArray(node.enum) && !node.enum.includes(body)) return false;
  if (typeof node.pattern === "string" && typeof body === "string")
    if (!new RegExp(node.pattern).test(body)) return false;
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  if (types.length > 0 && !typesOf(body).some((t) => types.includes(t))) return false;
  if (node.properties) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
    const object = body as Record<string, unknown>;
    if (!(node.required ?? []).every((key) => key in object)) return false;
    for (const [key, value] of Object.entries(object)) {
      const child = node.properties[key];
      if (!child) {
        if (node.additionalProperties === false) return false;
        continue;
      }
      if (!fits(child, value)) return false;
    }
  }
  if (node.items && Array.isArray(body))
    return body.every((item) => fits(node.items as Node, item));
  return true;
}

function walkBody(node: Node, body: unknown, prefix: string, shape: BodyShape): void {
  if (node.anyOf) {
    const fitting = branchesOf(node).branches.filter((b) => fits(b, body));
    if (fitting.length > 1) shape.twoBranches.push(prefix || "the answer");
    if (fitting[0]) walkBody(fitting[0], body, prefix, shape);
    return;
  }
  if (node.properties) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return;
    const object = body as Record<string, unknown>;
    for (const [key, child] of Object.entries(node.properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!(key in object)) shape.absent.push(path);
      else if (object[key] === null) shape.nulls.push(path);
      else walkBody(child, object[key], path, shape);
    }
  } else if (node.items && Array.isArray(body)) {
    for (const item of body) walkBody(node.items, item, `${prefix}[]`, shape);
  }
}

/**
 * The paths of `schema` that `body` leaves out, the paths it sets null, and
 * the unions at which it fits two branches, each once.
 */
export function shapeOf(schema: z.ZodType, body: unknown): BodyShape {
  const shape: BodyShape = { absent: [], nulls: [], twoBranches: [] };
  walkBody(nodeOf(schema), body, "", shape);
  return {
    absent: [...new Set(shape.absent)],
    nulls: [...new Set(shape.nulls)],
    twoBranches: [...new Set(shape.twoBranches)],
  };
}

/** The verdict of a body that parses under its schema, beside its shape. */
export interface ShapeJudged extends Shape {
  verdict: string;
}

/**
 * The record of a body that parses under its schema: the verdict `ok`, or a
 * failure when the body fits two branches of a union. The walk can read such
 * a body under the wrong branch and hide a key of the right one.
 */
export function shapeVerdict(schema: z.ZodType, body: unknown): ShapeJudged {
  const { twoBranches, ...shape } = shapeOf(schema, body);
  if (twoBranches.length > 0)
    return {
      verdict: `the body fits two branches of a union at ${twoBranches.join(", ")}`,
      ...shape,
    };
  return { verdict: "ok", ...shape };
}
