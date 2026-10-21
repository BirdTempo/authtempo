import { type ModelName, type Models, schema } from "@authtempo/core";

export const t0 = new Date("2026-01-01T00:00:00.000Z");

let next = 0;

/**
 * A row of `model` that each adapter stores. Each string field holds a short
 * new string. The other fields hold 1, false, t0, or an empty object, or null
 * where the field is nullable. `over` sets fields of the test.
 */
export function rowOf<M extends ModelName>(model: M, over: Partial<Models[M]> = {}): Models[M] {
  next += 1;
  const fields = schema[model].fields as Record<string, { type: string; nullable?: boolean }>;
  const row: Record<string, unknown> = {};
  for (const [field, def] of Object.entries(fields)) {
    if (def.nullable) row[field] = null;
    else if (def.type === "string") row[field] = `${field.slice(0, 4)}${next}`;
    else if (def.type === "integer") row[field] = 1;
    else if (def.type === "boolean") row[field] = false;
    else if (def.type === "date") row[field] = t0;
    else row[field] = {};
  }
  return { ...row, ...over } as unknown as Models[M];
}
