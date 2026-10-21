// The entry `@authtempo/adapter-d1/seam` (plan 12g). It names no Workers type:
// scripts/check-seam-dts.mjs reads the built declarations and fails on one.
export { createD1AdapterOn, type D1AdapterOptions } from "./adapter.js";
export { toStorageError } from "./errors.js";
export { createD1Limiter } from "./limiter.js";
export { schemaVersionCheckOn, schemaVersionPing } from "./schema-version.js";
export type { D1Subset, D1SubsetResult, D1SubsetStatement } from "./seam.js";
