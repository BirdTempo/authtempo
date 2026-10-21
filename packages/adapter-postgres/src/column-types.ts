import { type ModelName, schema } from "@authtempo/core";
import { columnType } from "@authtempo/core/ddl";
import { type encodeValue, POSTGRES } from "@authtempo/core/sql";

/** A core field type, as `schema` names it. */
export type CoreFieldType = Parameters<typeof encodeValue>[1];

const MODELS = Object.keys(schema) as ModelName[];

/**
 * The Postgres column type of each core field, as `information_schema`
 * names it: the migrations write these, and the parity tests of this package
 * and of the compat package read this one map (plan 9f final fix wave: one
 * source for one fact). The rule lives in `@authtempo/core/ddl` (plan 12g),
 * which reads `int64` from the schema. This function keeps its signature for
 * the compat parity tests: it finds the field by its name, because one field
 * name has one meaning across the schema (a test of this package holds it).
 */
export function postgresColumnType(field: string, type: CoreFieldType): string {
  const model = MODELS.find(
    (m) =>
      (schema[m].fields as Record<string, { type: CoreFieldType } | undefined>)[field]?.type ===
      type,
  );
  if (model === undefined) throw new Error(`authtempo: no model has the ${type} field ${field}`);
  return columnType(POSTGRES, model, field);
}
