import type { encodeValue } from "@authtempo/core/sql";

/** A core field type, as `schema` names it. */
export type CoreFieldType = Parameters<typeof encodeValue>[1];

/**
 * The Postgres column type of each core field, as `information_schema`
 * names it: the migrations write these, and the parity tests of this package
 * and of the compat package read this one map (plan 9f final fix wave: one
 * source for one fact). `counter` is bigint because the WebAuthn sign count is
 * an unsigned 32-bit value and int32 cannot hold it all. `lastStep` (plan 9f)
 * is bigint because the spec gives a 30-second step counter a 64-bit column,
 * as RFC 6238 does.
 */
export function postgresColumnType(field: string, type: CoreFieldType): string {
  switch (type) {
    case "string":
      return "text";
    case "boolean":
      return "boolean";
    case "date":
      return "timestamp with time zone";
    case "json":
      return "jsonb";
    case "integer":
      return field === "counter" || field === "lastStep" ? "bigint" : "integer";
  }
}
