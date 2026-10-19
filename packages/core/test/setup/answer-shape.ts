import { z } from "zod";

/**
 * The shape of a JSON answer against its schema (plan 11g Task 5, ruling
 * 8). `shapePaths` lists each optional key as `<path> absent` and each
 * nullable key as `<path> null`, as the generator writes the schema. The
 * walk goes through nested objects and array items (`tokens[].hint`). `shapeOf` reads one
 * body and answers the paths it leaves out and the paths it sets null. The
 * recorder writes the second; the check holds the first to it.
 */

/** A JSON schema node, as `z.toJSONSchema` writes it: the parts this file reads. */
interface Node {
  type?: unknown;
  properties?: Record<string, Node>;
  required?: string[];
  items?: Node;
  anyOf?: Node[];
}

export interface Shape {
  absent: string[];
  nulls: string[];
}

const SCHEMAS = new WeakMap<z.ZodType, Node>();

/** The JSON schema of `schema`, as the generator writes it; cached per schema. */
function nodeOf(schema: z.ZodType): Node {
  const known = SCHEMAS.get(schema);
  if (known) return known;
  const node = z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }) as Node;
  SCHEMAS.set(schema, node);
  return node;
}

/** A nullable node is `anyOf [X, null]` or a type list with "null": the branch that is not null, or null. */
function unwrap(node: Node): { inner: Node; nullable: boolean } {
  if (node.anyOf) {
    const branches = node.anyOf.filter((b) => b.type !== "null");
    if (branches.length < node.anyOf.length && branches.length === 1 && branches[0])
      return { inner: branches[0], nullable: true };
  }
  if (Array.isArray(node.type) && node.type.includes("null"))
    return { inner: node, nullable: true };
  return { inner: node, nullable: false };
}

function walkPaths(node: Node, prefix: string, out: string[]): void {
  const { inner } = unwrap(node);
  if (inner.properties) {
    const required = new Set(inner.required ?? []);
    for (const [key, child] of Object.entries(inner.properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!required.has(key)) out.push(`${path} absent`);
      if (unwrap(child).nullable) out.push(`${path} null`);
      walkPaths(child, path, out);
    }
  } else if (inner.items) walkPaths(inner.items, `${prefix}[]`, out);
}

/** Every optional and nullable path of `schema`: `"<path> absent"` and `"<path> null"`. */
export function shapePaths(schema: z.ZodType): string[] {
  const out: string[] = [];
  walkPaths(nodeOf(schema), "", out);
  return out;
}

function walkBody(node: Node, body: unknown, prefix: string, shape: Shape): void {
  const { inner } = unwrap(node);
  if (inner.properties) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return;
    const object = body as Record<string, unknown>;
    for (const [key, child] of Object.entries(inner.properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!(key in object)) shape.absent.push(path);
      else if (object[key] === null) shape.nulls.push(path);
      else walkBody(child, object[key], path, shape);
    }
  } else if (inner.items && Array.isArray(body)) {
    for (const item of body) walkBody(inner.items, item, `${prefix}[]`, shape);
  }
}

/** The paths of `schema` that `body` leaves out, and the paths it sets null, each once. */
export function shapeOf(schema: z.ZodType, body: unknown): Shape {
  const shape: Shape = { absent: [], nulls: [] };
  walkBody(nodeOf(schema), body, "", shape);
  return { absent: [...new Set(shape.absent)], nulls: [...new Set(shape.nulls)] };
}
